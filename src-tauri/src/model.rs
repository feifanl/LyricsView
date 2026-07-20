// Serde models shared across SMTC, providers, cache and commands. Field names
// mirror the TypeScript contract in src/shared/types.ts (camelCase on the wire).
use serde::{Deserialize, Serialize};

use crate::lyrics::SourceId;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackInfo {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: u64,
    pub source_app_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub app_id: String,
    pub is_current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchCandidate {
    pub source: SourceId,
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: Option<u64>,
    pub has_word_timing: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePayload {
    pub position_ms: u64,
    pub reported_at_ms: u64,
    pub rate: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStatePayload {
    pub playing: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preferred_source: Option<SourceId>,
    pub offset_ms: i64,
    pub stretch_ppm: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheInfo {
    pub entries: u64,
    pub bytes: u64,
}
