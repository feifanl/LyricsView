// Normalized lyrics model — single source of truth, mirrored in TS
// (src/shared/types.ts). Every provider parses into this shape; the renderer
// only ever sees this shape. All times are milliseconds.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceId {
    Lrclib,
    Musixmatch,
    Netease,
    Applemusic,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricWord {
    pub start: u64,
    pub end: u64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricLine {
    pub start: u64,
    pub end: u64,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<LyricWord>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation: Option<String>,
}

impl LyricLine {
    pub fn new(start: u64, end: u64, text: String) -> Self {
        Self {
            start,
            end,
            text,
            words: None,
            translation: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsDoc {
    pub source: SourceId,
    pub track_key: String,
    pub lines: Vec<LyricLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plain: Option<String>,
    pub has_word_timing: bool,
    /// Duration of the *release this timeline was timed against*, when the
    /// provider reports one. Compared against the playing track's own duration
    /// it yields an automatic drift correction (see `drift.ts`): a 1962 master
    /// and its remaster differ in tape speed, so a timeline from one runs
    /// progressively out of sync against the other.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_duration_ms: Option<u64>,
}

impl LyricsDoc {
    /// A plain (unsynced) document: no timestamps, just fallback text.
    pub fn plain_only(source: SourceId, track_key: &str, plain: String) -> Self {
        Self {
            source,
            track_key: track_key.to_string(),
            lines: Vec::new(),
            plain: Some(plain),
            has_word_timing: false,
            source_duration_ms: None,
        }
    }

    /// Tag the doc with the source release's duration (no-op for `None`).
    pub fn with_source_duration(mut self, ms: Option<u64>) -> Self {
        self.source_duration_ms = ms;
        self
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    #[error("no timestamped lines found")]
    NoTimestamps,
    #[error("malformed payload: {0}")]
    Malformed(String),
}
