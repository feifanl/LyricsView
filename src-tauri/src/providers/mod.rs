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
use crate::lyrics::{LyricsDoc, SourceId};
use crate::model::{SearchCandidate, TrackInfo};

/// A lyrics source. Fetches are fail-soft: any error yields `None`/empty so the
/// chain degrades to the next provider (critical for the unofficial ones).
#[allow(async_fn_in_trait)] // internal trait, always awaited on the same thread
pub trait Provider {
    async fn fetch(&self, http: &Client, track: &TrackInfo) -> Option<LyricsDoc>;
    async fn search(&self, http: &Client, query: &str) -> Vec<SearchCandidate>;
    async fn fetch_candidate(&self, http: &Client, cand: &SearchCandidate) -> Option<LyricsDoc>;
}

/// Fetch the best available lyrics for a track across the configured chain.
///
/// Providers are scored so a later hit can outrank an earlier one on more than
/// just "has any lines": a doc that carries a translation beats an otherwise
/// equal one without (so Musixmatch's English translation isn't shadowed by an
/// earlier translation-less LRCLIB line-level doc), and word timing outranks
/// translation. We scan until the best achievable score for the user's config
/// is reached, then stop.
pub async fn fetch_best<R: Runtime>(app: &AppHandle<R>, track: &TrackInfo) -> Option<LyricsDoc> {
    let cfg = config::load(app);
    let want_trans = cfg.translation.wanted_lang().is_some();
    // Best score worth waiting for: word timing (+2 per tier) is preferred only
    // when configured; a translation adds +1 when the user shows translations.
    let target = if cfg.prefer_word_level { 4 } else { 2 } + i32::from(want_trans);

    let mut best: Option<LyricsDoc> = None;
    let mut best_score = -1;

    for &id in &cfg.provider_order {
        if !provider_active(&cfg, id) {
            continue;
        }
        let Some(doc) = fetch_from(app, id, track).await else {
            continue;
        };
        let score = doc_score(&doc, want_trans);
        if score > best_score {
            best_score = score;
            best = Some(doc);
        }
        if best_score >= target {
            break;
        }
    }
    best
}

/// Rank a fetched doc. Timing dominates (word-level 4, synced 2, plain 0); a
/// translation adds 1 when the user wants translations. This makes a translated
/// line-level doc (3) beat a translation-less one (2) but never beat word timing.
fn doc_score(doc: &LyricsDoc, want_trans: bool) -> i32 {
    let timing = if doc.has_word_timing {
        4
    } else if !doc.lines.is_empty() {
        2
    } else {
        0
    };
    let has_trans = want_trans && doc.lines.iter().any(|l| l.translation.is_some());
    timing + i32::from(has_trans)
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
