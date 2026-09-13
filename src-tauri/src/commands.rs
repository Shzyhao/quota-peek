//! 桌宠命令层：AI 对话的 Tauri commands（Phase 2）。
//! 底层复用轻析（liteai-analyzer）的库 crate（liteai-model 流式客户端 /
//! liteai-config 凭据管理），本文件只做 IPC 桥接；密钥永不落盘明文，
//! 存 Windows 凭据管理器（service 与轻析隔离）。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use liteai_config::{ApiProfile, KeyringStore};
use liteai_core::{
    AnalysisPipeline, ChatMessage, ChatRequest, ChatUsage, FileMeta, ModelClient, ModelConfig,
    ModelError, OutputConfig, OutputMode, PromptBuilder, SecretStore,
};
use liteai_model::OpenAiClient;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

/// 凭据管理器 service 名（与轻析的 com.liteai.analyzer 隔离）
const KEYRING_SERVICE: &str = "com.modelquota.desktop";
/// 凭据条目键名前缀，与轻析约定一致：`api_key:<profile_id>`
const KEY_PREFIX: &str = "api_key:";
/// 桌宠对话固定温度（与轻析分析管线一致）
const CHAT_TEMPERATURE: f32 = 0.7;

/// 内置默认人设（用户可在配置中覆盖）
pub const DEFAULT_PERSONA: &str = "你是用户的桌面宠物小助手，性格活泼友善、回复简洁。\
你常驻在用户的 Windows 桌面上，可以陪聊、回答问题，也能帮用户留意大模型额度状态。";

/// 桌宠对话配置：多套 OpenAI 兼容模型 + 人设，存 app_config_dir/pet-config.json
#[derive(Default, Clone, Serialize, Deserialize)]
pub struct PetConfig {
    #[serde(default)]
    pub profiles: Vec<ApiProfile>,
    #[serde(default)]
    pub active_profile_id: Option<String>,
    /// 桌宠人设（system prompt）；空串用内置默认
    #[serde(default)]
    pub persona: String,
}

/// 对话流事件（Channel 推送到前端；type 为 snake_case，与前端约定一致）
#[derive(Clone, Serialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum ChatEvent {
    Token { text: String },
    Done { usage: Option<ChatUsage> },
    Error { message: String },
    Cancelled,
}

pub struct ChatState {
    config: Mutex<PetConfig>,
    secrets: KeyringStore,
    /// 当前对话取消标志（Arc 供 spawned 任务持有）
    cancel: Arc<AtomicBool>,
    running: AtomicBool,
    /// 文件分析取消标志（与对话取消相互独立）
    analyze_cancel: Arc<AtomicBool>,
    analyze_running: AtomicBool,
}

impl ChatState {
    pub fn new(app: &AppHandle) -> Self {
        Self {
            config: Mutex::new(load_pet_config(app)),
            secrets: KeyringStore::new(KEYRING_SERVICE),
            cancel: Arc::new(AtomicBool::new(false)),
            running: AtomicBool::new(false),
            analyze_cancel: Arc::new(AtomicBool::new(false)),
            analyze_running: AtomicBool::new(false),
        }
    }
}

fn pet_config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("pet-config.json"))
}

fn load_pet_config(app: &AppHandle) -> PetConfig {
    pet_config_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn persist_pet_config(app: &AppHandle, cfg: &PetConfig) -> Result<(), String> {
    let path = pet_config_path(app).ok_or("无法定位配置目录")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string(cfg).map_err(|e| e.to_string())?;
    std::fs::write(path, raw).map_err(|e| e.to_string())
}

fn model_error_message(e: ModelError) -> String {
    match e {
        ModelError::Cancelled => "请求已取消".into(),
        other => other.to_string(),
    }
}

/// 取当前激活 profile 与对应密钥，供对话 / 连接测试 / 文件分析共用
fn active_profile_with_key(state: &ChatState) -> Result<(ApiProfile, String), String> {
    let cfg = state.config.lock().unwrap();
    let profile = cfg
        .profiles
        .iter()
        .find(|p| Some(&p.id) == cfg.active_profile_id.as_ref())
        .cloned()
        .ok_or("没有可用的模型配置，请先在对话页添加")?;
    let key = state
        .secrets
        .get(&format!("{KEY_PREFIX}{}", profile.id))
        .map_err(|e| e.to_string())?
        .ok_or("该配置未设置 API Key")?;
    Ok((profile, key))
}

// ——— 配置 ———

#[tauri::command]
pub fn chat_get_config(state: State<'_, ChatState>) -> PetConfig {
    state.config.lock().unwrap().clone()
}

#[tauri::command]
pub fn chat_save_config(app: AppHandle, state: State<'_, ChatState>, cfg: PetConfig) -> Result<(), String> {
    persist_pet_config(&app, &cfg)?;
    *state.config.lock().unwrap() = cfg;
    Ok(())
}

// ——— 密钥（Windows 凭据管理器） ———

#[tauri::command]
pub fn chat_set_key(state: State<'_, ChatState>, profile_id: String, key: String) -> Result<(), String> {
    state
        .secrets
        .set(&format!("{KEY_PREFIX}{profile_id}"), &key)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn chat_has_key(state: State<'_, ChatState>, profile_id: String) -> Result<bool, String> {
    state
        .secrets
        .get(&format!("{KEY_PREFIX}{profile_id}"))
        .map(|k| k.is_some())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn chat_delete_key(state: State<'_, ChatState>, profile_id: String) -> Result<(), String> {
    state
        .secrets
        .delete(&format!("{KEY_PREFIX}{profile_id}"))
        .map_err(|e| e.to_string())
}

// ——— 连接测试（连通性 + 余额） ———

#[tauri::command]
pub async fn chat_test_connection(
    state: State<'_, ChatState>,
) -> Result<serde_json::Value, String> {
    let (profile, key) = active_profile_with_key(&state)?;
    let client = OpenAiClient::new(key, profile.base_url.clone());
    let mut result = serde_json::json!({
        "ok": false,
        "message": "",
        "profile": profile.name,
        "model": profile.model,
    });
    // 连通性优先：ping 失败直接返回；成功则尽力补余额（平台不支持时优雅降级）
    match client.ping(&profile.base_url, &profile.model).await {
        Err(e) => {
            result["message"] = model_error_message(e).into();
            return Ok(result);
        }
        Ok(()) => {
            result["ok"] = true.into();
            result["message"] = "连接成功".into();
        }
    }
    if let Ok(balance) = client.check_balance().await {
        if balance.is_available {
            let text = balance
                .balance_infos
                .iter()
                .map(|b| format!("{} {}", b.total_balance, b.currency))
                .collect::<Vec<_>>()
                .join(" / ");
            result["balance"] = text.into();
        }
    }
    Ok(result)
}

// ——— 对话（流式） ———

/// 发起一次对话：立即返回，token 流经 Channel 推送。
/// `messages` 为前端拼好的对话历史（可含额度上下文 system 消息），
/// 人设 system 消息由本命令在头部注入。
#[tauri::command]
pub fn chat_send(
    app: AppHandle,
    state: State<'_, ChatState>,
    messages: Vec<ChatMessage>,
    on_event: Channel<ChatEvent>,
) -> Result<(), String> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("已有对话正在进行".into());
    }
    let (profile, key) = active_profile_with_key(&state)?;
    let persona = {
        let cfg = state.config.lock().unwrap();
        let p = cfg.persona.trim().to_string();
        if p.is_empty() { DEFAULT_PERSONA.to_string() } else { p }
    };

    state.cancel.store(false, Ordering::SeqCst);
    let cancel = state.cancel.clone();
    let app_for_done = app.clone();

    tauri::async_runtime::spawn(async move {
        // 人设注入在对话历史最前
        let mut full = vec![ChatMessage { role: "system".into(), content: persona }];
        full.extend(messages);
        let req = ChatRequest {
            base_url: profile.base_url.clone(),
            model: profile.model.clone(),
            messages: full,
            temperature: CHAT_TEMPERATURE,
        };
        let client = OpenAiClient::new(key, profile.base_url);
        // on_token 返回 Err 表示取消；Channel send 失败（窗口已关）也视为取消
        let mut on_token = |text: String| -> Result<(), ModelError> {
            if cancel.load(Ordering::SeqCst) {
                return Err(ModelError::Cancelled);
            }
            on_event
                .send(ChatEvent::Token { text })
                .map_err(|_| ModelError::Cancelled)
        };
        let outcome = client.stream_chat(&req, &mut on_token).await;
        let event = match outcome {
            Ok(usage) => ChatEvent::Done { usage: Some(usage) },
            Err(ModelError::Cancelled) => ChatEvent::Cancelled,
            Err(e) => ChatEvent::Error { message: model_error_message(e) },
        };
        let _ = on_event.send(event);
        // 复位 running（窗口可能已销毁，State 取不到，用 app 重新取）
        if let Some(st) = app_for_done.try_state::<ChatState>() {
            st.running.store(false, Ordering::SeqCst);
        }
    });
    Ok(())
}

#[tauri::command]
pub fn chat_cancel(state: State<'_, ChatState>) -> Result<(), String> {
    state.cancel.store(true, Ordering::SeqCst);
    Ok(())
}

// ——— 文件分析（复用轻析管线：解析 → prompt → 流式分析 → 落盘/历史） ———
// PipelineEvent 的 serde tag 无 rename，前端按 PascalCase（Tokens/FileDone/…）判别。

/// 桌宠版分析模板：内置「内容摘要」为底，可选附加用户自定义指令
fn analysis_prompt(custom: Option<String>) -> (String, String) {
    let mut templates = liteai_config::builtin_templates();
    let base = templates.remove(0); // 内容摘要
    let extra = custom.unwrap_or_default();
    let user_tpl = if extra.trim().is_empty() {
        base.prompt
    } else {
        format!(
            "{extra}\n\n文件名：{{filename}}\n\n文件内容：\n{{content}}\n\n请用 Markdown 排版输出分析结果。"
        )
    };
    (base.system, user_tpl)
}

/// 白名单过滤 + 文件元信息收集（不存在的路径静默跳过）
fn resolve_files(paths: &[String]) -> Vec<FileMeta> {
    let whitelist = liteai_config::store::default_whitelist();
    let mut out = Vec::new();
    for p in paths {
        let path = std::path::Path::new(p);
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase());
        let allowed = ext
            .as_deref()
            .map(|e| whitelist.iter().any(|w| w == e))
            .unwrap_or(false);
        if allowed {
            if let Ok(m) = FileMeta::from_path(path) {
                out.push(m);
            }
        }
    }
    out
}

#[tauri::command]
pub fn analyze_files(
    app: AppHandle,
    state: State<'_, ChatState>,
    paths: Vec<String>,
    save: bool,
    custom: Option<String>,
    on_event: Channel<liteai_core::PipelineEvent>,
) -> Result<(), String> {
    if state.analyze_running.swap(true, Ordering::SeqCst) {
        return Err("已有分析正在进行".into());
    }
    let (profile, key) = active_profile_with_key(&state)?;
    let files = resolve_files(&paths);
    if files.is_empty() {
        state.analyze_running.store(false, Ordering::SeqCst);
        return Err("没有符合白名单的可分析文件（支持 txt/md/pdf/xlsx/docx/csv/json/代码文件等）".into());
    }

    let (system, user_tpl) = analysis_prompt(custom);
    let pipeline = AnalysisPipeline {
        parsers: liteai_parsers::default_registry(),
        model: Box::new(OpenAiClient::new(key, profile.base_url.clone())),
        md_serializer: Box::new(liteai_output::MarkdownSerializer),
        docx_serializer: None,
        xlsx_serializer: None,
        prompt: PromptBuilder::new(system, user_tpl.clone()),
    };
    let out_cfg = OutputConfig {
        // save=true：UI 流式显示 + .ai.md 落盘到源文件旁；false 仅 UI
        mode: if save { OutputMode::Both } else { OutputMode::UiOnly },
        out_dir: None,
        export_docx: false,
        export_xlsx: false,
    };
    let model_cfg = ModelConfig { base_url: profile.base_url.clone(), model: profile.model.clone() };

    state.analyze_cancel.store(false, Ordering::SeqCst);
    let cancel = state.analyze_cancel.clone();
    let config_dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let events = on_event;
    let app_for_done = app.clone();

    tauri::async_runtime::spawn(async move {
        let outcome = pipeline
            .analyze_batch(files, &model_cfg, &out_cfg, &mut |ev| {
                events.send(ev).map_err(|_| ())
            }, Some(&cancel))
            .await;
        // 逐文件写历史（与轻析同结构，目录在桌宠配置目录下，互不干扰）
        if let Ok(outcome) = &outcome {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            for r in &outcome.results {
                let entry = liteai_config::HistoryEntry {
                    id: format!("h{now}-{}", r.file.file_name.replace(|c: char| !c.is_ascii_alphanumeric(), "_")),
                    timestamp_ms: now,
                    source_file: r.file.path.display().to_string(),
                    template: "桌宠分析".into(),
                    analysis: r.analysis.clone(),
                    output_files: r.output_path.clone().into_iter().map(|p| p.display().to_string()).collect(),
                    prompt_tokens: r.usage.as_ref().map(|u| u.prompt_tokens).unwrap_or(0),
                    completion_tokens: r.usage.as_ref().map(|u| u.completion_tokens).unwrap_or(0),
                };
                let _ = liteai_config::append_history(&config_dir, entry);
            }
        }
        if let Some(st) = app_for_done.try_state::<ChatState>() {
            st.analyze_running.store(false, Ordering::SeqCst);
        }
    });
    Ok(())
}

#[tauri::command]
pub fn analyze_cancel(state: State<'_, ChatState>) -> Result<(), String> {
    state.analyze_cancel.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn analyze_get_history(app: AppHandle) -> Vec<liteai_config::HistoryEntry> {
    let dir = app.path().app_config_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    liteai_config::load_history(&dir)
}

#[tauri::command]
pub fn analyze_delete_history(app: AppHandle, id: String) -> Result<(), String> {
    let dir = app.path().app_config_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    liteai_config::delete_history_entry(&dir, &id)
}

// ——— 自定义 Live2D 形象导入 ———

/// 递归复制目录（Live2D 模型是多文件结构：moc + 贴图 + 动作）
fn copy_dir_recursive(src: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        let target = dest.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 在模型目录中查找入口文件：优先 *.model3.json（Cubism 4），其次 model.json（Cubism 2）。
/// 限制 3 层深度，避免误扫贴图子目录。
fn find_model_entry(dir: &std::path::Path) -> Option<PathBuf> {
    let mut stack = vec![(dir.to_path_buf(), 0)];
    let mut model3: Option<PathBuf> = None;
    let mut model2: Option<PathBuf> = None;
    while let Some((d, depth)) = stack.pop() {
        if depth > 3 {
            continue;
        }
        let entries = std::fs::read_dir(&d).ok()?;
        for entry in entries.flatten() {
            let ty = entry.file_type().ok()?;
            let path = entry.path();
            if ty.is_dir() {
                stack.push((path, depth + 1));
            } else {
                let name = path.file_name()?.to_string_lossy().to_lowercase();
                if model3.is_none() && name.ends_with("model3.json") {
                    model3 = Some(path.clone());
                } else if model2.is_none() && name == "model.json" {
                    model2 = Some(path);
                }
            }
        }
    }
    model3.or(model2).map(|p| p.strip_prefix(dir).unwrap_or(&p).to_path_buf())
}

/// 导入用户自选的 Live2D 模型文件夹：复制到 app_config_dir/pet-models/<名>/，
/// 返回 { name, abs_path, runtime }（前端经 asset 协议加载 abs_path）。
#[tauri::command]
pub fn pet_import_model(app: AppHandle, src: String) -> Result<serde_json::Value, String> {
    let src_path = PathBuf::from(&src);
    if !src_path.exists() {
        return Err("所选路径不存在".into());
    }
    // 允许直接选模型入口文件或其所在目录
    let dir = if src_path.is_file() {
        src_path.parent().ok_or("无效路径")?.to_path_buf()
    } else {
        src_path
    };
    let dir_name = dir
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or("无效目录名")?;
    let base = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("pet-models");
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let mut dest = base.join(&dir_name);
    let mut n = 1;
    while dest.exists() {
        n += 1;
        dest = base.join(format!("{}-{}", dir_name, n));
    }
    copy_dir_recursive(&dir, &dest)?;
    let entry = find_model_entry(&dest).ok_or("所选目录中未找到 model3.json 或 model.json 入口文件")?;
    let runtime = if entry.to_string_lossy().to_lowercase().ends_with("model3.json") {
        "cubism4"
    } else {
        "cubism2"
    };
    Ok(serde_json::json!({
        "name": dest.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| dir_name.clone()),
        "abs_path": dest.join(entry).to_string_lossy(),
        "runtime": runtime,
    }))
}

#[tauri::command]
pub fn analyze_clear_history(app: AppHandle) -> Result<(), String> {
    let dir = app.path().app_config_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    liteai_config::clear_history(&dir)
}
