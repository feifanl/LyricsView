// Overlay bootstrap. Wires SMTC events, the interpolated clock, the karaoke
// renderer, edit mode, per-track offset and global-hotkey actions.
import { activePreset, type HotkeyAction, type Settings } from "../shared/settings";
import { loadSettings } from "../shared/store";
import {
  cmd,
  onHotkey,
  onPlaybackState,
  onReloadLyrics,
  onSettingsChanged,
  onTimeline,
  onTrackChanged,
} from "../shared/ipc";
import type { LyricsDoc, TrackInfo } from "../shared/types";
import { applyPresetVars } from "./apply";
import { configureAutoWidth, requestWidth } from "./autowidth";
import { PlaybackClock } from "./clock";
import { autoStretchPpm } from "./drift";
import { initEditMode } from "./edit";
import { restoreGeometry } from "./geometry";
import { Renderer } from "./renderer";
import { shareCard } from "./share";
import {
  baseLang,
  docLang,
  isRedundantTranslation,
  needsTranslation,
} from "./translation";

const lyricsEl = document.getElementById("lyrics") as HTMLDivElement;
const toastEl = document.getElementById("toast") as HTMLDivElement;

const clock = new PlaybackClock();
const renderer = new Renderer(lyricsEl);
let hasDoc = false;
let currentTrack: TrackInfo | null = null;
let currentDoc: LyricsDoc | null = null;
let globalOffsetMs = 0;
let trackOffsetMs = 0;
// Drift correction (parts-per-million of position) comes in two parts: one
// derived from the duration gap between the playing release and the release the
// lyrics were timed against, and one the user dialled in by hand. They add.
let autoStretchPpmValue = 0;
let userStretchPpm = 0;
let trackKey: string | null = null;
let toastTimer = 0;
let showTranslation = false; // Original vs Translated view
let aiEnabled = false; // allow AI to fill lines with no built-in translation
let targetLang = "en"; // language the user wants lyrics translated INTO
let currentSettings: Settings | null = null;
let autoHideEnabled = true;
let autoHideDelayMs = 5000;
let hideTimer = 0;
let lastTimelinePos = -1;
let loadSeq = 0;
let trackChangedAt = 0; // when the current track started (gates early rendering)
// Empty-state = the box holds only a status note (no lyrics / unsynced only), no
// real lyric content. We show that note briefly, then fade the overlay so it
// isn't a thin empty pill — and, while empty, playback activity must not un-fade
// it back into view.
let emptyState = false;
let emptyHideTimer = 0;
const EMPTY_STATE_HIDE_MS = 4000;

function applyOffsets(): void {
  clock.setUserOffset(globalOffsetMs + trackOffsetMs);
}

// Playback-position → lyric-time mapping. Drift correction rescales position so
// a lyric timeline from a different release can be linearly aligned to the
// audio: lyricTime = rate*audio + offset. rate == 1 (ppm 0) is a no-op.
function stretchPpm(): number {
  return autoStretchPpmValue + userStretchPpm;
}

function estimatePos(now: number): number {
  const rate = 1 + stretchPpm() / 1_000_000;
  const offset = globalOffsetMs + trackOffsetMs;
  return rate * clock.estimate(now) + offset * (1 - rate);
}

function setFaded(faded: boolean): void {
  document.body.classList.toggle("faded", faded);
}

/** Mark the overlay as empty (only a status note showing): reveal it briefly,
 *  then fade after a short beat so an empty pill doesn't linger. */
function startEmptyHide(): void {
  emptyState = true;
  setFaded(false); // show the note first
  window.clearTimeout(emptyHideTimer);
  emptyHideTimer = window.setTimeout(() => {
    if (emptyState) setFaded(true);
  }, EMPTY_STATE_HIDE_MS);
}

/** Show a status note and fade the overlay after a beat (no lyrics / error). */
function enterEmptyState(message: string): void {
  setStatus(message);
  startEmptyHide();
}

/** Leave the empty-state (real lyrics arrived, or the track changed). */
function exitEmptyState(): void {
  emptyState = false;
  window.clearTimeout(emptyHideTimer);
}

function scheduleAutoHide(): void {
  window.clearTimeout(hideTimer);
  if (autoHideEnabled && !clock.isPlaying()) {
    hideTimer = window.setTimeout(() => setFaded(true), autoHideDelayMs);
  }
}

function onPlayingChanged(playing: boolean): void {
  if (emptyState) return; // nothing to show — let the empty-state fade stand
  if (playing) {
    window.clearTimeout(hideTimer);
    setFaded(false);
  } else {
    scheduleAutoHide();
  }
}

/** Current line text + translation, for the share card. */
function currentLineInfo(): { text: string; translation?: string } | null {
  if (!currentDoc || currentDoc.lines.length === 0) return null;
  const pos = estimatePos(Date.now());
  let idx = 0;
  for (let i = 0; i < currentDoc.lines.length; i++) {
    if (currentDoc.lines[i]!.start <= pos) idx = i;
    else break;
  }
  const line = currentDoc.lines[idx]!;
  return line.translation ? { text: line.text, translation: line.translation } : { text: line.text };
}

async function shareCurrentLine(): Promise<void> {
  if (!currentSettings || !currentTrack) return;
  const info = currentLineInfo();
  if (!info) return;
  const p = activePreset(currentSettings);
  try {
    await shareCard({
      title: currentTrack.title,
      artist: currentTrack.artist,
      line: info.text,
      translation: info.translation,
      baseColor: p.colors.base,
      fillColor: p.colors.fill,
      bgColor: p.background === "none" ? "#101015" : p.backgroundColor,
      fontFamily: p.font.family,
    });
    toast("shared line as image");
  } catch (e) {
    console.error("[overlay] share failed", e);
  }
}

/** Whether two settings snapshots place the overlay window identically. */
function sameGeometry(a: Settings | null, b: Settings): boolean {
  if (!a) return false;
  if (a.activePreset !== b.activePreset) return false;
  const pa = activePreset(a);
  const pb = activePreset(b);
  return (
    (pa.dock ?? "float") === (pb.dock ?? "float") &&
    pa.monitor === pb.monitor &&
    pa.size.w === pb.size.w &&
    pa.size.h === pb.size.h &&
    (pa.position?.x ?? null) === (pb.position?.x ?? null) &&
    (pa.position?.y ?? null) === (pb.position?.y ?? null)
  );
}

function applyLayout(settings: Settings): void {
  const p = activePreset(settings);
  renderer.setLayout({
    before: p.contextLines.before,
    after: p.contextLines.after,
    animation: p.animation,
  });
  renderer.setRomanization(settings.romanization);
  renderer.setShowTranslation(settings.translation.show);
  renderer.setLyricLines(settings.lyricLines);
}

const FORM_LABEL: Record<string, string> = {
  romaji: "romaji",
  original: "original",
  translation: "translation",
};

function frame(): void {
  // Hold rendering until the clock has more than the first (often stale) SMTC
  // report to go on — otherwise a fresh track can flash a wrong/late line
  // before the position self-corrects. Fall back after a beat for players that
  // report position sparsely.
  const clockReady = clock.hasSettled() || Date.now() - trackChangedAt > 1500;
  if (hasDoc && clockReady) renderer.render(estimatePos(Date.now()));
  requestAnimationFrame(frame);
}

function toast(text: string): void {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("show"), 1400);
}

// Status (searching / no lyrics / waiting) renders inside the glass box.
function setStatus(text: string): void {
  renderer.setMessage(text);
}

async function loadTrackMeta(): Promise<void> {
  try {
    trackKey = await cmd.currentTrackKey();
    const meta = trackKey ? await cmd.getTrackMeta(trackKey) : null;
    trackOffsetMs = meta?.offsetMs ?? 0;
    userStretchPpm = meta?.stretchPpm ?? 0;
  } catch {
    trackOffsetMs = 0;
    userStretchPpm = 0;
  }
  applyOffsets();
}

async function loadLyrics(t: TrackInfo, force: boolean): Promise<void> {
  const seq = ++loadSeq; // guard against overlapping loads (wrong-song races)
  currentTrack = t;
  hasDoc = false;
  currentDoc = null;
  autoStretchPpmValue = 0; // recomputed once we know which release was timed
  await loadTrackMeta();
  if (seq !== loadSeq) return;
  exitEmptyState(); // a fresh search supersedes any prior empty-state
  setStatus(force ? "reloading…" : "searching lyrics…");
  try {
    const doc = await cmd.fetchLyrics(t, force);
    if (seq !== loadSeq) return; // a newer track superseded this fetch
    if (doc && doc.lines.length > 0) {
      autoStretchPpmValue = autoStretchPpm(t.durationMs, doc.sourceDurationMs);
      gateTranslations(doc); // drop translations that don't match the target language
      currentDoc = doc;
      renderer.setDoc(doc); // replaces the status message
      hasDoc = true;
      void maybeTranslate(doc);
    } else if (doc && doc.plain) {
      // Unsynced lyrics only: nothing to follow, so treat the note as empty-state.
      currentDoc = doc;
      renderer.setDoc(doc); // renders "unsynced lyrics only"
      hasDoc = true;
      startEmptyHide();
    } else {
      enterEmptyState("♪ no lyrics found");
    }
  } catch (e) {
    if (seq !== loadSeq) return;
    console.error("[overlay] fetch_lyrics failed", e);
    enterEmptyState("lyrics error");
  }
}

// Strip translations that would add nothing, line by line: the line is already
// in the target language, or the "translation" restates it. Doing this per line
// rather than per document is what stops an English hook inside a Japanese song
// from carrying an English "translation" of itself. Mutates the doc in place.
function gateTranslations(doc: LyricsDoc): void {
  for (const l of doc.lines) {
    if (isRedundantTranslation(l.text, l.translation, targetLang)) l.translation = undefined;
  }
}

// Prefer built-in (fetched) translations; only call the AI provider to fill
// lines that arrived without one, and only when the user opted into the
// translated view and configured a key.
async function maybeTranslate(doc: LyricsDoc): Promise<void> {
  if (!showTranslation || doc.lines.length === 0) return;
  if (docLang(doc.lines.map((l) => l.text)) === baseLang(targetLang)) return; // cheap early-out
  // Lines already in the target language are skipped outright: asking a
  // translator to render English as English gets the line back verbatim.
  const missing = doc.lines.filter((l) => !l.translation && needsTranslation(l.text, targetLang));
  if (missing.length === 0) return; // built-in translations cover everything
  if (!aiEnabled) return; // no AI fallback configured — show what we have
  try {
    const filled = await cmd.translateLines(missing.map((l) => l.text));
    if (currentDoc !== doc) return;
    // Merge AI results back, keeping every built-in translation as-is. Lines
    // that were skipped above stay blank, and an echoed result is dropped.
    let k = 0;
    const merged = doc.lines.map((l) => {
      if (l.translation) return l.translation;
      if (!needsTranslation(l.text, targetLang)) return "";
      const t = filled[k++] ?? "";
      return isRedundantTranslation(l.text, t, targetLang) ? "" : t;
    });
    renderer.setTranslations(merged);
  } catch (e) {
    console.error("[overlay] translate failed", e);
  }
}

async function persistOffset(): Promise<void> {
  if (trackKey) await cmd.setTrackOffset(trackKey, trackOffsetMs);
}

function nudgeOffset(deltaMs: number): void {
  trackOffsetMs += deltaMs;
  applyOffsets();
  void persistOffset();
  toast(`offset ${trackOffsetMs >= 0 ? "+" : ""}${trackOffsetMs} ms`);
}

const DRIFT_STEP_PPM = 500; // ~0.05% per press ≈ 90 ms over a 3-min song

async function persistStretch(): Promise<void> {
  if (trackKey) await cmd.setTrackStretch(trackKey, userStretchPpm);
}

// Only the manual half is nudged and persisted; the automatic half is re-derived
// on every load. So a nudge trims whatever the duration ratio got wrong rather
// than replacing it, and the toast reports the total actually in effect.
function nudgeDrift(deltaPpm: number): void {
  userStretchPpm += deltaPpm;
  void persistStretch();
  const pct = (stretchPpm() / 10_000).toFixed(2); // 10 000 ppm = 1%
  toast(`drift ${stretchPpm() >= 0 ? "+" : ""}${pct}%`);
}

function jumpLine(dir: -1 | 1): void {
  if (!currentDoc || currentDoc.lines.length === 0) return;
  const pos = estimatePos(Date.now());
  let idx = 0;
  for (let i = 0; i < currentDoc.lines.length; i++) {
    if (currentDoc.lines[i]!.start <= pos) idx = i;
    else break;
  }
  const target = Math.min(currentDoc.lines.length - 1, Math.max(0, idx + dir));
  const targetStart = currentDoc.lines[target]!.start;
  // Shift offset so the chosen line starts "now".
  trackOffsetMs += targetStart - pos;
  applyOffsets();
  void persistOffset();
  toast(dir > 0 ? "→ next line" : "← prev line");
}

function handleHotkey(action: HotkeyAction): void {
  switch (action) {
    case "offsetMinus":
      nudgeOffset(-100);
      break;
    case "offsetPlus":
      nudgeOffset(100);
      break;
    case "driftMinus":
      nudgeDrift(-DRIFT_STEP_PPM);
      break;
    case "driftPlus":
      nudgeDrift(DRIFT_STEP_PPM);
      break;
    case "prevLine":
      jumpLine(-1);
      break;
    case "nextLine":
      jumpLine(1);
      break;
    case "reloadLyrics":
      if (currentTrack) void loadLyrics(currentTrack, true);
      break;
    case "cycleFormPrev":
      cycleForm(-1);
      break;
    case "cycleFormNext":
      cycleForm(1);
      break;
    default:
      break; // toggleOverlay / toggleEditMode handled in Rust
  }
}

// Single-line layout: hop between romaji / original / translation.
function cycleForm(dir: 1 | -1): void {
  const form = renderer.cycleForm(dir);
  if (form) toast(FORM_LABEL[form] ?? form);
  else toast("single-line layout only");
}

async function boot(): Promise<void> {
  const settings = await loadSettings();
  currentSettings = settings;
  globalOffsetMs = settings.globalOffsetMs;
  showTranslation = settings.translation.show;
  aiEnabled = settings.translation.enabled;
  targetLang = settings.translation.targetLang;
  autoHideEnabled = settings.autoHide.enabled;
  autoHideDelayMs = settings.autoHide.delaySec * 1000;
  applyOffsets();
  applyPresetVars(settings);
  applyLayout(settings);
  initEditMode();
  renderer.onFit = requestWidth;
  void restoreGeometry(activePreset(settings)).then(() => configureAutoWidth(settings));

  document.getElementById("overlay-root")?.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    void shareCurrentLine();
  });

  await onTrackChanged((t) => {
    exitEmptyState(); // new song: clear any lingering empty-state fade
    setFaded(false); // a new track means we're active
    clock.reset(); // don't carry the previous song's position/anchor
    lastTimelinePos = -1;
    trackChangedAt = Date.now();
    void loadLyrics(t, false);
  });
  await onPlaybackState((p) => {
    clock.setPlaying(p.playing, Date.now());
    onPlayingChanged(p.playing);
  });
  await onTimeline((t) => {
    clock.update(t, Date.now());
    // Advancing timeline = active playback: keep the overlay visible even if
    // the player's playback-state event is unreliable (browsers). Skip while
    // empty — an empty pill shouldn't pop back up just because the song plays on.
    if (!emptyState && t.positionMs > lastTimelinePos && t.positionMs - lastTimelinePos < 5000) {
      window.clearTimeout(hideTimer);
      setFaded(false);
    }
    lastTimelinePos = t.positionMs;
  });
  await onHotkey(handleHotkey);
  await onReloadLyrics(() => {
    // Force: a manual reload must bypass the cache, otherwise it can never
    // upgrade a cached line-level doc to a word-level one.
    if (currentTrack) void loadLyrics(currentTrack, true);
  });
  await onSettingsChanged((s) => {
    const geometryChanged = !sameGeometry(currentSettings, s);
    currentSettings = s;
    globalOffsetMs = s.globalOffsetMs;
    showTranslation = s.translation.show;
    aiEnabled = s.translation.enabled;
    const langChanged = targetLang !== s.translation.targetLang;
    targetLang = s.translation.targetLang;
    autoHideEnabled = s.autoHide.enabled;
    autoHideDelayMs = s.autoHide.delaySec * 1000;
    if (!autoHideEnabled && !emptyState) setFaded(false);
    applyOffsets();
    applyPresetVars(s);
    applyLayout(s);
    // Re-dock / re-place only when the geometry itself changed. Doing it on
    // every broadcast fought the user: each keystroke in the settings window
    // snapped the overlay back to the preset's saved rectangle, undoing a drag
    // and re-triggering the auto-width resize loop.
    if (geometryChanged) {
      void restoreGeometry(activePreset(s)).then(() => configureAutoWidth(s));
    }
    // Target-language change re-gates translations from a fresh (cached) fetch:
    // gating strips them destructively, so we can't restore from currentDoc.
    if (langChanged && currentTrack) void loadLyrics(currentTrack, false);
    else if (showTranslation && currentDoc) void maybeTranslate(currentDoc);
  });

  // Seed from whatever is already playing. The Rust watcher emits the initial
  // track during app setup — before these listeners exist — and then dedupes,
  // so without this pull the overlay would sit on "waiting" until the next song.
  // The watcher thread may still be initializing at boot, so retry briefly; if
  // onTrackChanged fires first, currentTrack guards against a double load.
  setStatus("waiting for a player…");
  void seedCurrentTrack();
  requestAnimationFrame(frame);
}

async function seedCurrentTrack(): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    if (currentTrack) return; // a real track-changed event already seeded us
    try {
      const existing = await cmd.currentTrack();
      if (existing) {
        setFaded(false);
        clock.reset();
        lastTimelinePos = -1;
        trackChangedAt = Date.now();
        void loadLyrics(existing, false);
        return;
      }
    } catch {
      // watcher not ready yet — fall through to retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

void boot();
