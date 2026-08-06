// Overlay bootstrap. Wires SMTC events, the interpolated clock, the karaoke
// renderer, edit mode, per-track offset and global-hotkey actions.
import { activePreset, type HotkeyAction, type Settings } from "../shared/settings";
import { loadSettings, saveSettings } from "../shared/store";
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
import {
  MIN_SPREAD_MS,
  type SyncMark,
  clampStretch,
  fit,
  spreadMs,
  worstResidualMs,
} from "./calibrate";
import { PlaybackClock } from "./clock";
// Sync diagnostic. Dev-only: every call site sits behind `import.meta.env.DEV`,
// which Vite replaces with a literal `false` in a production build, so the whole
// module is tree-shaken out and `window.__diag` never reaches users.
import * as diag from "./diag";
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
let trackStretchPpm = 0; // per-track drift correction (parts-per-million)
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
function estimatePos(now: number): number {
  const rate = 1 + trackStretchPpm / 1_000_000;
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
    // Reserving desktop space is applied by restoreGeometry, so a change here
    // has to count as a geometry change or toggling it does nothing at all.
    (pa.reserveSpace ?? false) === (pb.reserveSpace ?? false) &&
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
// `null` empties it, which drops the pill entirely rather than leaving a blank one.
function setStatus(text: string | null): void {
  renderer.setMessage(text);
}

/** Don't announce a fetch that a cache hit is about to answer. Most track
 *  changes resolve in well under this, and showing "searching" for 80 ms just
 *  pops an empty-looking pill on screen between every song. */
const STATUS_DELAY_MS = 700;
let statusDelayTimer = 0;

function scheduleStatus(text: string, seq: number): void {
  window.clearTimeout(statusDelayTimer);
  statusDelayTimer = window.setTimeout(() => {
    if (seq === loadSeq && !hasDoc) setStatus(text);
  }, STATUS_DELAY_MS);
}

function cancelScheduledStatus(): void {
  window.clearTimeout(statusDelayTimer);
}

async function loadTrackMeta(): Promise<void> {
  try {
    trackKey = await cmd.currentTrackKey();
    const meta = trackKey ? await cmd.getTrackMeta(trackKey) : null;
    trackOffsetMs = meta?.offsetMs ?? 0;
    trackStretchPpm = meta?.stretchPpm ?? 0;
  } catch {
    trackOffsetMs = 0;
    trackStretchPpm = 0;
  }
  applyOffsets();
}

async function loadLyrics(t: TrackInfo, force: boolean): Promise<void> {
  const seq = ++loadSeq; // guard against overlapping loads (wrong-song races)
  currentTrack = t;
  hasDoc = false;
  currentDoc = null;
  await loadTrackMeta();
  if (seq !== loadSeq) return;
  exitEmptyState(); // a fresh search supersedes any prior empty-state
  // Clear first: the previous song's line must not sit under a new track. A
  // reload is user-initiated, so that one says so immediately; an ordinary track
  // change stays blank until the fetch is slow enough to be worth mentioning.
  setStatus(null);
  if (force) setStatus("reloading…");
  else scheduleStatus("searching lyrics…", seq);
  try {
    const doc = await cmd.fetchLyrics(t, force);
    if (seq !== loadSeq) return; // a newer track superseded this fetch
    cancelScheduledStatus();
    if (doc && doc.lines.length > 0) {
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
    cancelScheduledStatus();
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
  if (!aiEnabled) {
    // Nothing can fill these lines: no key, and whichever providers are on
    // carry no usable translation. Say so once, rather than leaving a blank
    // that reads as the feature being broken.
    void hintTranslationSource();
    return;
  }
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

/**
 * Tell the user once that the translated line needs a source they have not
 * turned on.
 *
 * Musixmatch is the only enabled-by-nothing provider that carries translations
 * in languages other than Chinese, and it ships disabled. Without this note the
 * symptom is a permanently blank translation line and no clue why — the state
 * this app was in when its own author could not work out what had broken.
 */
async function hintTranslationSource(): Promise<void> {
  if (!currentSettings || currentSettings.translationHintShown) return;
  if (currentSettings.providersEnabled.musixmatch) return; // already on; nothing to suggest
  currentSettings.translationHintShown = true; // set first: this must fire once, not per song
  toast("no translation for this song — enable Musixmatch in Settings → Providers");
  try {
    const s = await loadSettings();
    s.translationHintShown = true;
    await saveSettings(s);
  } catch (e) {
    console.error("[overlay] could not persist translation hint", e);
  }
}

// Corrections are written on a timer rather than per keypress: a held hotkey
// fires tens of times a second, and each write is an IPC round trip plus a file
// rewrite. The last value within the window is the one that matters.
const PERSIST_DEBOUNCE_MS = 500;
let persistTimer = 0;

function schedulePersist(): void {
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    if (!trackKey) return;
    void cmd.setTrackOffset(trackKey, trackOffsetMs);
    void cmd.setTrackStretch(trackKey, trackStretchPpm);
  }, PERSIST_DEBOUNCE_MS);
}

function nudgeOffset(deltaMs: number): void {
  trackOffsetMs += deltaMs;
  applyOffsets();
  schedulePersist();
  toast(`offset ${trackOffsetMs >= 0 ? "+" : ""}${trackOffsetMs} ms`);
}

/** Per-press drift step. Sized against what actually goes wrong: a lyric file
 *  timed to a different release is typically off by 1–4%, so a 0.05% step needed
 *  20–80 presses to converge and nobody would sit through that. At 0.25% the
 *  same correction is 4–16 presses, still fine enough not to overshoot. */
const DRIFT_STEP_PPM = 2500;

function nudgeDrift(deltaPpm: number): void {
  const next = clampStretch(trackStretchPpm + deltaPpm);
  if (next === trackStretchPpm) {
    toast(`drift at limit ${(next / 10_000).toFixed(2)}%`);
    return;
  }
  trackStretchPpm = next;
  schedulePersist();
  const pct = (trackStretchPpm / 10_000).toFixed(2); // 10 000 ppm = 1%
  toast(`drift ${trackStretchPpm >= 0 ? "+" : ""}${pct}%`);
}

// --- Two-point sync calibration (see calibrate.ts) -------------------------

/** Marks for the current track. Cleared on track change and on reset. */
let syncMarks: SyncMark[] = [];

/** Raw playback position, before offset and stretch — the frame marks live in,
 *  so earlier marks stay valid as the correction changes under them. */
function rawPos(): number {
  return clock.estimate(Date.now()) - clock.getUserOffset();
}

/**
 * Tap once as a line begins. The line currently on screen is taken as the one
 * the user means, so a badly misaligned track wants a line jump first to get
 * onto the right line. One mark shifts the offset; a second, far enough away,
 * also solves the rate.
 */
function markSync(): void {
  if (!currentDoc || currentDoc.lines.length === 0) {
    toast("no lyrics to sync");
    return;
  }
  const pos = estimatePos(Date.now());
  let idx = 0;
  for (let i = 0; i < currentDoc.lines.length; i++) {
    if (currentDoc.lines[i]!.start <= pos) idx = i;
    else break;
  }
  syncMarks.push({ rawMs: rawPos(), truthMs: currentDoc.lines[idx]!.start });

  const c = fit(syncMarks, trackStretchPpm);
  if (!c) return;
  trackStretchPpm = c.stretchPpm;
  trackOffsetMs = c.offsetMs - globalOffsetMs;
  applyOffsets();
  schedulePersist();

  if (syncMarks.length === 1) {
    toast("sync 1 — tap again later in the song");
    return;
  }
  if (spreadMs(syncMarks) < MIN_SPREAD_MS) {
    toast(`sync ${syncMarks.length} — offset only, tap further apart for drift`);
    return;
  }
  // A mark far off the fitted line means one tap did not describe the same
  // straight relationship as the others — a missed pause, or the wrong line.
  const worst = worstResidualMs(syncMarks, c);
  const pct = (c.stretchPpm / 10_000).toFixed(2);
  toast(
    worst > 1500
      ? `sync ${syncMarks.length} — marks disagree, retap`
      : `synced: drift ${c.stretchPpm >= 0 ? "+" : ""}${pct}%, offset ${c.offsetMs} ms`,
  );
}

/** Throw away every correction for this track and start clean. */
function resetSync(): void {
  syncMarks = [];
  trackOffsetMs = 0;
  trackStretchPpm = 0;
  applyOffsets();
  schedulePersist();
  toast("sync reset");
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
  schedulePersist();
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
    case "syncMark":
      markSync();
      break;
    case "resetSync":
      resetSync();
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

  if (import.meta.env.DEV) {
    diag.install({
      rawPos: () => clock.estimate(Date.now()) - clock.getUserOffset(),
      renderPos: () => estimatePos(Date.now()),
      lines: () => currentDoc?.lines.map((l) => ({ start: l.start, text: l.text })) ?? [],
      applyCorrection: (stretchPpm, offsetMs) => {
        trackStretchPpm = stretchPpm;
        trackOffsetMs = offsetMs - globalOffsetMs;
        applyOffsets();
        schedulePersist();
        toast(`drift ${(stretchPpm / 10_000).toFixed(2)}% / offset ${trackOffsetMs} ms`);
      },
    });
  }

  document.getElementById("overlay-root")?.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    void shareCurrentLine();
  });

  await onTrackChanged((t) => {
    exitEmptyState(); // new song: clear any lingering empty-state fade
    setFaded(false); // a new track means we're active
    clock.reset(); // don't carry the previous song's position/anchor
    cancelScheduledStatus(); // a pending note from the last song is stale now
    syncMarks = []; // marks describe one song's timeline, never the next one's
    if (import.meta.env.DEV) diag.reset();
    lastTimelinePos = -1;
    trackChangedAt = Date.now();
    void loadLyrics(t, false);
  });
  await onPlaybackState((p) => {
    if (import.meta.env.DEV) diag.notePlaying(p.playing);
    clock.setPlaying(p.playing, Date.now());
    onPlayingChanged(p.playing);
  });
  await onTimeline((t) => {
    // Before clock.update, while the report is still untouched ground truth.
    if (import.meta.env.DEV) diag.noteReport(t.positionMs, t.reportedAtMs, t.rate);
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
  // Fades on the empty-state timer like every other note. It used to sit there
  // forever, which is the worst case: a pill parked on screen precisely when
  // there is nothing to show.
  enterEmptyState("waiting for a player…");
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
        syncMarks = [];
        lastTimelinePos = -1;
        trackChangedAt = Date.now();
        // The clock starts paused and only learns otherwise from a playback-state
        // event. Those are deduped, and the initial one fired before this webview
        // existed — so ask for it again, or a song already playing at launch
        // leaves the clock frozen at whatever position the first report carried.
        void cmd.resyncPlaybackState();
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
