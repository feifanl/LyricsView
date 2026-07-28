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

use crate::lyrics::{LyricsDoc, SourceId};

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
}

impl CacheEntry {
    fn new(track_key: &str) -> Self {
        Self {
            track_key: track_key.to_string(),
            ..Default::default()
        }
    }

    /// Best cached document: the preferred source if present, else the richest
    /// available (word-level beats line-level beats plain).
    pub fn best_doc(&self) -> Option<LyricsDoc> {
        if let Some(pref) = self.preferred_source {
            if let Some(doc) = self.docs.get(&pref) {
                return Some(doc.clone());
            }
        }
        self.docs
            .values()
            .max_by_key(|d| doc_rank(d))
            .cloned()
    }
}

fn doc_rank(d: &LyricsDoc) -> u8 {
    if d.has_word_timing {
        2
    } else if !d.lines.is_empty() {
        1
    } else {
        0
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

    /// Insert/replace a fetched document and persist.
    pub fn store_doc(&self, key: &str, doc: &LyricsDoc) {
        let mut entry = self.load_or_new(key);
        entry.docs.insert(doc.source, doc.clone());
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
            source_duration_ms: None,
        }
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
        assert_eq!(entry.best_doc().unwrap().source, SourceId::Musixmatch);
        // Explicit preference wins even if line-level.
        entry.preferred_source = Some(SourceId::Lrclib);
        assert_eq!(entry.best_doc().unwrap().source, SourceId::Lrclib);
    }
}
