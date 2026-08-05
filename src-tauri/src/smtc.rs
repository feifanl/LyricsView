// SMTC (System Media Transport Controls) now-playing watcher.
//
// Uses the WinRT `Windows.Media.Control` namespace. All SMTC work runs on a
// dedicated OS thread; WinRT change events additionally fire on threadpool
// threads. We marshal everything through a cloned `AppHandle` (Send + Sync) and
// a shared `SmtcState` (mutexes) — we never touch non-agile state from callbacks.
//
// Trap handled: several players (Spotify) do not raise timeline events during
// normal playback, so we ALSO poll timeline properties every 1000 ms.
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, Runtime};
use windows::Foundation::TypedEventHandler;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};

use crate::model::{PlaybackStatePayload, SessionInfo, TimelinePayload, TrackInfo};

pub const EVT_TRACK: &str = "smtc://track-changed";
pub const EVT_STATE: &str = "smtc://playback-state";
pub const EVT_TIMELINE: &str = "smtc://timeline";

/// Shared, persisted-for-session SMTC state.
#[derive(Default)]
pub struct SmtcState {
    /// User-pinned source app id; when set, that session is preferred.
    pub pinned_app_id: Mutex<Option<String>>,
    last_track: Mutex<Option<TrackInfo>>,
    last_playing: Mutex<Option<bool>>,
    /// Most recent track, used by cache-key commands.
    pub current_track: Mutex<Option<TrackInfo>>,
}

impl SmtcState {
    /// Drop the remembered playback status so the next poll re-emits it even if
    /// it has not changed. Used when a fresh listener needs the current value.
    pub fn clear_playback_dedupe(&self) {
        *self.last_playing.lock().unwrap() = None;
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Spawn the SMTC watcher thread. Safe to call once during app setup.
pub fn start<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        if let Err(e) = run(app) {
            eprintln!("[smtc] watcher failed to start: {e:?}");
        }
    });
}

fn run<R: Runtime>(app: AppHandle<R>) -> windows::core::Result<()> {
    let manager = SessionManager::RequestAsync()?.get()?;

    // Re-attach per-session handlers whenever the current session changes.
    {
        let app = app.clone();
        let manager_clone = manager.clone();
        manager.CurrentSessionChanged(&TypedEventHandler::new(
            move |_mgr: windows::core::Ref<'_, SessionManager>, _args| {
                if let Ok(session) = effective_session(&manager_clone, &app) {
                    attach_session_handlers(&app, &session);
                    emit_track(&app, &session);
                    emit_playback(&app, &session);
                    emit_timeline(&app, &session);
                }
                Ok(())
            },
        ))?;
    }

    // Initial attach + emit.
    if let Ok(session) = effective_session(&manager, &app) {
        attach_session_handlers(&app, &session);
        emit_track(&app, &session);
        emit_playback(&app, &session);
        emit_timeline(&app, &session);
    }

    // 1 Hz timeline poll (fallback for players that don't fire timeline events)
    // plus a metadata/state re-check so pinned-session switches are picked up.
    // Poll at 500 ms: several players (Spotify, browsers) don't fire timeline
    // events on seek/track-change, so polling keeps position and metadata fresh.
    loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if let Ok(session) = effective_session(&manager, &app) {
            emit_timeline(&app, &session);
            emit_track(&app, &session);
            emit_playback(&app, &session);
        }
    }
}

/// The session to render: the user-pinned app if present & available, else the
/// system "current" session.
fn effective_session<R: Runtime>(
    manager: &SessionManager,
    app: &AppHandle<R>,
) -> windows::core::Result<Session> {
    if let Some(pinned) = app
        .try_state::<SmtcState>()
        .and_then(|s| s.pinned_app_id.lock().unwrap().clone())
    {
        let sessions = manager.GetSessions()?;
        for i in 0..sessions.Size()? {
            let s = sessions.GetAt(i)?;
            if s.SourceAppUserModelId()? == pinned {
                return Ok(s);
            }
        }
    }
    manager.GetCurrentSession()
}

fn attach_session_handlers<R: Runtime>(app: &AppHandle<R>, session: &Session) {
    let a1 = app.clone();
    let _ = session.MediaPropertiesChanged(&TypedEventHandler::new(
        move |sender: windows::core::Ref<'_, Session>, _args| {
            if let Some(s) = sender.as_ref() {
                emit_track(&a1, s);
            }
            Ok(())
        },
    ));
    let a2 = app.clone();
    let _ = session.PlaybackInfoChanged(&TypedEventHandler::new(
        move |sender: windows::core::Ref<'_, Session>, _args| {
            if let Some(s) = sender.as_ref() {
                emit_playback(&a2, s);
            }
            Ok(())
        },
    ));
    let a3 = app.clone();
    let _ = session.TimelinePropertiesChanged(&TypedEventHandler::new(
        move |sender: windows::core::Ref<'_, Session>, _args| {
            if let Some(s) = sender.as_ref() {
                emit_timeline(&a3, s);
            }
            Ok(())
        },
    ));
}

fn read_track(session: &Session) -> windows::core::Result<TrackInfo> {
    let props = session.TryGetMediaPropertiesAsync()?.get()?;
    let title = props.Title().map(|s| s.to_string()).unwrap_or_default();
    let artist = props.Artist().map(|s| s.to_string()).unwrap_or_default();
    let album = props
        .AlbumTitle()
        .map(|s| s.to_string())
        .unwrap_or_default();
    let source_app_id = session
        .SourceAppUserModelId()
        .map(|s| s.to_string())
        .unwrap_or_default();

    // Duration comes from the timeline (EndTime - StartTime), in 100 ns units.
    let duration_ms = session
        .GetTimelineProperties()
        .and_then(|t| Ok((t.EndTime()?.Duration - t.StartTime()?.Duration).max(0) as u64 / 10_000))
        .unwrap_or(0);

    Ok(TrackInfo {
        title,
        artist,
        album,
        duration_ms,
        source_app_id,
    })
}

fn emit_track<R: Runtime>(app: &AppHandle<R>, session: &Session) {
    let track = match read_track(session) {
        Ok(t) => t,
        Err(_) => return,
    };
    // Ignore empty/garbage metadata (no title = nothing playing yet).
    if track.title.trim().is_empty() {
        return;
    }
    if let Some(state) = app.try_state::<SmtcState>() {
        let mut last = state.last_track.lock().unwrap();
        if last.as_ref() == Some(&track) {
            return; // unchanged
        }
        *last = Some(track.clone());
        *state.current_track.lock().unwrap() = Some(track.clone());
        // Force the playback state to re-emit for the new track: the overlay
        // clock resets `playing` to false on track change, and without a fresh
        // EVT_STATE (deduped when the status is unchanged) it never learns the
        // new song is already playing, so the clock stays frozen.
        *state.last_playing.lock().unwrap() = None;
    }
    let _ = app.emit(EVT_TRACK, track);
}

fn emit_playback<R: Runtime>(app: &AppHandle<R>, session: &Session) {
    let playing = match session.GetPlaybackInfo().and_then(|i| i.PlaybackStatus()) {
        Ok(status) => status == PlaybackStatus::Playing,
        Err(_) => return,
    };
    if let Some(state) = app.try_state::<SmtcState>() {
        let mut last = state.last_playing.lock().unwrap();
        if *last == Some(playing) {
            return;
        }
        *last = Some(playing);
    }
    let _ = app.emit(EVT_STATE, PlaybackStatePayload { playing });
}

fn emit_timeline<R: Runtime>(app: &AppHandle<R>, session: &Session) {
    let Ok(timeline) = session.GetTimelineProperties() else {
        return;
    };
    let Ok(position) = timeline.Position() else {
        return;
    };
    let position_ms = (position.Duration.max(0) as u64) / 10_000;

    let rate = session
        .GetPlaybackInfo()
        .ok()
        .and_then(|i| i.PlaybackRate().ok())
        .and_then(|r| r.Value().ok())
        .filter(|r| *r > 0.0)
        .unwrap_or(1.0);

    // The position was sampled at LastUpdatedTime, not now. Using it as the
    // report timestamp lets the frontend extrapolate correctly — otherwise the
    // highlight runs seconds behind when the player's position is stale.
    let reported_at_ms = timeline
        .LastUpdatedTime()
        .ok()
        .map(|dt| filetime_to_unix_ms(dt.UniversalTime))
        .filter(|ms| *ms > 0)
        .unwrap_or_else(now_ms);

    let _ = app.emit(
        EVT_TIMELINE,
        TimelinePayload {
            position_ms,
            reported_at_ms,
            rate,
        },
    );
}

/// Convert a Windows FILETIME (100 ns ticks since 1601) to Unix epoch ms.
fn filetime_to_unix_ms(universal_time: i64) -> u64 {
    const EPOCH_DIFF_100NS: i64 = 116_444_736_000_000_000; // 1601->1970
    let unix_100ns = universal_time - EPOCH_DIFF_100NS;
    if unix_100ns <= 0 {
        0
    } else {
        (unix_100ns / 10_000) as u64
    }
}

/// Send a transport command to the effective session (play/pause toggle, skip).
pub fn control<R: Runtime>(app: &AppHandle<R>, action: &str) -> windows::core::Result<bool> {
    let manager = SessionManager::RequestAsync()?.get()?;
    let session = effective_session(&manager, app)?;
    let op = match action {
        "toggle" => session.TryTogglePlayPauseAsync()?,
        "play" => session.TryPlayAsync()?,
        "pause" => session.TryPauseAsync()?,
        "next" => session.TrySkipNextAsync()?,
        "prev" | "previous" => session.TrySkipPreviousAsync()?,
        _ => return Ok(false),
    };
    op.get()
}

/// Enumerate all SMTC sessions with which one is current.
pub fn list_sessions() -> windows::core::Result<Vec<SessionInfo>> {
    let manager = SessionManager::RequestAsync()?.get()?;
    let current_id = manager
        .GetCurrentSession()
        .ok()
        .and_then(|s| s.SourceAppUserModelId().ok())
        .map(|s| s.to_string());
    let sessions = manager.GetSessions()?;
    let mut out = Vec::new();
    for i in 0..sessions.Size()? {
        let s = sessions.GetAt(i)?;
        let app_id = s.SourceAppUserModelId()?.to_string();
        let is_current = Some(&app_id) == current_id.as_ref();
        out.push(SessionInfo { app_id, is_current });
    }
    Ok(out)
}
