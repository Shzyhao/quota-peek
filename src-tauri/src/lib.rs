//! 桌看桌面壳：托盘常驻 + 关窗驻留 + 桌面悬浮（Live2D 桌宠 / 经典悬浮球，可切换）+ 迷你速览窗。
//! 前端逻辑全部复用 model-quota-frontend，本 crate 只做窗口与托盘的胶水。
//!
//! 已定案的限制（勿重排查）：
//! - 托盘悬停浮窗在 Windows 不可行：tray-icon 底层只上报点击、无 hover 回调；
//! - 悬浮球用 transparent 透明窗口（09-03 验证：透明不影响命中测试，点击/拖动链路全通，
//!   旧「透明窗收不到输入」结论系合成输入测试假象）。

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Listener, Manager, PhysicalPosition, State, WebviewUrl,
    WebviewWindowBuilder,
};
use tauri_plugin_notification::NotificationExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;

mod agent;
mod commands;/// 迷你窗逻辑尺寸（与 open_mini / 前端样式保持一致）
const MINI_W: f64 = 300.0;
const MINI_H: f64 = 430.0;
/// 经典悬浮球窗口尺寸（球体 60px + 辉光余量，前端 .ball 呈现圆形）
const BALL_SIZE: f64 = 76.0;
/// 桌宠窗口逻辑尺寸（Q 版半身形象，紧凑小窗）
const PET_W: f64 = 180.0;
const PET_H: f64 = 220.0;

/// WebView2 浏览器参数：wry 默认项 + 麦克风自动授权（语音对话录音）。
/// 注意：additionalBrowserArgs 会整体替换 wry 默认值，默认的 disable-features 必须带全；
/// use-fake-ui-for-media-stream 免去 WebView2 权限弹窗（麦克风仍受 Windows 系统隐私开关约束）
const BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --use-fake-ui-for-media-stream";

fn default_form() -> String {
    "pet".into()
}

/// 悬浮形态偏好：是否显示 + 物理坐标位置 + 形态（pet 桌宠 / ball 经典悬浮球），
/// 持久化到配置目录，重启保留
#[derive(Default, Clone, serde::Serialize, serde::Deserialize)]
struct BallPrefs {
    #[serde(default)]
    visible: bool,
    #[serde(default)]
    x: Option<i32>,
    #[serde(default)]
    y: Option<i32>,
    /// 悬浮形态；旧配置无此字段时默认升级为桌宠（产品定案：桌宠取代悬浮球）
    #[serde(default = "default_form")]
    form: String,
}

impl BallPrefs {
    fn is_pet(&self) -> bool {
        self.form != "ball"
    }

    /// 当前形态的窗口配置：(宽, 高, 前端路由, 标题)
    fn window_conf(&self) -> (f64, f64, &'static str, &'static str) {
        if self.is_pet() {
            (PET_W, PET_H, "index.html#pet", "桌宠")
        } else {
            (BALL_SIZE, BALL_SIZE, "index.html#ball", "额度悬浮球")
        }
    }
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
    /// 功能菜单展开态（桌宠窗向左/右延伸出菜单条）：展开期间 Moved 事件
    /// 跳过位置持久化——此时窗口原点含菜单条，不能当桌宠位置存
    menu_expanded: AtomicBool,
    /// 菜单条在左侧还是右侧（展开时按屏幕边缘空间决定）
    menu_side_left: AtomicBool,
    /// 对话气泡展开态（桌宠窗向上/向下长出气泡条）：同菜单跳过位置持久化
    bubble_expanded: AtomicBool,
    /// 气泡条在人物上方还是下方（按窗口距屏幕顶部的余量决定）
    bubble_up: AtomicBool,
    /// 当前气泡条高度（逻辑像素）：前端按气泡内容量高传过来，流式变高时增量调整
    bubble_strip: AtomicU32,
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

/// 以物理坐标锚点（窗口右下角对齐处）弹出迷你窗：已存在则移动显示，否则创建。
/// flyout=true（悬浮球单击展开）时鼠标移出自动收起；false（托盘/桌宠菜单打开）
/// 为固定模式，不随鼠标移出收起，只经关闭按钮或托盘交互消失
fn show_mini_at(app: &AppHandle, anchor_x: f64, anchor_y: f64, flyout: bool) {
    let scale = scale_factor(app);
    let (w, h) = (MINI_W * scale, MINI_H * scale);
    let x = (anchor_x - w).max(8.0);
    let y = (anchor_y - h).max(8.0);
    if let Some(win) = app.webview_windows().get("mini") {
        // 锚点/尺寸均为 Tauri 物理坐标（球 outer_position 一致），物理 set_position 对称还原
        let _ = win.set_position(PhysicalPosition::new(x as i32, y as i32));
        let _ = win.show();
    } else {
        let built = WebviewWindowBuilder::new(app, "mini", WebviewUrl::App("index.html#mini".into()))
            .title("额度速览")
            .inner_size(MINI_W, MINI_H)
            .decorations(false)
            .resizable(false)
            .maximizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            // 必须与 ball/panel 窗口一致：WebView2 的浏览器参数不一致会导致
            // 新环境静默创建失败（窗口注册了但 HWND/内容永远出不来）
            .additional_browser_args(BROWSER_ARGS)
            .position(x / scale, y / scale)
            .build();
        // 诊断：创建失败静默会表现为"点了没反应"，落盘错误与锚点供排查
        if let Err(e) = built {
            if let Some(dir) = app.path().app_config_dir().ok() {
                let _ = std::fs::write(
                    dir.join("mini-error.txt"),
                    format!("anchor=({anchor_x},{anchor_y}) scale={scale} err={e:?}"),
                );
            }
        }
    }
    if let Some(st) = shell_state(app) {
        *st.mini_flyout.lock().unwrap() = flyout;
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

/// 托盘菜单（悬浮形态开关与切换项的标签随当前状态变化，切换后整体重建）
fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let prefs = shell_state(app)
        .map(|st| st.prefs.lock().unwrap().clone())
        .unwrap_or_default();
    let ball_on = app.webview_windows().get("ball").is_some();
    let thing = if prefs.is_pet() { "桌宠" } else { "悬浮球" };
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "立即刷新", true, None::<&str>)?;
    let mini = MenuItem::with_id(app, "mini", "迷你小窗", true, None::<&str>)?;
    let ball = MenuItem::with_id(
        app,
        "ball",
        if ball_on { format!("关闭{thing}") } else { format!("打开{thing}") },
        true,
        None::<&str>,
    )?;
    let form = MenuItem::with_id(
        app,
        "form",
        if prefs.is_pet() { "切换为经典悬浮球" } else { "切换为桌宠" },
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    Menu::with_items(app, &[&show, &refresh, &mini, &ball, &form, &quit])
}

/// 创建悬浮窗（桌宠或经典球，位置：已保存的物理坐标，否则主显示器右侧偏上）。
/// transparent 透明窗口：人物/球体外的画布真正透明，消除不透明方案的深色方块底。
fn create_ball_window(app: &AppHandle) {
    let st_prefs = shell_state(app).map(|st| st.prefs.lock().unwrap().clone());
    let (w, h, url, title) = st_prefs
        .as_ref()
        .map(|p| p.window_conf())
        .unwrap_or((PET_W, PET_H, "index.html#pet", "桌宠"));
    let scale = scale_factor(app);
    let (screen_w, screen_h) = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| (m.size().width as f64, m.size().height as f64))
        .unwrap_or((1920.0, 1080.0));
    // 物理像素的窗口尺寸（偏好坐标是物理坐标系）
    let (pw, ph) = (w * scale, h * scale);
    let (x, y) = match st_prefs.as_ref().and_then(|p| p.x.zip(p.y)) {
        // 旧悬浮球（76px）时代的坐标可能把更大的桌宠窗（300×460）挤出屏幕，
        // 统一钳制到屏幕内，保证完整可见
        Some((x, y)) => (
            (x as f64).clamp(0.0, (screen_w - pw).max(0.0)),
            (y as f64).clamp(0.0, (screen_h - ph).max(0.0)),
        ),
        None => {
            // 默认位置（主显示器右侧偏上）按物理坐标计算
            (screen_w - pw - 24.0 * scale, 200.0 * scale)
        }
    };
    if let Ok(win) = WebviewWindowBuilder::new(app, "ball", WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(w, h)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .additional_browser_args(BROWSER_ARGS)
        .build()
    {
        // 偏好保存的是物理坐标（Moved 事件），builder.position 只认逻辑坐标，
        // 故创建后用物理坐标归位——与 Moved 同一坐标系，重启可精确还原
        let _ = win.set_position(PhysicalPosition::new(x as i32, y as i32));
        // 新窗从收起态开始（形态切换重建等场景下残留的展开标记会错误屏蔽位置持久化）
        if let Some(st) = shell_state(app) {
            st.menu_expanded.store(false, Ordering::SeqCst);
            st.bubble_expanded.store(false, Ordering::SeqCst);
        }
    }
}

/// 广播悬浮窗当前状态（开窗即视为开启），主界面按钮与设置页开关据此同步
fn broadcast_ball_state(app: &AppHandle) {
    let visible = app.webview_windows().get("ball").is_some();
    let _ = app.emit("ball-state-changed", visible);
}

/// 广播当前悬浮形态（pet/ball），设置页形态选择据此同步
fn broadcast_ball_form(app: &AppHandle) {
    let form = shell_state(app)
        .map(|st| st.prefs.lock().unwrap().form.clone())
        .unwrap_or_else(default_form);
    let _ = app.emit("ball-form-changed", form);
}

/// 切换悬浮形态（pet ↔ ball）：持久化偏好；若悬浮窗开着则按新形态重建，
/// 随后重建托盘菜单刷新标签、广播形态变化
fn set_ball_form(app: &AppHandle, form: &str) {
    let Some(st) = shell_state(app) else { return };
    let form = if form == "ball" { "ball".to_string() } else { default_form() };
    let was_open = app.webview_windows().get("ball").is_some();
    {
        let mut prefs = st.prefs.lock().unwrap();
        prefs.form = form;
        save_prefs(app, &prefs);
    }
    if was_open {
        if let Some(w) = app.webview_windows().get("ball") {
            let _ = w.destroy();
        }
        create_ball_window(app);
    }
    if let Some(tray) = app.tray_by_id("quota-tray") {
        if let Ok(menu) = build_tray_menu(app) {
            let _ = tray.set_menu(Some(menu));
        }
    }
    broadcast_ball_form(app);
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

/// 功能弹窗定义：(窗口 label, 路由, 逻辑宽, 逻辑高, 标题)
fn panel_conf(panel: &str) -> Option<(&'static str, &'static str, f64, f64, &'static str)> {
    match panel {
        "chat" => Some(("panel-chat", "index.html#panel-chat", 450.0, 560.0, "桌看 · 对话")),
        "analysis" => Some(("panel-analysis", "index.html#panel-analysis", 480.0, 560.0, "桌看 · 文件分析")),
        "schedule" => Some(("panel-schedule", "index.html#panel-schedule", 500.0, 620.0, "桌看 · 日程")),
        _ => None,
    }
}

/// 全部功能弹窗 label（互斥切换与批体收起用）
const PANEL_LABELS: [&str; 3] = ["panel-chat", "panel-analysis", "panel-schedule"];

/// 计算功能弹窗锚定桌宠旁的物理坐标：优先右侧，放不下换左侧，整体钳制屏幕内
fn panel_anchor(app: &AppHandle, w: f64, h: f64) -> Option<(f64, f64)> {
    let windows = app.webview_windows();
    let pet = windows.get("ball")?;
    let scale = scale_factor(app);
    let (screen_w, screen_h) = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| (m.size().width as f64, m.size().height as f64))
        .unwrap_or((1920.0, 1080.0));
    let pos = pet.outer_position().ok()?;
    let size = pet.outer_size().ok()?;
    let (px, py, pw) = (pos.x as f64, pos.y as f64, size.width as f64);
    let mut x = px + pw + 8.0 * scale;
    if x + w * scale > screen_w - 8.0 {
        x = px - w * scale - 8.0 * scale;
    }
    let x = x.clamp(8.0, (screen_w - w * scale - 8.0).max(8.0));
    let y = py.clamp(8.0, (screen_h - h * scale - 8.0).max(8.0));
    Some((x, y))
}

/// 打开/收起桌宠旁的功能弹窗（再次触发同面板 = 收起；各面板互斥）。
/// 由桌宠气泡菜单的 pet-panel 事件触发，payload: "chat" / "analysis" / "schedule"。
/// force_show=true（语音对话入口）：面板已可见时仅保持显示，绝不收起
fn open_panel(app: &AppHandle, panel: &str, force_show: bool) {
    let Some((label, url, w, h, title)) = panel_conf(panel) else { return };
    // 互斥：打开一个面板时收起其余面板
    for other in PANEL_LABELS {
        if other != label {
            if let Some(o) = app.webview_windows().get(other) {
                let _ = o.hide();
            }
        }
    }
    let scale = scale_factor(app);
    if let Some(win) = app.webview_windows().get(label) {
        if win.is_visible().unwrap_or(false) {
            if !force_show {
                let _ = win.hide();
                return;
            }
        } else {
            let _ = win.show();
        }
        if let Some((x, y)) = panel_anchor(app, w, h) {
            let _ = win.set_position(PhysicalPosition::new(x as i32, y as i32));
        }
        return;
    }
    let Some((x, y)) = panel_anchor(app, w, h) else { return };
    let _ = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(w, h)
        .resizable(false)
        .maximizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .additional_browser_args(BROWSER_ARGS)
        .position(x / scale, y / scale)
        .build();
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.webview_windows().get("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 桌宠气泡播报是否可用（ball 窗存在且当前形态是 pet）：
/// 日程提醒据此选择播报通道（桌宠气泡 or 系统 Toast），供 commands 调度线程调用
pub fn pet_bubble_available(app: &AppHandle) -> bool {
    app.webview_windows().get("ball").is_some()
        && shell_state(app)
            .map(|st| st.prefs.lock().unwrap().is_pet())
            .unwrap_or(true)
}

/// 功能菜单条宽度（逻辑像素）：展开时桌宠窗向侧边延伸的宽度
const MENU_STRIP_W: f64 = 160.0;

/// 气泡区高度兜底值（逻辑像素）：前端未传延伸高度时使用。
/// 延伸高度随内容自适应（前端量测传入，钳制 0–120）；小气泡浮在画布固有留白里
/// 不延伸窗口，只有超过留白才向上/向下长，气泡底边始终离人物头顶约 10px
const BUBBLE_STRIP_H: f64 = 130.0;

/// 桌宠功能菜单展开/收起：展开时窗口向左延伸出菜单条（左侧空间不足则向右），
/// 人物画布由前端 CSS 平移保持在原屏幕位置，收起时窗口还原。
/// 展开期间 Moved 事件跳过位置持久化（此时窗口原点含菜单条，不能当桌宠位置存）；
/// 收起在恢复位置之后置回标记，收起产生的 Moved 会把正确位置存回去。
#[tauri::command]
fn pet_menu_layout(state: State<'_, ShellState>, app: AppHandle, expand: bool) -> Result<String, String> {
    let Some(win) = app.get_webview_window("ball") else { return Err("桌宠窗口不存在".into()) };
    let is_pet = shell_state(&app)
        .map(|st| st.prefs.lock().unwrap().is_pet())
        .unwrap_or(true);
    if !is_pet {
        return Err("当前形态没有功能菜单".into());
    }
    let scale = win.scale_factor().unwrap_or(1.0);
    let strip = (MENU_STRIP_W * scale).round() as i32;
    if expand {
        if state.menu_expanded.load(Ordering::SeqCst) {
            return Ok(if state.menu_side_left.load(Ordering::SeqCst) { "left" } else { "right" }.into());
        }
        let pos = win.outer_position().map_err(|e| e.to_string())?;
        let side_left = pos.x >= strip + 8;
        state.menu_side_left.store(side_left, Ordering::SeqCst);
        state.menu_expanded.store(true, Ordering::SeqCst);
        win.set_size(tauri::LogicalSize::new(PET_W + MENU_STRIP_W, PET_H))
            .map_err(|e| e.to_string())?;
        if side_left {
            win.set_position(tauri::PhysicalPosition::new(pos.x - strip, pos.y))
                .map_err(|e| e.to_string())?;
        }
        Ok(if side_left { "left" } else { "right" }.into())
    } else {
        let was_left = state.menu_side_left.load(Ordering::SeqCst);
        state.menu_expanded.store(false, Ordering::SeqCst);
        let pos = win.outer_position().map_err(|e| e.to_string())?;
        win.set_size(tauri::LogicalSize::new(PET_W, PET_H))
            .map_err(|e| e.to_string())?;
        if was_left {
            win.set_position(tauri::PhysicalPosition::new(pos.x + strip, pos.y))
                .map_err(|e| e.to_string())?;
        }
        Ok("close".into())
    }
}

/// 桌宠对话气泡展开/收起：显示气泡时窗口向上长出气泡条（顶部空间不足则向下），
/// 人物画布经 CSS 平移保持在原屏幕位置，气泡绝不遮挡人物。展开期间 Moved 事件
/// 跳过位置持久化（窗口原点含气泡条，不能当桌宠位置存）；收起先清标记再还原，
/// 让收起产生的 Moved 把正确位置存回去。与 pet_menu_layout 互斥使用（前端保证）。
#[tauri::command]
fn pet_bubble_layout(state: State<'_, ShellState>, app: AppHandle, expand: bool, strip: Option<f64>) -> Result<String, String> {
    let Some(win) = app.get_webview_window("ball") else { return Err("桌宠窗口不存在".into()) };
    let is_pet = shell_state(&app)
        .map(|st| st.prefs.lock().unwrap().is_pet())
        .unwrap_or(true);
    if !is_pet {
        return Err("当前形态没有对话气泡".into());
    }
    let scale = win.scale_factor().unwrap_or(1.0);
    let want = strip.unwrap_or(BUBBLE_STRIP_H).clamp(0.0, 120.0);
    if expand {
        if state.bubble_expanded.load(Ordering::SeqCst) {
            // 已展开：流式内容变高/变矮 → 按差量增量调整尺寸与位置
            let old = f64::from(state.bubble_strip.load(Ordering::SeqCst));
            let delta = want - old;
            if delta.abs() < 1.0 {
                return Ok(if state.bubble_up.load(Ordering::SeqCst) { "up" } else { "down" }.into());
            }
            state.bubble_strip.store(want.round() as u32, Ordering::SeqCst);
            win.set_size(tauri::LogicalSize::new(PET_W, PET_H + want))
                .map_err(|e| e.to_string())?;
            if state.bubble_up.load(Ordering::SeqCst) {
                let pos = win.outer_position().map_err(|e| e.to_string())?;
                win.set_position(tauri::PhysicalPosition::new(pos.x, pos.y - (delta * scale).round() as i32))
                    .map_err(|e| e.to_string())?;
            }
            return Ok(if state.bubble_up.load(Ordering::SeqCst) { "up" } else { "down" }.into());
        }
        let strip_px = (want * scale).round() as i32;
        let pos = win.outer_position().map_err(|e| e.to_string())?;
        let up = pos.y >= strip_px + 8;
        state.bubble_strip.store(want.round() as u32, Ordering::SeqCst);
        state.bubble_up.store(up, Ordering::SeqCst);
        state.bubble_expanded.store(true, Ordering::SeqCst);
        win.set_size(tauri::LogicalSize::new(PET_W, PET_H + want))
            .map_err(|e| e.to_string())?;
        if up {
            win.set_position(tauri::PhysicalPosition::new(pos.x, pos.y - strip_px))
                .map_err(|e| e.to_string())?;
        }
        Ok(if up { "up" } else { "down" }.into())
    } else {
        if !state.bubble_expanded.load(Ordering::SeqCst) {
            return Ok("close".into());
        }
        let was_up = state.bubble_up.load(Ordering::SeqCst);
        let strip_px = (f64::from(state.bubble_strip.load(Ordering::SeqCst)) * scale).round() as i32;
        state.bubble_expanded.store(false, Ordering::SeqCst);
        let pos = win.outer_position().map_err(|e| e.to_string())?;
        win.set_size(tauri::LogicalSize::new(PET_W, PET_H))
            .map_err(|e| e.to_string())?;
        if was_up {
            win.set_position(tauri::PhysicalPosition::new(pos.x, pos.y + strip_px))
                .map_err(|e| e.to_string())?;
        }
        Ok("close".into())
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
        // 原生文件选择对话框（文件分析模块选文件，返回绝对路径）
        .plugin(tauri_plugin_dialog::init())
        // 桌宠 AI 对话 + 文件分析命令（流式 Channel + 凭据管理器密钥 + 连接测试 + 轻析管线）
        // 额度密钥（quota_secret_*）/ 后端定时刷新调度 / 托盘动态图标同走命令层
        .invoke_handler(tauri::generate_handler![
            commands::chat_get_config,
            commands::chat_save_config,
            commands::chat_set_key,
            commands::chat_has_key,
            commands::chat_delete_key,
            commands::chat_test_connection,
            commands::chat_send,
            commands::chat_cancel,
            commands::analyze_files,
            commands::analyze_cancel,
            commands::analyze_get_history,
            commands::analyze_delete_history,
            commands::analyze_clear_history,
            commands::pet_import_model,
            commands::quota_secret_set,
            commands::quota_secret_get,
            commands::quota_secret_has,
            commands::quota_secret_delete,
            commands::voice_secret_set,
            commands::voice_secret_has,
            commands::voice_secret_delete,
            commands::voice_transcribe,
            commands::voice_speak,
            commands::set_refresh_schedule,
            commands::update_tray_status,
            commands::set_schedule_reminders,
            commands::chat_read_file,
            pet_menu_layout,
            pet_bubble_layout,
            agent::agent_send,
            agent::agent_resolve,
            agent::agent_cancel
        ])
        .setup(|app| {
            let prefs = load_prefs(app.app_handle());
            let start_ball = prefs.visible;
            app.manage(ShellState {
                prefs: Mutex::new(prefs),
                mini_flyout: Mutex::new(false),
                menu_expanded: AtomicBool::new(false),
                menu_side_left: AtomicBool::new(true),
                bubble_expanded: AtomicBool::new(false),
                bubble_up: AtomicBool::new(true),
                bubble_strip: AtomicU32::new(0),
            });
            // 桌宠 AI 对话状态（配置 + 凭据 + 流式取消标志）
            app.manage(commands::ChatState::new(app.app_handle()));

            // 后端定时刷新调度：Rust 常驻线程持有时钟（配置持久化 refresh.json，重启恢复），
            // 到点 emit backend-refresh-due 由主窗执行既有前端刷新编排
            let refresh_prefs = commands::load_refresh_prefs(app.app_handle());
            let sched = std::sync::Arc::new(commands::RefreshSchedule {
                prefs: Mutex::new(refresh_prefs),
                seq: Mutex::new(0),
                cond: std::sync::Condvar::new(),
            });
            commands::spawn_refresh_scheduler(app.app_handle().clone(), sched.clone());
            app.manage(sched);

            // 日程提醒调度：恢复 schedule.json（队列 + 已触发集合）后启动常驻线程，
            // 到点桌宠气泡播报（pet_bubble_available 为真）或回退系统通知
            let reminder = std::sync::Arc::new(commands::ReminderState::default());
            commands::load_persisted_schedule(app.app_handle(), &reminder);
            commands::spawn_schedule_reminder(app.app_handle().clone(), reminder.clone());
            app.manage(reminder);

            // Agent 状态（单飞循环 + 待确认调用 + 审计）
            app.manage(agent::AgentState::new());

            let tray = TrayIconBuilder::with_id("quota-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("桌看 · 左键显示/隐藏主窗口，关闭窗口将驻留托盘")
                .menu(&build_tray_menu(app.app_handle())?)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    // 立即刷新：与后端定时调度同一事件通道，由主窗执行刷新编排
                    "refresh" => {
                        let _ = app.emit("backend-refresh-due", ());
                    }
                    "mini" => open_mini(app),
                    "ball" => toggle_ball(app),
                    "form" => {
                        let cur_is_pet = shell_state(app)
                            .map(|st| st.prefs.lock().unwrap().is_pet())
                            .unwrap_or(true);
                        set_ball_form(app, if cur_is_pet { "ball" } else { "pet" });
                    }
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

            // 前端事件：单击悬浮球 → 在球旁展开/收起迷你窗（飞出模式：鼠标移出自动收起）
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
                        show_mini_at(app, pos.x as f64, (pos.y + size.height as i32 / 2) as f64, true);
                    }
                }
            });

            // 前端事件：桌宠菜单「额度速览」→ 锚定桌宠旁打开迷你窗（固定模式：
            // 不随鼠标移出收起——菜单点开后迷你窗恰好出现在原菜单位置，飞出语义
            // 会因鼠标移出被立刻收起，表现为"点了没反应"）。等菜单收起完成后再开窗，
            // 避免读到收起过渡中的窗口位置；桌宠未开时回退托盘式打开
            let app_for_quota = app.app_handle().clone();
            app.listen("pet-quota", move |_| {
                let app = &app_for_quota;
                if let Some(ball) = app.webview_windows().get("ball") {
                    if let (Ok(pos), Ok(size)) = (ball.outer_position(), ball.outer_size()) {
                        show_mini_at(app, pos.x as f64, (pos.y + size.height as i32 / 2) as f64, false);
                        return;
                    }
                }
                open_mini(app);
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

            // 前端事件：设置页形态选择 → 切换桌宠/经典悬浮球（payload: "pet"/"ball"）
            let app_for_form = app.app_handle().clone();
            app.listen("set-ball-form", move |event| {
                let form = serde_json::from_str::<String>(event.payload()).unwrap_or_default();
                set_ball_form(&app_for_form, &form);
            });

            // 前端事件：主界面启动时查询当前悬浮形态
            let app_for_form_query = app.app_handle().clone();
            app.listen("ball-form-request", move |_| {
                broadcast_ball_form(&app_for_form_query);
            });

            // 前端事件：桌宠气泡菜单 → 打开/收起桌宠旁的功能弹窗（payload: "chat"/"analysis"）
            let app_for_panel = app.app_handle().clone();
            app.listen("pet-panel", move |event| {
                let panel = serde_json::from_str::<String>(event.payload()).unwrap_or_default();
                open_panel(&app_for_panel, &panel, false);
            });

            // 前端事件：桌宠菜单「语音对话」→ 仅显示（不 toggle 收起）聊天面板，
            // 麦克风自动激活由前端经 localStorage 待激活标记驱动
            let app_for_voice = app.app_handle().clone();
            app.listen("pet-voice-chat", move |_event| {
                open_panel(&app_for_voice, "chat", true);
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
                } else if window.label().starts_with("panel-") {
                    // 功能弹窗关闭按钮 = 隐藏（桌宠菜单可再次唤起）
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
            if let tauri::WindowEvent::Moved(pos) = event {
                // 悬浮球拖动后记住位置（物理坐标持久化，重启还原）；
                // 功能菜单/对话气泡展开期间窗口原点含延伸条，跳过持久化（收起时会存回正确位置）
                if window.label() == "ball" {
                    let expanded = window
                        .app_handle()
                        .try_state::<ShellState>()
                        .map(|st| {
                            st.menu_expanded.load(Ordering::SeqCst)
                                || st.bubble_expanded.load(Ordering::SeqCst)
                        })
                        .unwrap_or(false);
                    if !expanded {
                        if let Some(st) = shell_state(window.app_handle()) {
                            let mut prefs = st.prefs.lock().unwrap();
                            prefs.x = Some(pos.x);
                            prefs.y = Some(pos.y);
                            save_prefs(window.app_handle(), &prefs);
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
