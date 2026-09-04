//! 看额度桌面壳：托盘常驻 + 关窗驻留 + 桌面悬浮球（透明圆形科技风）+ 迷你速览窗。
//! 前端逻辑全部复用 model-quota-frontend，本 crate 只做窗口与托盘的胶水。
//!
//! 已定案的限制（勿重排查）：
//! - 托盘悬停浮窗在 Windows 不可行：tray-icon 底层只上报点击、无 hover 回调；
//! - 悬浮球用 transparent 透明窗口（09-03 验证：透明不影响命中测试，点击/拖动链路全通，
//!   旧「透明窗收不到输入」结论系合成输入测试假象）。

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Listener, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_notification::NotificationExt;
use std::path::PathBuf;
use std::sync::Mutex;

/// 迷你窗逻辑尺寸（与 open_mini / 前端样式保持一致）
const MINI_W: f64 = 300.0;
const MINI_H: f64 = 430.0;
/// 悬浮球窗口尺寸（球体 60px + 辉光余量，前端 .ball 呈现圆形）
const BALL_SIZE: f64 = 76.0;

/// 悬浮球偏好：是否显示 + 物理坐标位置，持久化到配置目录，重启保留
#[derive(Default, Clone, serde::Serialize, serde::Deserialize)]
struct BallPrefs {
    #[serde(default)]
    visible: bool,
    #[serde(default)]
    x: Option<i32>,
    #[serde(default)]
    y: Option<i32>,
}

/// 前端 show-notify 事件载荷：系统通知标题与正文
#[derive(serde::Deserialize)]
struct NotifyPayload {
    title: String,
    body: String,
}

struct ShellState {
    prefs: Mutex<BallPrefs>,
    /// 迷你窗当前是否以「浮出」模式显示（悬浮球单击展开），
    /// 区别于托盘菜单手动打开（后者不自动收起）
    mini_flyout: Mutex<bool>,
}

fn prefs_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("shell.json"))
}

fn load_prefs(app: &AppHandle) -> BallPrefs {
    match prefs_path(app).and_then(|p| std::fs::read_to_string(p).ok()) {
        Some(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        // 首次运行（无配置文件）：悬浮球默认开启
        None => BallPrefs { visible: true, ..BallPrefs::default() },
    }
}

fn save_prefs(app: &AppHandle, prefs: &BallPrefs) {
    if let Some(p) = prefs_path(app) {
        if std::fs::create_dir_all(p.parent().unwrap_or(std::path::Path::new(""))).is_ok() {
            let _ = std::fs::write(p, serde_json::to_string(prefs).unwrap_or_default());
        }
    }
}

fn shell_state(app: &AppHandle) -> Option<&ShellState> {
    app.try_state::<ShellState>().map(|s| s.inner())
}

/// 主显示器缩放（托盘/窗口坐标换算用）
fn scale_factor(app: &AppHandle) -> f64 {
    app.primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0)
}

/// 以物理坐标锚点（窗口右下角对齐处）弹出迷你窗：已存在则移动显示，否则创建
fn show_mini_at(app: &AppHandle, anchor_x: f64, anchor_y: f64) {
    let scale = scale_factor(app);
    let (w, h) = (MINI_W * scale, MINI_H * scale);
    let x = (anchor_x - w).max(8.0);
    let y = (anchor_y - h).max(8.0);
    if let Some(win) = app.webview_windows().get("mini") {
        // 锚点/尺寸均为 Tauri 物理坐标（球 outer_position 一致），物理 set_position 对称还原
        let _ = win.set_position(PhysicalPosition::new(x as i32, y as i32));
        let _ = win.show();
    } else {
        let _ = WebviewWindowBuilder::new(app, "mini", WebviewUrl::App("index.html#mini".into()))
            .title("额度速览")
            .inner_size(MINI_W, MINI_H)
            .decorations(false)
            .resizable(false)
            .maximizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .position(x / scale, y / scale)
            .build();
    }
    if let Some(st) = shell_state(app) {
        *st.mini_flyout.lock().unwrap() = true;
    }
}

/// 仅当迷你窗处于浮出模式时收起
fn hide_mini_flyout(app: &AppHandle) {
    let Some(st) = shell_state(app) else { return };
    let mut flyout = st.mini_flyout.lock().unwrap();
    if *flyout {
        if let Some(w) = app.webview_windows().get("mini") {
            let _ = w.hide();
        }
        *flyout = false;
    }
}

/// 托盘菜单（悬浮球开关项的标签随当前状态变化，切换后整体重建）
fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let ball_on = shell_state(app)
        .map(|st| st.prefs.lock().unwrap().visible)
        .unwrap_or(false);
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let mini = MenuItem::with_id(app, "mini", "迷你小窗", true, None::<&str>)?;
    let ball = MenuItem::with_id(
        app,
        "ball",
        if ball_on { "关闭悬浮球" } else { "打开悬浮球" },
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    Menu::with_items(app, &[&show, &mini, &ball, &quit])
}

/// 创建悬浮球窗口（位置：已保存的物理坐标，否则主显示器右侧偏上）。
/// transparent 透明窗口：球体外的画布真正透明，消除不透明方案的深色方块底。
fn create_ball_window(app: &AppHandle) {
    let st_prefs = shell_state(app).map(|st| st.prefs.lock().unwrap().clone());
    let (x, y) = match st_prefs.as_ref().and_then(|p| p.x.zip(p.y)) {
        Some((x, y)) => (x as f64, y as f64),
        None => {
            let scale = scale_factor(app);
            let width = app
                .primary_monitor()
                .ok()
                .flatten()
                .map(|m| m.size().width as f64)
                .unwrap_or(1920.0);
            // 默认位置（主显示器右侧偏上）按物理坐标计算
            (width - BALL_SIZE * scale - 24.0 * scale, 200.0 * scale)
        }
    };
    if let Ok(win) = WebviewWindowBuilder::new(app, "ball", WebviewUrl::App("index.html#ball".into()))
        .title("额度悬浮球")
        .inner_size(BALL_SIZE, BALL_SIZE)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .build()
    {
        // 偏好保存的是物理坐标（Moved 事件），builder.position 只认逻辑坐标，
        // 故创建后用物理坐标归位——与 Moved 同一坐标系，重启可精确还原
        let _ = win.set_position(PhysicalPosition::new(x as i32, y as i32));
    }
}

/// 广播悬浮球当前状态（开窗即视为开启），主界面按钮与设置页开关据此同步
fn broadcast_ball_state(app: &AppHandle) {
    let visible = app.webview_windows().get("ball").is_some();
    let _ = app.emit("ball-state-changed", visible);
}

/// 开关悬浮球：创建/销毁窗口并持久化偏好，随后重建托盘菜单刷新标签、广播状态
fn toggle_ball(app: &AppHandle) {
    let Some(st) = shell_state(app) else { return };
    let turning_on = app.webview_windows().get("ball").is_none();
    if turning_on {
        create_ball_window(app);
    } else if let Some(w) = app.webview_windows().get("ball") {
        let _ = w.destroy();
    }
    {
        let mut prefs = st.prefs.lock().unwrap();
        prefs.visible = turning_on;
        save_prefs(app, &prefs);
    }
    if let Some(tray) = app.tray_by_id("quota-tray") {
        if let Ok(menu) = build_tray_menu(app) {
            let _ = tray.set_menu(Some(menu));
        }
    }
    broadcast_ball_state(app);
}

/// 设置悬浮球到指定状态（与当前一致则只广播，供设置页开关的绝对语义使用）
fn set_ball(app: &AppHandle, visible: bool) {
    let current = app.webview_windows().get("ball").is_some();
    if visible != current {
        toggle_ball(app);
    } else {
        broadcast_ball_state(app);
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.webview_windows().get("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 托盘菜单打开（或聚焦）迷你小窗：手动模式，不自动收起
fn open_mini(app: &AppHandle) {
    if let Some(w) = app.webview_windows().get("mini") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "mini", WebviewUrl::App("index.html#mini".into()))
        .title("额度速览")
        .inner_size(MINI_W, MINI_H)
        .decorations(false)
        .resizable(false)
        .maximizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .build();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例：重复启动时唤起已有主窗口，而不是再开一个进程
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        // 系统通知（低额度提醒走 Windows 原生 Toast，由 Rust 端发送）
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let prefs = load_prefs(app.app_handle());
            let start_ball = prefs.visible;
            app.manage(ShellState {
                prefs: Mutex::new(prefs),
                mini_flyout: Mutex::new(false),
            });

            let tray = TrayIconBuilder::with_id("quota-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("看额度 · 左键显示/隐藏主窗口，关闭窗口将驻留托盘")
                .menu(&build_tray_menu(app.app_handle())?)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "mini" => open_mini(app),
                    "ball" => toggle_ball(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    let app = tray.app_handle();
                    match event {
                        // 左键点击：切换主窗口显隐（tray-icon 在 Windows 上无 hover 回调，悬停浮窗不可行）
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } => {
                            hide_mini_flyout(app);
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
                        _ => {}
                    }
                })
                .build(app)?;

            let _ = tray; // 托盘已注册到 app，可通过 tray_by_id 取回

            // 前端事件：迷你窗内鼠标离开 → 收起浮出窗（悬浮球展开场景）
            let app_for_events = app.app_handle().clone();
            app.listen("mini-pointer-left", move |_| {
                hide_mini_flyout(&app_for_events);
            });

            // 前端事件：单击悬浮球 → 在球旁展开/收起迷你窗
            let app_for_ball = app.app_handle().clone();
            app.listen("ball-clicked", move |_| {
                let app = &app_for_ball;
                let flyout_now = shell_state(app)
                    .map(|st| *st.mini_flyout.lock().unwrap())
                    .unwrap_or(false);
                let mini_visible = app
                    .webview_windows()
                    .get("mini")
                    .map(|w| w.is_visible().unwrap_or(false))
                    .unwrap_or(false);
                if flyout_now && mini_visible {
                    hide_mini_flyout(app);
                } else if let Some(ball) = app.webview_windows().get("ball") {
                    if let (Ok(pos), Ok(size)) = (ball.outer_position(), ball.outer_size()) {
                        // 迷你窗右下角对齐到球心（全部物理坐标）
                        show_mini_at(app, pos.x as f64, (pos.y + size.height as i32 / 2) as f64);
                    }
                }
            });

            // 前端事件：主界面顶栏按钮 / 设置页开关 → 设置悬浮球显隐（payload: true/false）
            let app_for_set = app.app_handle().clone();
            app.listen("set-ball", move |event| {
                let visible = serde_json::from_str::<bool>(event.payload()).unwrap_or(false);
                set_ball(&app_for_set, visible);
            });

            // 前端事件：主界面启动时查询悬浮球当前状态
            let app_for_query = app.app_handle().clone();
            app.listen("ball-state-request", move |_| {
                broadcast_ball_state(&app_for_query);
            });

            // 前端事件：低额度系统通知，由 Rust 端发原生 Toast
            let app_for_notify = app.app_handle().clone();
            app.listen("show-notify", move |event| {
                let Ok(payload) = serde_json::from_str::<NotifyPayload>(event.payload()) else { return };
                let result = app_for_notify
                    .notification()
                    .builder()
                    .title(&payload.title)
                    .body(&payload.body)
                    .show();
                // 诊断：Toast 静默失败（如裸 exe 无 AUMID/开始菜单快捷方式）时落盘错误详情
                if let Err(e) = result {
                    if let Some(dir) = app_for_notify.path().app_config_dir().ok() {
                        let _ = std::fs::write(dir.join("notify-error.txt"), format!("{e:?}"));
                    }
                }
            });

            // 上次开着悬浮球：启动即恢复
            if start_ball {
                create_ball_window(app.app_handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    // 关窗即隐藏到托盘：进程与 WebView 保持存活，页面内的定时刷新不中断
                    let _ = window.hide();
                    api.prevent_close();
                } else if window.label() == "mini" {
                    // 迷你窗关闭按钮 = 隐藏（可再次唤起），并清除浮出标记
                    if let Some(app) = window.app_handle().try_state::<ShellState>() {
                        *app.mini_flyout.lock().unwrap() = false;
                    }
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
            if let tauri::WindowEvent::Moved(pos) = event {
                // 悬浮球拖动后记住位置（物理坐标持久化，重启还原）
                if window.label() == "ball" {
                    if let Some(st) = shell_state(window.app_handle()) {
                        let mut prefs = st.prefs.lock().unwrap();
                        prefs.x = Some(pos.x);
                        prefs.y = Some(pos.y);
                        save_prefs(window.app_handle(), &prefs);
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
