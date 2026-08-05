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
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    #[error("no timestamped lines found")]
    NoTimestamps,
    #[error("malformed payload: {0}")]
    Malformed(String),
}
