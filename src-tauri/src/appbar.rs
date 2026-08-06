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
use windows::Win32::UI::Shell::{
    ABE_BOTTOM, ABE_TOP, ABM_NEW, ABM_QUERYPOS, ABM_REMOVE, ABM_SETPOS, APPBARDATA,
    SHAppBarMessage,
};
use windows::Win32::UI::WindowsAndMessaging::{
    HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOZORDER, SetWindowPos,
};

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

        if !*held {
            // Zero means failure here, unlike the position calls below.
            if unsafe { SHAppBarMessage(ABM_NEW, &mut abd) } == 0 {
                return None;
            }
            *held = true;
        }

        abd.uEdge = edge.as_u32();
        abd.rc = match edge {
            Edge::Top => RECT {
                left: mon.left,
                top: mon.top,
                right: mon.right,
                bottom: mon.top + thickness,
            },
            Edge::Bottom => RECT {
                left: mon.left,
                top: mon.bottom - thickness,
                right: mon.right,
                bottom: mon.bottom,
            },
        };

        // The shell may slide the strip to clear the taskbar; it only moves the
        // edge it owns, so restore our thickness against whatever it returned.
        unsafe { SHAppBarMessage(ABM_QUERYPOS, &mut abd) };
        match edge {
            Edge::Top => abd.rc.bottom = abd.rc.top + thickness,
            Edge::Bottom => abd.rc.top = abd.rc.bottom - thickness,
        }

        unsafe { SHAppBarMessage(ABM_SETPOS, &mut abd) };

        let rc = abd.rc;
        let _ = unsafe {
            SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                rc.left,
                rc.top,
                rc.right - rc.left,
                rc.bottom - rc.top,
                SWP_NOACTIVATE | SWP_NOZORDER,
            )
        };
        Some(rc)
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
