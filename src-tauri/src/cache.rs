// Persistent per-track lyrics cache: one JSON file per track under
// `app_data_dir()/lyrics/`, keyed by `normalize::track_key`.
//
// An entry holds every `LyricsDoc` fetched for the track (one per source), the
// user's preferred source, a per-track offset and a per-track translation cache.
// Cache-first on track change; the network is hit only on a miss or an explicit
// reload (which bypasses and refreshes the cache).
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::lyrics::{doc_score, LyricsDoc, SourceId};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheEntry {
    pub track_key: String,
    /// One document per source that has been fetched.
    #[serde(default)]
    pub docs: HashMap<SourceId, LyricsDoc>,
    #[serde(default)]
    pub preferred_source: Option<SourceId>,
    #[serde(default)]
    pub offset_ms: i64,
    /// Per-track drift correction in parts-per-million of playback position
    /// (0 = none). Corrects lyric timelines from a different release/version.
    #[serde(default)]
    pub stretch_ppm: i64,
    /// Translation cache keyed by target language.
    #[serde(default)]
    pub translations: HashMap<String, Vec<String>>,
    /// The provider config that produced `docs` (see `Cache::fetch_fingerprint`).
    ///
    /// A cache hit is only as good as the settings in force when it was written.
    /// Turning on a provider that carries translations does nothing for tracks
    /// already cached — the entry is a hit, the network is never consulted, and
    /// the new provider may as well still be off. Empty on entries written
    /// before this field existed, which reads as "unknown config" and triggers
    /// exactly one refresh.
    #[serde(default)]
    pub fetch_fingerprint: String,
}

impl CacheEntry {
    fn new(track_key: &str) -> Self {
        Self {
            track_key: track_key.to_string(),
            ..Default::default()
        }
    }

    /// Best cached document: the preferred source if present, else the richest
    /// available, ranked exactly as the live provider race ranks its candidates
    /// (see `lyrics::doc_score`).
    ///
    /// `want_lang` is the user's target language reduced by `base_lang`, or
    /// `None` when translations are hidden. It must reflect the *current*
    /// setting — the ranking is not a property of the cache, and an entry
    /// written while translations were on must not outvote them being off.
    pub fn best_doc(&self, want_lang: Option<&str>) -> Option<LyricsDoc> {
        let mut best = if let Some(doc) = self.preferred_source.and_then(|p| self.docs.get(&p)) {
            doc.clone()
        } else {
            self.docs
                .values()
                .max_by_key(|d| doc_score(d, want_lang))
                .cloned()?
        };
        if let Some(lang) = want_lang {
            if !best.has_translation_in(lang) {
                self.graft_translations(&mut best, lang);
            }
        }
        Some(best)
    }

    /// Copy translations onto `doc` from whichever other cached document has the
    /// most of them.
    ///
    /// Scoring has to rank word timing above a translation — losing the karaoke
    /// fill to gain a subtitle is a bad trade, and one the user never asked for.
    /// But the two qualities live in different documents often enough that
    /// picking one document means routinely going without the other. They are
    /// independent, so take both: the winner keeps its timing and borrows the
    /// lines.
    ///
    /// Alignment is the risk. Providers disagree on line counts (blank lines,
    /// credits, repeated choruses) and on timing when they hold different
    /// masters — the same mismatch that makes lyrics drift. So this is
    /// deliberately timid: it aligns by index only when the counts agree
    /// exactly, otherwise by nearest start within a tolerance, and abandons the
    /// whole graft unless most lines find a partner. A translation under the
    /// wrong line is worse than none.
    fn graft_translations(&self, doc: &mut LyricsDoc, lang: &str) {
        const TOLERANCE_MS: u64 = 1_500;
        const MIN_MATCH_RATIO: f64 = 0.6;

        // Only a donor whose translations are in the target language. Grafting
        // Chinese onto a Korean song for an English reader would be discarded by
        // the overlay anyway, after costing us the pick.
        let Some(donor) = self
            .docs
            .values()
            .filter(|d| d.source != doc.source && d.has_translation_in(lang))
            .max_by_key(|d| d.lines.iter().filter(|l| l.translation.is_some()).count())
        else {
            return;
        };
        if doc.lines.is_empty() {
            return;
        }

        let same_count = donor.lines.len() == doc.lines.len();
        let mut taken: Vec<Option<String>> = Vec::with_capacity(doc.lines.len());
        let mut matched = 0usize;
        for (i, line) in doc.lines.iter().enumerate() {
            let candidate = if same_count {
                donor.lines[i].translation.clone()
            } else {
                donor
                    .lines
                    .iter()
                    .filter(|d| d.start.abs_diff(line.start) <= TOLERANCE_MS)
                    .min_by_key(|d| d.start.abs_diff(line.start))
                    .and_then(|d| d.translation.clone())
            };
            if candidate.is_some() {
                matched += 1;
            }
            taken.push(candidate);
        }

        // Count against the lines that could carry one — a doc padded with blank
        // lines shouldn't fail the ratio on lines nobody would translate anyway.
        let translatable = doc.lines.iter().filter(|l| !l.text.trim().is_empty()).count();
        if translatable == 0 || (matched as f64) < MIN_MATCH_RATIO * translatable as f64 {
            return;
        }
        for (line, t) in doc.lines.iter_mut().zip(taken) {
            line.translation = t;
        }
    }
}

pub struct Cache<'a, R: Runtime> {
    app: &'a AppHandle<R>,
}

impl<'a, R: Runtime> Cache<'a, R> {
    pub fn new(app: &'a AppHandle<R>) -> Self {
        Self { app }
    }

    fn dir(&self) -> Option<PathBuf> {
        let dir = self.app.path().app_data_dir().ok()?.join("lyrics");
        fs::create_dir_all(&dir).ok()?;
        Some(dir)
    }

    fn path(&self, key: &str) -> Option<PathBuf> {
        Some(self.dir()?.join(format!("{key}.json")))
    }

    pub fn load(&self, key: &str) -> Option<CacheEntry> {
        let path = self.path(key)?;
        let bytes = fs::read(path).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    pub fn save(&self, entry: &CacheEntry) -> std::io::Result<()> {
        let path = self
            .path(&entry.track_key)
            .ok_or_else(|| std::io::Error::other("no cache dir"))?;
        let json = serde_json::to_vec_pretty(entry)?;
        fs::write(path, json)
    }

    /// Load an entry or create a fresh one.
    pub fn load_or_new(&self, key: &str) -> CacheEntry {
        self.load(key).unwrap_or_else(|| CacheEntry::new(key))
    }

    /// Insert/replace a fetched document and persist. `fingerprint` records the
    /// provider config the fetch ran under; pass `None` for documents that don't
    /// come from the provider race (manual paste, an explicit source pick), so
    /// they never claim to represent a config they were not fetched under.
    pub fn store_doc(&self, key: &str, doc: &LyricsDoc, fingerprint: Option<&str>) {
        self.store_docs(key, std::slice::from_ref(doc), fingerprint);
    }

    /// Insert/replace several documents in one read-modify-write. A fetch yields
    /// one document per provider, and writing them one at a time would reload
    /// and re-serialize the whole entry for each.
    pub fn store_docs(&self, key: &str, docs: &[LyricsDoc], fingerprint: Option<&str>) {
        let mut entry = self.load_or_new(key);
        for doc in docs {
            entry.docs.insert(doc.source, doc.clone());
        }
        if let Some(fp) = fingerprint {
            entry.fetch_fingerprint = fp.to_string();
        }
        if let Err(e) = self.save(&entry) {
            eprintln!("[cache] failed to save {key}: {e}");
        }
    }

    pub fn set_preferred(&self, key: &str, source: SourceId) {
        let mut entry = self.load_or_new(key);
        entry.preferred_source = Some(source);
        let _ = self.save(&entry);
    }

    pub fn set_offset(&self, key: &str, offset_ms: i64) {
        let mut entry = self.load_or_new(key);
        entry.offset_ms = offset_ms;
        let _ = self.save(&entry);
    }

    pub fn set_stretch(&self, key: &str, stretch_ppm: i64) {
        let mut entry = self.load_or_new(key);
        entry.stretch_ppm = stretch_ppm;
        let _ = self.save(&entry);
    }

    pub fn cached_translation(&self, key: &str, lang: &str) -> Option<Vec<String>> {
        self.load(key)?.translations.get(lang).cloned()
    }

    pub fn set_translation(&self, key: &str, lang: &str, lines: Vec<String>) {
        let mut entry = self.load_or_new(key);
        entry.translations.insert(lang.to_string(), lines);
        let _ = self.save(&entry);
    }

    pub fn info(&self) -> (u64, u64) {
        let Some(dir) = self.dir() else {
            return (0, 0);
        };
        let mut entries = 0u64;
        let mut bytes = 0u64;
        if let Ok(read) = fs::read_dir(dir) {
            for e in read.flatten() {
                if e.path().extension().and_then(|s| s.to_str()) == Some("json") {
                    entries += 1;
                    bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
                }
            }
        }
        (entries, bytes)
    }

    pub fn clear(&self) {
        if let Some(dir) = self.dir() {
            if let Ok(read) = fs::read_dir(dir) {
                for e in read.flatten() {
                    if e.path().extension().and_then(|s| s.to_str()) == Some("json") {
                        let _ = fs::remove_file(e.path());
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lyrics::LyricLine;

    fn doc(source: SourceId, word: bool) -> LyricsDoc {
        LyricsDoc {
            source,
            track_key: "k".into(),
            lines: vec![LyricLine::new(0, 1000, "hi".into())],
            plain: None,
            has_word_timing: word,
        }
    }

    fn translated(source: SourceId, word: bool) -> LyricsDoc {
        let mut d = doc(source, word);
        d.lines[0].translation = Some("hello".into());
        d
    }

    #[test]
    fn entry_roundtrips_with_sourceid_map_keys() {
        let mut entry = CacheEntry::new("k");
        entry.docs.insert(SourceId::Lrclib, doc(SourceId::Lrclib, false));
        entry.docs.insert(SourceId::Netease, doc(SourceId::Netease, true));
        entry.preferred_source = Some(SourceId::Netease);
        entry.offset_ms = -200;

        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"lrclib\""));
        let back: CacheEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(back.docs.len(), 2);
        assert_eq!(back.preferred_source, Some(SourceId::Netease));
        assert_eq!(back.offset_ms, -200);
    }

    #[test]
    fn best_doc_prefers_word_level_then_preferred() {
        let mut entry = CacheEntry::new("k");
        entry.docs.insert(SourceId::Lrclib, doc(SourceId::Lrclib, false));
        entry.docs.insert(SourceId::Musixmatch, doc(SourceId::Musixmatch, true));
        // No preference: richest (word-level) wins.
        assert_eq!(entry.best_doc(None).unwrap().source, SourceId::Musixmatch);
        // Explicit preference wins even if line-level.
        entry.preferred_source = Some(SourceId::Lrclib);
        assert_eq!(entry.best_doc(None).unwrap().source, SourceId::Lrclib);
    }

    #[test]
    fn best_doc_breaks_a_timing_tie_on_translation() {
        // The regression this guards: the cache used to rank on timing alone, so
        // a track with docs from two providers kept re-picking the untranslated
        // one on every play, and only a forced reload (which re-ran the network
        // race, whose ranking did count translations) showed the translated line.
        let mut entry = CacheEntry::new("k");
        entry.docs.insert(SourceId::Lrclib, doc(SourceId::Lrclib, false));
        entry
            .docs
            .insert(SourceId::Netease, translated(SourceId::Netease, false));
        assert_eq!(entry.best_doc(Some("latin")).unwrap().source, SourceId::Netease);
        // Not asserted for want_trans = false: both docs score 2 there, and
        // which of an equal pair wins is HashMap iteration order.
    }

    #[test]
    fn word_timing_still_outranks_a_translation() {
        let mut entry = CacheEntry::new("k");
        entry
            .docs
            .insert(SourceId::Lrclib, doc(SourceId::Lrclib, true));
        entry
            .docs
            .insert(SourceId::Netease, translated(SourceId::Netease, false));
        assert_eq!(entry.best_doc(Some("latin")).unwrap().source, SourceId::Lrclib);
    }

    /// n lines at 1s intervals, optionally translated.
    fn doc_n(source: SourceId, word: bool, n: u64, trans: bool, shift: u64) -> LyricsDoc {
        let mut d = doc(source, word);
        d.lines = (0..n)
            .map(|i| {
                let mut l = LyricLine::new(i * 1000 + shift, i * 1000 + 900 + shift, format!("line {i}"));
                if trans {
                    l.translation = Some(format!("trans {i}"));
                }
                l
            })
            .collect();
        d
    }

    #[test]
    fn word_level_doc_borrows_translations_from_a_line_level_one() {
        // The point of the graft: keep the karaoke timing AND get the subtitle,
        // rather than having to rank one quality above the other.
        let mut entry = CacheEntry::new("k");
        entry
            .docs
            .insert(SourceId::Lrclib, doc_n(SourceId::Lrclib, true, 5, false, 0));
        entry
            .docs
            .insert(SourceId::Netease, doc_n(SourceId::Netease, false, 5, true, 0));
        let best = entry.best_doc(Some("latin")).unwrap();
        assert_eq!(best.source, SourceId::Lrclib);
        assert!(best.has_word_timing);
        assert_eq!(best.lines[3].translation.as_deref(), Some("trans 3"));
    }

    #[test]
    fn graft_aligns_by_time_when_line_counts_differ() {
        let mut entry = CacheEntry::new("k");
        let mut base = doc_n(SourceId::Lrclib, true, 5, false, 0);
        base.lines.push(LyricLine::new(9_000, 9_900, "extra".into()));
        entry.docs.insert(SourceId::Lrclib, base);
        // Donor is offset slightly but within tolerance, and has no partner for
        // the trailing line.
        entry.docs.insert(
            SourceId::Netease,
            doc_n(SourceId::Netease, false, 5, true, 200),
        );
        let best = entry.best_doc(Some("latin")).unwrap();
        assert_eq!(best.lines[2].translation.as_deref(), Some("trans 2"));
        assert_eq!(best.lines[5].translation, None);
    }

    #[test]
    fn equal_line_counts_align_by_index_whatever_the_timings_say() {
        // Same line count means the same lyric sequence, so index alignment
        // holds even when the two documents come from masters a minute apart —
        // the translations ride the base document's timestamps, and the donor's
        // are discarded. Index is the *more* reliable signal here: it is exactly
        // the drift case where matching on time would find no partner at all.
        let mut entry = CacheEntry::new("k");
        entry
            .docs
            .insert(SourceId::Lrclib, doc_n(SourceId::Lrclib, true, 5, false, 0));
        entry.docs.insert(
            SourceId::Netease,
            doc_n(SourceId::Netease, false, 5, true, 60_000),
        );
        let best = entry.best_doc(Some("latin")).unwrap();
        assert_eq!(best.source, SourceId::Lrclib);
        assert_eq!(best.lines[2].translation.as_deref(), Some("trans 2"));
        assert_eq!(best.lines[2].start, 2_000); // donor timings not adopted
    }

    #[test]
    fn graft_is_abandoned_when_too_few_lines_find_a_partner() {
        // Different line counts *and* timings far apart: nothing can be aligned
        // with confidence, and a translation under the wrong line is worse than
        // no translation at all.
        let mut entry = CacheEntry::new("k");
        entry
            .docs
            .insert(SourceId::Lrclib, doc_n(SourceId::Lrclib, true, 6, false, 0));
        entry.docs.insert(
            SourceId::Netease,
            doc_n(SourceId::Netease, false, 5, true, 60_000),
        );
        let best = entry.best_doc(Some("latin")).unwrap();
        assert_eq!(best.source, SourceId::Lrclib);
        assert!(best.lines.iter().all(|l| l.translation.is_none()));
    }

    #[test]
    fn graft_does_not_run_when_translations_are_hidden() {
        let mut entry = CacheEntry::new("k");
        entry
            .docs
            .insert(SourceId::Lrclib, doc_n(SourceId::Lrclib, true, 5, false, 0));
        entry
            .docs
            .insert(SourceId::Netease, doc_n(SourceId::Netease, false, 5, true, 0));
        let best = entry.best_doc(None).unwrap();
        assert!(best.lines.iter().all(|l| l.translation.is_none()));
    }

    #[test]
    fn a_translation_in_the_wrong_language_does_not_win_the_pick() {
        // The case that made this real: NetEase bundles *Chinese* translations
        // with Korean songs. For an English reader the overlay discards every
        // one, so counting them here picked the NetEase document over a longer
        // LRCLIB one and then showed no translated line — worse on both counts.
        let mut entry = CacheEntry::new("k");
        let mut lrclib = doc_n(SourceId::Lrclib, true, 8, false, 0);
        for (i, l) in lrclib.lines.iter_mut().enumerate() {
            l.text = format!("빨간 예쁜 입술로 {i}");
        }
        let mut netease = doc_n(SourceId::Netease, false, 5, true, 0);
        for l in netease.lines.iter_mut() {
            l.text = "빨간 예쁜 입술로".into();
            l.translation = Some("用你好看的红色嘴唇".into());
        }
        // For an English reader the Chinese translation earns nothing.
        assert_eq!(doc_score(&netease, Some("latin")), 2);
        // A reader who wants Chinese gets the bonus.
        assert_eq!(doc_score(&netease, Some("zh")), 3);

        entry.docs.insert(SourceId::Lrclib, lrclib);
        entry.docs.insert(SourceId::Netease, netease);

        // English target: the word-level document wins, and nothing is grafted
        // onto it — a Chinese line under a Korean lyric is not a translation
        // this reader can use, and it would have been discarded downstream.
        let best = entry.best_doc(Some("latin")).unwrap();
        assert_eq!(best.source, SourceId::Lrclib);
        assert!(best.lines.iter().all(|l| l.translation.is_none()));

        // Chinese target: same winner, but now the lines are worth grafting.
        let best = entry.best_doc(Some("zh")).unwrap();
        assert_eq!(best.source, SourceId::Lrclib);
        assert!(best.lines.iter().any(|l| l.translation.is_some()));
    }

    #[test]
    fn base_lang_folds_latin_scripts_together() {
        for code in ["en", "en-US", "es", "pt_BR", "de"] {
            assert_eq!(crate::lyrics::base_lang(code), "latin", "{code}");
        }
        assert_eq!(crate::lyrics::base_lang("zh-Hans"), "zh");
        assert_eq!(crate::lyrics::base_lang("ja"), "ja");
        assert_eq!(crate::lyrics::base_lang("ko"), "ko");
    }

    #[test]
    fn fingerprint_defaults_empty_on_entries_written_before_the_field() {
        // Old cache files have no `fetchFingerprint`. It must deserialize to ""
        // so it compares unequal to any real config and triggers one refresh,
        // rather than failing the load and dropping the whole entry.
        let json = r#"{"trackKey":"k","docs":{},"offsetMs":-200}"#;
        let back: CacheEntry = serde_json::from_str(json).unwrap();
        assert_eq!(back.fetch_fingerprint, "");
        assert_eq!(back.offset_ms, -200);
    }
}
