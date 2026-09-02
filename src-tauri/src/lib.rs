//! 看额度桌面壳：托盘常驻 + 关窗驻留 + 迷你小窗。
//! 前端逻辑全部复用 model-quota-frontend，本 crate 只做窗口与托盘的胶水。

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewUrl, WebviewWindowBuilder,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例：重复启动时唤起已有主窗口，而不是再开一个进程
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .setup(|app| {
            build_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    // 关窗即隐藏到托盘：进程与 WebView 保持存活，页面内的定时刷新不中断
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let mini = MenuItem::with_id(app, "mini", "迷你小窗", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &mini, &quit])?;

    TrayIconBuilder::with_id("quota-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("看额度 · 左键显示/隐藏，关闭窗口将驻留托盘")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "mini" => open_mini(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                let visible = app
                    .webview_windows()
                    .get("main")
                    .map(|w| w.is_visible().unwrap_or(false))
                    .unwrap_or(false);
                if visible {
                    if let Some(w) = app.webview_windows().get("main") {
                        let _ = w.hide();
                    }
                } else {
                    show_main(app);
                }
            }
        })
        .build(app)?;
    Ok(())
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.webview_windows().get("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 打开（或聚焦）迷你小窗：复用前端 #mini 视图。
/// 注意：Tauri 内嵌资产下 WebviewUrl::App 的查询参数会被剥离，因此用哈希路由。
fn open_mini(app: &tauri::AppHandle) {
    if let Some(w) = app.webview_windows().get("mini") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "mini", WebviewUrl::App("index.html#mini".into()))
        .title("额度速览")
        .inner_size(400.0, 640.0)
        .resizable(false)
        .maximizable(false)
        .build();
}
