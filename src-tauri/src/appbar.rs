// Reserve desktop space for the overlay, instead of floating over other windows.
//
// A docked overlay that is merely always-on-top always covers something: at the
// bottom it sits on the taskbar, at the top it hides browser tabs. Windows has a
// mechanism for exactly this — an *appbar*, the same one the taskbar itself uses.
// Registering one shrinks the desktop work area, so maximised windows lay out
// around the strip rather than underneath it.
//
// The lifecycle matters more than the geometry:
//
//   ABM_NEW      register once, with the window handle
//   ABM_QUERYPOS ask the shell where the strip may go — other appbars (the
//                taskbar) already hold space, and the shell slides ours clear
//   ABM_SETPOS   commit, then move the window to the rect the shell approved
//   ABM_REMOVE   give the space back
//
// Skipping ABM_REMOVE leaves the work area permanently shrunk — a black strip no
// window will use until the shell notices the handle is dead or explorer
// restarts. So removal runs on dock change, on window close and on app exit, and
// registration is tracked here rather than inferred.
use std::sync::Mutex;

use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromRect,
};
use windows::Win32::UI::Shell::{
    ABE_BOTTOM, ABE_TOP, ABM_NEW, ABM_QUERYPOS, ABM_REMOVE, ABM_SETPOS, APPBARDATA,
    SHAppBarMessage,
};
// The window is positioned by the caller, not here: reserving space and placing
// the bar are separate decisions, and having both sides move the window is what
// left it one step out of position on a re-apply.

/// Which screen edge the strip occupies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edge {
    Top,
    Bottom,
}

impl Edge {
    fn as_u32(self) -> u32 {
        match self {
            Edge::Top => ABE_TOP,
            Edge::Bottom => ABE_BOTTOM,
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "top" => Some(Edge::Top),
            "bottom" => Some(Edge::Bottom),
            _ => None,
        }
    }
}

/// Whether we currently hold a registration. Guarded so a double ABM_NEW (which
/// the shell treats as an error) or a stray ABM_REMOVE can't happen.
#[derive(Default)]
pub struct AppBarState(Mutex<bool>);

/// The work area of the monitor `mon` sits on: the monitor minus the taskbar and
/// every other appbar currently registered. Queried live, so it reflects
/// whatever the user's taskbar is doing — any edge, any thickness, any DPI —
/// rather than assuming anything about its size.
///
/// `None` if the shell won't answer, in which case the caller falls back to the
/// monitor rect and simply overlaps.
fn work_area(mon: RECT) -> Option<RECT> {
    let hmon = unsafe { MonitorFromRect(&mon, MONITOR_DEFAULTTONEAREST) };
    let mut mi = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    unsafe { GetMonitorInfoW(hmon, &mut mi) }
        .as_bool()
        .then_some(mi.rcWork)
}

fn data(hwnd: HWND) -> APPBARDATA {
    APPBARDATA {
        cbSize: std::mem::size_of::<APPBARDATA>() as u32,
        hWnd: hwnd,
        uCallbackMessage: 0,
        uEdge: 0,
        rc: RECT::default(),
        lParam: LPARAM(0),
    }
}

impl AppBarState {
    /// Claim `thickness` physical pixels along `edge` of the monitor described by
    /// `mon`. Returns the rect the shell actually granted.
    pub fn reserve(&self, hwnd: HWND, edge: Edge, mon: RECT, thickness: i32) -> Option<RECT> {
        let mut held = self.0.lock().ok()?;
        let mut abd = data(hwnd);

        // Always start from no reservation of our own.
        //
        // ABM_QUERYPOS answers "where can this strip go, given the space already
        // spoken for" — and the space we are currently holding counts. Re-applying
        // on top of a live registration therefore asked the shell to fit the strip
        // beside itself, and it obliged, sliding the new rect clear of the old one.
        // Every re-apply (a settings change, a preset switch, a dock toggle) moved
        // the bar another notch inward, leaving a widening band of bare desktop
        // between the bar and the taskbar.
        if *held {
            unsafe { SHAppBarMessage(ABM_REMOVE, &mut abd) };
            *held = false;
            abd = data(hwnd);
        }
        // Zero means failure here, unlike the position calls below.
        if unsafe { SHAppBarMessage(ABM_NEW, &mut abd) } == 0 {
            return None;
        }
        *held = true;

        // Ask for a band flush against the work area — it already excludes the
        // taskbar and every other appbar, so this claims exactly what the bar
        // occupies and nothing more.
        //
        // The obvious alternative, requesting the monitor edge and letting
        // ABM_QUERYPOS slide the strip clear, over-claims: the shell answers
        // with the taskbar's *registered* rect, which on Windows 11 reaches
        // further up the screen than the work area it actually costs. Deriving
        // our thickness from that edge put the strip's inner edge too high, and
        // ABM_SETPOS reserves from there to the screen — far more than the bar
        // uses.
        let area = work_area(mon).unwrap_or(mon);
        let strip = match edge {
            Edge::Top => RECT {
                left: area.left,
                top: area.top,
                right: area.right,
                bottom: area.top + thickness,
            },
            Edge::Bottom => RECT {
                left: area.left,
                top: area.bottom - thickness,
                right: area.right,
                bottom: area.bottom,
            },
        };

        abd.uEdge = edge.as_u32();
        abd.rc = strip;
        // Sent so the shell can object, but its answer is not what we commit:
        // it replies with that same over-reaching taskbar edge.
        unsafe { SHAppBarMessage(ABM_QUERYPOS, &mut abd) };
        abd.rc = strip;
        unsafe { SHAppBarMessage(ABM_SETPOS, &mut abd) };

        // Return the strip we asked for, not `abd.rc`. SETPOS reports the band
        // it booked, which the shell may shorten to stop short of the taskbar's
        // registered edge — position the window there and it floats above the
        // taskbar with bare desktop showing through the difference. What the
        // shell books and where the window belongs are separate questions; the
        // window belongs flush against the work area.
        Some(strip)
    }

    /// Hand the space back. Safe to call when nothing is registered.
    pub fn release(&self, hwnd: HWND) {
        let Ok(mut held) = self.0.lock() else { return };
        if !*held {
            return;
        }
        let mut abd = data(hwnd);
        unsafe { SHAppBarMessage(ABM_REMOVE, &mut abd) };
        *held = false;
    }

    pub fn is_held(&self) -> bool {
        self.0.lock().map(|h| *h).unwrap_or(false)
    }
}

/// Release any registration held for the overlay window. Called on app exit.
pub fn release_for<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    let Some(state) = app.try_state::<AppBarState>() else {
        return;
    };
    if !state.is_held() {
        return;
    }
    let Some(win) = crate::window::overlay_window(app) else {
        return;
    };
    if let Ok(h) = win.hwnd() {
        state.release(HWND(h.0 as _));
    }
}
