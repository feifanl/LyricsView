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
import { initEditMode } from "./edit";
import { restoreGeometry } from "./geometry";
import { Renderer } from "./renderer";
import { detectScript } from "./romanize";
import { shareCard } from "./share";

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

function scheduleAutoHide(): void {
  window.clearTimeout(hideTimer);
  if (autoHideEnabled && !clock.isPlaying()) {
    hideTimer = window.setTimeout(() => setFaded(true), autoHideDelayMs);
  }
}

function onPlayingChanged(playing: boolean): void {
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

function applyLayout(settings: Settings): void {
  const p = activePreset(settings);
  renderer.setLayout({
    before: p.contextLines.before,
    after: p.contextLines.after,
    animation: p.animation,
  });
  renderer.setRomanization(settings.romanization);
  renderer.setShowTranslation(settings.translation.show);
}

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
  setStatus(force ? "reloading…" : "searching lyrics…");
  try {
    const doc = await cmd.fetchLyrics(t, force);
    if (seq !== loadSeq) return; // a newer track superseded this fetch
    if (doc && (doc.lines.length > 0 || doc.plain)) {
      gateTranslations(doc); // drop translations that don't match the target language
      currentDoc = doc;
      renderer.setDoc(doc); // replaces the status message
      hasDoc = true;
      void maybeTranslate(doc);
    } else {
      setStatus("♪ no lyrics found");
    }
  } catch (e) {
    if (seq !== loadSeq) return;
    console.error("[overlay] fetch_lyrics failed", e);
    setStatus("lyrics error");
  }
}

// A translation only makes sense when the original isn't already in the user's
// target language. Detect the language of a piece of text via its script;
// Latin script is assumed to be the (Latin-alphabet) target, so it collapses to
// the target's base code — good enough to stop e.g. a Chinese tlyric showing
// under an English song.
function langOf(text: string): string {
  const s = detectScript(text); // ja | zh | ko | ru | other
  return s === "other" ? "latin" : s;
}

function baseLang(code: string): string {
  const base = code.toLowerCase().split(/[-_]/)[0] ?? code.toLowerCase();
  // Latin-script languages (en, es, fr, de, …) all read as "latin" from script
  // detection, so map the target's code into that bucket to compare like-for-like.
  return /^(en|es|fr|de|it|pt|nl|id|ms|vi|tr|pl)$/.test(base) ? "latin" : base;
}

/** Dominant original language across the doc's non-empty lines. */
function docLang(doc: LyricsDoc): string {
  const counts = new Map<string, number>();
  for (const l of doc.lines) {
    const t = l.text.trim();
    if (!t) continue;
    const lang = langOf(t);
    counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  let best = "latin";
  let max = 0;
  for (const [lang, n] of counts) {
    if (n > max) {
      max = n;
      best = lang;
    }
  }
  return best;
}

// Strip translations that shouldn't be shown: none when the original is already
// in the target language, and any bundled translation whose own language isn't
// the target (providers like NetEase always bundle a Chinese tlyric, which is
// noise for an English-target English song). Mutates the doc in place.
function gateTranslations(doc: LyricsDoc): void {
  const tgt = baseLang(targetLang);
  if (docLang(doc) === tgt) {
    for (const l of doc.lines) l.translation = undefined;
    return;
  }
  for (const l of doc.lines) {
    if (l.translation && baseLang(langOf(l.translation)) !== tgt) {
      l.translation = undefined;
    }
  }
}

// Prefer built-in (fetched) translations; only call the AI provider to fill
// lines that arrived without one, and only when the user opted into the
// translated view and configured a key.
async function maybeTranslate(doc: LyricsDoc): Promise<void> {
  if (!showTranslation || doc.lines.length === 0) return;
  if (docLang(doc) === baseLang(targetLang)) return; // original already in target
  const missing = doc.lines.filter((l) => !l.translation);
  if (missing.length === 0) return; // built-in translations cover everything
  if (!aiEnabled) return; // no AI fallback configured — show what we have
  try {
    const filled = await cmd.translateLines(missing.map((l) => l.text));
    if (currentDoc !== doc) return;
    // Merge AI results back, keeping every built-in translation as-is.
    let k = 0;
    const merged = doc.lines.map((l) => l.translation ?? filled[k++] ?? "");
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
  if (trackKey) await cmd.setTrackStretch(trackKey, trackStretchPpm);
}

function nudgeDrift(deltaPpm: number): void {
  trackStretchPpm += deltaPpm;
  void persistStretch();
  const pct = (trackStretchPpm / 10_000).toFixed(2); // 10 000 ppm = 1%
  toast(`drift ${trackStretchPpm >= 0 ? "+" : ""}${pct}%`);
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
    default:
      break; // toggleOverlay / toggleEditMode handled in Rust
  }
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
    // the player's playback-state event is unreliable (browsers).
    if (t.positionMs > lastTimelinePos && t.positionMs - lastTimelinePos < 5000) {
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
    currentSettings = s;
    globalOffsetMs = s.globalOffsetMs;
    showTranslation = s.translation.show;
    aiEnabled = s.translation.enabled;
    const langChanged = targetLang !== s.translation.targetLang;
    targetLang = s.translation.targetLang;
    autoHideEnabled = s.autoHide.enabled;
    autoHideDelayMs = s.autoHide.delaySec * 1000;
    if (!autoHideEnabled) setFaded(false);
    applyOffsets();
    applyPresetVars(s);
    applyLayout(s);
    // Re-dock / re-place live when the preset or dock mode changes.
    void restoreGeometry(activePreset(s)).then(() => configureAutoWidth(s));
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
