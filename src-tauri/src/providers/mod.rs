// Provider trait, the normalized-lyrics fetch orchestration and the fallback
// chain. Each provider parses into the shared `LyricsDoc` shape.
//
// Fallback policy (see spec §3): try providers in the user's configured order,
// skipping disabled ones and Apple Music unless a token is configured. If
// "prefer word-level" is on (default), a word-level result wins even over an
// earlier line-level hit — we keep the first line-level doc as a base but keep
// scanning for word timing, and return that if found.
mod applemusic;
mod lrclib;
mod musixmatch;
mod netease;

use reqwest::Client;
use tauri::{AppHandle, Runtime};

use crate::config::{self, ProviderSettings};
use crate::http::{client, APP_UA, BROWSER_UA};
use crate::lyrics::{base_lang, doc_score, LyricsDoc, SourceId};
use crate::model::{SearchCandidate, TrackInfo};

/// A lyrics source. Fetches are fail-soft: any error yields `None`/empty so the
/// chain degrades to the next provider (critical for the unofficial ones).
#[allow(async_fn_in_trait)] // internal trait, always awaited on the same thread
pub trait Provider {
    async fn fetch(&self, http: &Client, track: &TrackInfo) -> Option<LyricsDoc>;
    async fn search(&self, http: &Client, query: &str) -> Vec<SearchCandidate>;
    async fn fetch_candidate(&self, http: &Client, cand: &SearchCandidate) -> Option<LyricsDoc>;
}

/// Fetch lyrics for a track across the configured chain, returning **every**
/// document the chain produced, in the order fetched.
///
/// Returning all of them rather than only the winner is deliberate. Scoring
/// collapses several independent qualities — word timing, a bundled translation
/// — into one number, so the winner is not a superset of the losers: a
/// word-level document with no translation outranks a line-level one that has
/// one. Discarding the losers threw away the only copy of a translation the
/// track had, and no later reload could recover it, because a reload re-runs
/// this same race and discards it again.
///
/// The caller stores them all; `CacheEntry::best_doc` does the picking, so the
/// choice can change later (the user shows translations, turns a provider on)
/// without another fetch.
///
/// Scanning still stops early once the best achievable score for the user's
/// config is reached — the extra documents are a by-product of the race, not a
/// reason to run more of it.
pub async fn fetch_all<R: Runtime>(app: &AppHandle<R>, track: &TrackInfo) -> Vec<LyricsDoc> {
    let cfg = config::load(app);
    let want_lang = cfg.translation.wanted_lang().map(|l| base_lang(&l));
    // Best score worth waiting for: word timing (+2 per tier) is preferred only
    // when configured; a translation adds +1 when the user shows translations.
    let target = if cfg.prefer_word_level { 4 } else { 2 } + i32::from(want_lang.is_some());

    let mut docs: Vec<LyricsDoc> = Vec::new();
    let mut best_score = -1;

    for &id in &cfg.provider_order {
        if !provider_active(&cfg, id) {
            continue;
        }
        let Some(doc) = fetch_from(app, id, track).await else {
            continue;
        };
        best_score = best_score.max(doc_score(&doc, want_lang.as_deref()));
        docs.push(doc);
        if best_score >= target {
            break;
        }
    }
    docs
}

/// Search a single provider explicitly (settings "search" tab).
pub async fn search<R: Runtime>(
    app: &AppHandle<R>,
    id: SourceId,
    query: &str,
) -> Vec<SearchCandidate> {
    let cfg = config::load(app);
    match id {
        SourceId::Lrclib => lrclib::Lrclib.search(&client(APP_UA), query).await,
        SourceId::Musixmatch => {
            musixmatch::Musixmatch::new(app)
                .search(&client(BROWSER_UA), query)
                .await
        }
        SourceId::Netease => netease::Netease.search(&client(BROWSER_UA), query).await,
        SourceId::Applemusic if cfg.apple_music.is_configured() => {
            applemusic::AppleMusic::new(&cfg.apple_music)
                .search(&client(BROWSER_UA), query)
                .await
        }
        _ => Vec::new(),
    }
}

/// Fetch the full lyrics for a specific search candidate.
pub async fn fetch_candidate<R: Runtime>(
    app: &AppHandle<R>,
    cand: &SearchCandidate,
) -> Option<LyricsDoc> {
    match cand.source {
        SourceId::Lrclib => lrclib::Lrclib.fetch_candidate(&client(APP_UA), cand).await,
        SourceId::Musixmatch => {
            musixmatch::Musixmatch::new(app)
                .fetch_candidate(&client(BROWSER_UA), cand)
                .await
        }
        SourceId::Netease => {
            netease::Netease
                .fetch_candidate(&client(BROWSER_UA), cand)
                .await
        }
        SourceId::Applemusic => {
            let cfg = config::load(app);
            applemusic::AppleMusic::new(&cfg.apple_music)
                .fetch_candidate(&client(BROWSER_UA), cand)
                .await
        }
        SourceId::Manual => None,
    }
}

/// Cache key derived from a search candidate's own metadata.
pub fn candidate_key(cand: &SearchCandidate) -> String {
    crate::normalize::track_key(&TrackInfo {
        title: cand.title.clone(),
        artist: cand.artist.clone(),
        album: cand.album.clone(),
        duration_ms: cand.duration_ms.unwrap_or(0),
        source_app_id: String::new(),
    })
}

/// A stable string for every setting that changes which document the race
/// returns: the providers actually consulted, in order, plus the two knobs that
/// decide what "best" means.
///
/// Cached entries carry the fingerprint they were fetched under, so turning a
/// provider on reaches tracks already in the cache instead of applying only to
/// tracks played for the first time afterwards.
pub fn fetch_fingerprint(cfg: &ProviderSettings) -> String {
    let sources: Vec<&str> = cfg
        .provider_order
        .iter()
        .filter(|&&id| provider_active(cfg, id))
        .map(|id| match id {
            SourceId::Lrclib => "lrclib",
            SourceId::Musixmatch => "musixmatch",
            SourceId::Netease => "netease",
            SourceId::Applemusic => "applemusic",
            SourceId::Manual => "manual",
        })
        .collect();
    format!(
        "{}|word={}|trans={}",
        sources.join(","),
        cfg.prefer_word_level,
        cfg.translation.wanted_lang().unwrap_or_default(),
    )
}

fn provider_active(cfg: &ProviderSettings, id: SourceId) -> bool {
    if !cfg.is_enabled(id) {
        return false;
    }
    if id == SourceId::Applemusic && !cfg.apple_music.is_configured() {
        return false;
    }
    true
}

/// Dispatch a single-provider fetch. Match arms are filled in per milestone.
async fn fetch_from<R: Runtime>(
    app: &AppHandle<R>,
    id: SourceId,
    track: &TrackInfo,
) -> Option<LyricsDoc> {
    match id {
        SourceId::Lrclib => lrclib::Lrclib.fetch(&client(APP_UA), track).await,
        SourceId::Musixmatch => {
            musixmatch::Musixmatch::new(app)
                .fetch(&client(BROWSER_UA), track)
                .await
        }
        SourceId::Netease => netease::Netease.fetch(&client(BROWSER_UA), track).await,
        SourceId::Applemusic => {
            let cfg = config::load(app);
            applemusic::AppleMusic::new(&cfg.apple_music)
                .fetch(&client(BROWSER_UA), track)
                .await
        }
        SourceId::Manual => None,
    }
}
