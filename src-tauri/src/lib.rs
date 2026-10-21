use std::sync::Mutex;
use tauri::{AppHandle, Manager, LogicalSize, Emitter};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use windows_sys::Win32::Foundation::{HWND, POINT};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, MOUSEINPUT,
    KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, VK_CONTROL,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, SetForegroundWindow, GetWindowTextW,
    GetCursorPos, WindowFromPoint,
};

#[derive(Default)]
struct AppState {
    last_target_hwnd: Mutex<Option<isize>>,
    voice_hotkey: Mutex<Option<Shortcut>>,
    visibility_hotkey: Mutex<Option<Shortcut>>,
}

// Get the title of the active window
#[tauri::command]
fn get_active_window_info() -> Result<String, String> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return Ok("No Active Window".to_string());
        }
        let mut buffer = [0u16; 512];
        let len = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
        if len > 0 {
            Ok(String::from_utf16_lossy(&buffer[..len as usize]))
        } else {
            Ok("Active Window".to_string())
        }
    }
}

// Remember the target window where user wants to type
#[tauri::command]
fn record_target_window(app_handle: AppHandle) -> Result<(), String> {
    let state = app_handle.state::<AppState>();
    unsafe {
        let hwnd = GetForegroundWindow();
        let overlay_hwnd = if let Some(win) = app_handle.get_webview_window("main") {
            win.hwnd().map(|h| h.0 as isize).unwrap_or(0)
        } else {
            0
        };

        let current_hwnd = hwnd as isize;
        if current_hwnd != 0 && current_hwnd != overlay_hwnd {
            let mut last = state.last_target_hwnd.lock().unwrap();
            *last = Some(current_hwnd);
        }
    }
    Ok(())
}

// Set up overlay window (always on top, transparent)
#[tauri::command]
fn setup_overlay_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.set_always_on_top(true).map_err(|e| e.to_string())?;
    Ok(())
}

// Native window drag handler called from frontend pointerdown
#[tauri::command]
fn start_dragging(window: tauri::WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

// Get current window physical position for persistence
#[tauri::command]
fn get_window_pos(window: tauri::WebviewWindow) -> Result<(i32, i32), String> {
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    Ok((pos.x, pos.y))
}

// Set window physical position
#[tauri::command]
fn set_window_pos(window: tauri::WebviewWindow, x: i32, y: i32) -> Result<(), String> {
    window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }))
        .map_err(|e| e.to_string())
}

// Resize the overlay window dynamically (e.g. when expanding settings or interim transcript)
#[tauri::command]
fn resize_overlay(app_handle: AppHandle, width: f64, height: f64) -> Result<(), String> {
    if let Some(win) = app_handle.get_webview_window("main") {
        win.set_size(LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Internal helper to toggle overlay show/hide
fn toggle_overlay_visibility_internal(app: &AppHandle) -> Result<bool, String> {
    if let Some(win) = app.get_webview_window("main") {
        let is_visible = win.is_visible().unwrap_or(true);
        if is_visible {
            win.hide().map_err(|e| e.to_string())?;
            Ok(false)
        } else {
            win.show().map_err(|e| e.to_string())?;
            let _ = win.set_focus();
            Ok(true)
        }
    } else {
        Err("Overlay window not found".to_string())
    }
}

// Toggle show / hide overlay from frontend or hotkey
#[tauri::command]
fn toggle_overlay_visibility(app_handle: AppHandle) -> Result<bool, String> {
    toggle_overlay_visibility_internal(&app_handle)
}

// Hide overlay to background
#[tauri::command]
fn hide_overlay(app_handle: AppHandle) -> Result<(), String> {
    if let Some(win) = app_handle.get_webview_window("main") {
        win.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Show overlay
#[tauri::command]
fn show_overlay(app_handle: AppHandle) -> Result<(), String> {
    if let Some(win) = app_handle.get_webview_window("main") {
        win.show().map_err(|e| e.to_string())?;
        let _ = win.set_focus();
    }
    Ok(())
}

// Register or update global hotkeys (voice dictation & show/hide visibility)
#[tauri::command]
fn update_hotkeys(
    app_handle: AppHandle,
    voice_hotkey_str: String,
    visibility_hotkey_str: String,
) -> Result<(), String> {
    let _ = app_handle.global_shortcut().unregister_all();

    let voice_sc = if !voice_hotkey_str.trim().is_empty() {
        let sc: Shortcut = voice_hotkey_str.parse().map_err(|e| format!("Invalid Voice Hotkey '{}': {:?}", voice_hotkey_str, e))?;
        app_handle.global_shortcut().register(sc).map_err(|e| e.to_string())?;
        Some(sc)
    } else {
        None
    };

    let vis_sc = if !visibility_hotkey_str.trim().is_empty() {
        let sc: Shortcut = visibility_hotkey_str.parse().map_err(|e| format!("Invalid Visibility Hotkey '{}': {:?}", visibility_hotkey_str, e))?;
        app_handle.global_shortcut().register(sc).map_err(|e| e.to_string())?;
        Some(sc)
    } else {
        None
    };

    let state = app_handle.state::<AppState>();
    {
        let mut v = state.voice_hotkey.lock().unwrap();
        *v = voice_sc;
    }
    {
        let mut vis = state.visibility_hotkey.lock().unwrap();
        *vis = vis_sc;
    }

    Ok(())
}

// Legacy single-hotkey updater
#[tauri::command]
fn update_global_hotkey(app_handle: AppHandle, shortcut_str: String) -> Result<(), String> {
    update_hotkeys(app_handle, shortcut_str, "Ctrl+Alt+H".to_string())
}

// Focuses and positions caret either directly at the mouse cursor or target window
unsafe fn focus_target(overlay_hwnd: isize, last_target: Option<isize>, type_at_mouse: bool) {
    unsafe {
        let mut pt = POINT { x: 0, y: 0 };
        let has_cursor = GetCursorPos(&mut pt) != 0;

        let mouse_target_hwnd = if has_cursor {
            let h = WindowFromPoint(pt);
            if !h.is_null() {
                Some(h as isize)
            } else {
                None
            }
        } else {
            None
        };

        // 1. If typing at mouse cursor is requested AND mouse is NOT hovering over the overlay itself:
        if type_at_mouse {
            if let Some(m_hwnd) = mouse_target_hwnd {
                if m_hwnd != overlay_hwnd && m_hwnd != 0 {
                    // Focus target window under mouse
                    SetForegroundWindow(m_hwnd as HWND);
                    std::thread::sleep(std::time::Duration::from_millis(35));

                    // Send a quick mouse click to focus the exact control/caret under mouse
                    let mut click_inputs: [INPUT; 2] = std::mem::zeroed();
                    click_inputs[0].r#type = INPUT_MOUSE;
                    click_inputs[0].Anonymous.mi = MOUSEINPUT {
                        dx: 0,
                        dy: 0,
                        mouseData: 0,
                        dwFlags: MOUSEEVENTF_LEFTDOWN,
                        time: 0,
                        dwExtraInfo: 0,
                    };
                    click_inputs[1].r#type = INPUT_MOUSE;
                    click_inputs[1].Anonymous.mi = MOUSEINPUT {
                        dx: 0,
                        dy: 0,
                        mouseData: 0,
                        dwFlags: MOUSEEVENTF_LEFTUP,
                        time: 0,
                        dwExtraInfo: 0,
                    };
                    SendInput(2, click_inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32);
                    std::thread::sleep(std::time::Duration::from_millis(45));
                    return;
                }
            }
        }

        // 2. Fallback: Restore focus to last active application window
        if let Some(thwnd) = last_target {
            if thwnd != overlay_hwnd && thwnd != 0 {
                SetForegroundWindow(thwnd as HWND);
                std::thread::sleep(std::time::Duration::from_millis(35));
            }
        }
    }
}

// Type or paste text anywhere on PC
#[tauri::command]
fn type_text(
    app_handle: AppHandle,
    text: String,
    method: String,
    add_space: bool,
    type_at_mouse: Option<bool>,
) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }

    let mut final_text = text;
    if add_space && !final_text.ends_with(' ') && !final_text.ends_with('\n') {
        final_text.push(' ');
    }

    let state = app_handle.state::<AppState>();
    let target_hwnd = {
        let last = state.last_target_hwnd.lock().unwrap();
        *last
    };

    let overlay_hwnd = if let Some(win) = app_handle.get_webview_window("main") {
        win.hwnd().map(|h| h.0 as isize).unwrap_or(0)
    } else {
        0
    };

    unsafe {
        focus_target(overlay_hwnd, target_hwnd, type_at_mouse.unwrap_or(true));
    }

    match method.as_str() {
        "paste" => {
            // Instant paste using clipboard + Ctrl+V
            let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            let prev_clipboard = clipboard.get_text().ok();

            clipboard.set_text(final_text).map_err(|e| e.to_string())?;
            std::thread::sleep(std::time::Duration::from_millis(15));

            unsafe {
                // Send Ctrl+V
                let mut inputs: [INPUT; 4] = std::mem::zeroed();

                // Ctrl Down
                inputs[0].r#type = INPUT_KEYBOARD;
                inputs[0].Anonymous.ki = KEYBDINPUT {
                    wVk: VK_CONTROL,
                    wScan: 0,
                    dwFlags: 0,
                    time: 0,
                    dwExtraInfo: 0,
                };

                // 'V' Down
                inputs[1].r#type = INPUT_KEYBOARD;
                inputs[1].Anonymous.ki = KEYBDINPUT {
                    wVk: 0x56, // 'V'
                    wScan: 0,
                    dwFlags: 0,
                    time: 0,
                    dwExtraInfo: 0,
                };

                // 'V' Up
                inputs[2].r#type = INPUT_KEYBOARD;
                inputs[2].Anonymous.ki = KEYBDINPUT {
                    wVk: 0x56,
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                };

                // Ctrl Up
                inputs[3].r#type = INPUT_KEYBOARD;
                inputs[3].Anonymous.ki = KEYBDINPUT {
                    wVk: VK_CONTROL,
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                };

                SendInput(4, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32);
            }

            // Restore previous clipboard after short delay in background thread if needed
            if let Some(prev) = prev_clipboard {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(350));
                    if let Ok(mut cb) = arboard::Clipboard::new() {
                        let _ = cb.set_text(prev);
                    }
                });
            }
        }
        "typewriter" => {
            // Direct Unicode input simulation
            let utf16_chars: Vec<u16> = final_text.encode_utf16().collect();
            for ch in utf16_chars {
                unsafe {
                    let mut inputs: [INPUT; 2] = std::mem::zeroed();
                    // Key down
                    inputs[0].r#type = INPUT_KEYBOARD;
                    inputs[0].Anonymous.ki = KEYBDINPUT {
                        wVk: 0,
                        wScan: ch,
                        dwFlags: KEYEVENTF_UNICODE,
                        time: 0,
                        dwExtraInfo: 0,
                    };
                    // Key up
                    inputs[1].r#type = INPUT_KEYBOARD;
                    inputs[1].Anonymous.ki = KEYBDINPUT {
                        wVk: 0,
                        wScan: ch,
                        dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    };

                    SendInput(2, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32);
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
        "copy" => {
            let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            clipboard.set_text(final_text).map_err(|e| e.to_string())?;
        }
        _ => return Err(format!("Unknown typing method: {}", method)),
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let state = app.state::<AppState>();
                        let is_voice = {
                            let v = state.voice_hotkey.lock().unwrap();
                            v.as_ref().map(|s| s == shortcut).unwrap_or(false)
                        };
                        let is_vis = {
                            let vis = state.visibility_hotkey.lock().unwrap();
                            vis.as_ref().map(|s| s == shortcut).unwrap_or(false)
                        };

                        if is_voice {
                            let _ = app.emit("toggle-voice-hotkey", ());
                        } else if is_vis {
                            let _ = toggle_overlay_visibility_internal(app);
                            let _ = app.emit("toggle-visibility-hotkey", ());
                        }
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_active_window_info,
            record_target_window,
            setup_overlay_window,
            start_dragging,
            get_window_pos,
            set_window_pos,
            resize_overlay,
            toggle_overlay_visibility,
            hide_overlay,
            show_overlay,
            update_hotkeys,
            update_global_hotkey,
            type_text,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Register default global hotkeys
            let default_voice = "Ctrl+Alt+V".parse::<Shortcut>().ok();
            let default_vis = "Ctrl+Alt+H".parse::<Shortcut>().ok();

            if let Some(sc) = default_voice {
                let _ = app.handle().global_shortcut().register(sc);
                let state = app.state::<AppState>();
                let mut v = state.voice_hotkey.lock().unwrap();
                *v = Some(sc);
            }

            if let Some(sc) = default_vis {
                let _ = app.handle().global_shortcut().register(sc);
                let state = app.state::<AppState>();
                let mut vis = state.visibility_hotkey.lock().unwrap();
                *vis = Some(sc);
            }

            // Track foreground window in background so we always know where to type
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(450));
                    let _ = record_target_window(app_handle.clone());
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
