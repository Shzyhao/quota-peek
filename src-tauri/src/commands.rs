//! 桌宠命令层：AI 对话的 Tauri commands（Phase 2）。
//! 底层复用轻析（liteai-analyzer）的库 crate（liteai-model 流式客户端 /
//! liteai-config 凭据管理），本文件只做 IPC 桥接；密钥永不落盘明文，
//! 存 Windows 凭据管理器（service 与轻析隔离）。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use liteai_config::KeyringStore;
use liteai_core::{
    AnalysisPipeline, ChatMessage, ChatRequest, ChatUsage, FileMeta, ModelClient, ModelConfig,
    ModelError, OutputConfig, OutputMode, PromptBuilder, SecretStore,
};
use liteai_model::OpenAiClient;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

/// 凭据管理器 service 名（与轻析的 com.liteai.analyzer 隔离）
const KEYRING_SERVICE: &str = "com.modelquota.desktop";
/// 凭据条目键名前缀，与轻析约定一致：`api_key:<profile_id>`
const KEY_PREFIX: &str = "api_key:";
/// 桌宠对话固定温度（与轻析分析管线一致）
const CHAT_TEMPERATURE: f32 = 0.7;

/// 内置默认人设（用户可在配置中覆盖）
pub const DEFAULT_PERSONA: &str = "你是用户的桌面宠物小助手，性格活泼友善、回复简洁。\
你常驻在用户的 Windows 桌面上，可以陪聊、回答问题，也能帮用户留意大模型额度状态。";

/// 模型供应商配置：一个供应商可预设多个模型（第一个为默认）。
/// `model` 是旧版单模型字段，仅作读取兼容（加载时并入 models，不再写出依赖）。
#[derive(Default, Clone, Serialize, Deserialize)]
pub struct ModelProfile {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub models: Vec<String>,
}

impl ModelProfile {
    /// 生效模型：models 优先（第一个为默认），回退旧 model 字段
    pub fn effective_model(&self) -> Option<&str> {
        self.models
            .iter()
            .find(|m| !m.trim().is_empty())
            .map(String::as_str)
            .filter(|m| !m.is_empty())
            .or(if self.model.trim().is_empty() { None } else { Some(self.model.as_str()) })
    }
}

/// 桌宠对话配置：多模型供应商 + 当前选中 + 人设，存 app_config_dir/pet-config.json
#[derive(Default, Clone, Serialize, Deserialize)]
pub struct PetConfig {
    #[serde(default)]
    pub profiles: Vec<ModelProfile>,
    #[serde(default)]
    pub active_profile_id: Option<String>,
    /// 当前选中的具体模型名（须属于 active profile 的 models；空 = 该供应商默认模型）
    #[serde(default)]
    pub active_model: Option<String>,
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
    let mut cfg = pet_config_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<PetConfig>(&raw).ok())
        .unwrap_or_default();
    // 旧版单模型字段迁移：models 为空且 model 非空时并入 models（保持首个为默认）
    for p in &mut cfg.profiles {
        if p.models.is_empty() && !p.model.trim().is_empty() {
            p.models = vec![p.model.trim().to_string()];
        }
    }
    cfg
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

/// 取当前激活 profile、生效模型与对应密钥，供对话 / 文件分析 / Agent 共用。
/// 生效模型 = active_model（须在该 profile 的 models 内），否则回退首个预设；
/// active_profile_id 失效（如该配置已删）回退首家，与前端下拉的回退一致。
pub(crate) fn active_profile_with_key(state: &ChatState) -> Result<(ModelProfile, String, String), String> {
    let cfg = state.config.lock().unwrap();
    let profile = cfg
        .profiles
        .iter()
        .find(|p| Some(&p.id) == cfg.active_profile_id.as_ref())
        .or_else(|| cfg.profiles.first())
        .cloned()
        .ok_or("没有可用的模型配置，请先在「模型配置」页添加")?;
    let model = cfg
        .active_model
        .as_deref()
        .filter(|m| profile.models.iter().any(|x| x == m))
        .map(str::to_string)
        .or_else(|| profile.effective_model().map(str::to_string))
        .ok_or("该供应商没有预设模型，请到「模型配置」页补充")?;
    let key = state
        .secrets
        .get(&format!("{KEY_PREFIX}{}", profile.id))
        .map_err(|e| e.to_string())?
        .ok_or("该配置未设置 API Key")?;
    Ok((profile, key, model))
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

// ——— 密钥条目复制（模型配置 ↔ 额度查询同步用） ———

/// 在凭据管理器两条密钥条目间复制：`api:<profileId>`（对话，纯 Key 字符串）
/// 与 `quota:<providerId>`（额度，{apiKey, apiSecret} JSON）互转，明文不出 keyring。
/// 返回是否复制成功（源条目无可用 Key 时返回 false，不算错误）。
#[tauri::command]
pub fn chat_copy_key(state: State<'_, ChatState>, from: String, to: String) -> Result<bool, String> {
    let read_entry = |spec: &str| -> Result<Option<String>, String> {
        let (kind, id) = spec.split_once(':').ok_or("密钥条目格式应为 api:<id> 或 quota:<id>")?;
        if id.trim().is_empty() {
            return Err("密钥条目 id 不能为空".into());
        }
        match kind {
            "api" => state.secrets.get(&format!("{KEY_PREFIX}{id}")).map_err(|e| e.to_string()),
            "quota" => state
                .secrets
                .get(&format!("{QUOTA_KEY_PREFIX}{id}"))
                .map_err(|e| e.to_string())
                .map(|raw| {
                    raw.and_then(|r| {
                        serde_json::from_str::<serde_json::Value>(&r)
                            .ok()
                            .and_then(|v| v["apiKey"].as_str().map(str::to_string))
                            .filter(|k| !k.is_empty())
                    })
                }),
            _ => Err("密钥条目类型只支持 api / quota".into()),
        }
    };
    let write_entry = |spec: &str, api_key: &str| -> Result<(), String> {
        let (kind, id) = spec.split_once(':').ok_or("密钥条目格式应为 api:<id> 或 quota:<id>")?;
        if id.trim().is_empty() {
            return Err("密钥条目 id 不能为空".into());
        }
        match kind {
            "api" => state
                .secrets
                .set(&format!("{KEY_PREFIX}{id}"), api_key)
                .map_err(|e| e.to_string()),
            "quota" => state
                .secrets
                .set(
                    &format!("{QUOTA_KEY_PREFIX}{id}"),
                    &serde_json::json!({ "apiKey": api_key, "apiSecret": "" }).to_string(),
                )
                .map_err(|e| e.to_string()),
            _ => Err("密钥条目类型只支持 api / quota".into()),
        }
    };
    let api_key = match read_entry(&from)? {
        Some(k) => k,
        None => return Ok(false),
    };
    write_entry(&to, &api_key)?;
    Ok(true)
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
    let (profile, key, model) = active_profile_with_key(&state)?;
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
            model: model.clone(),
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
    let (profile, key, model) = active_profile_with_key(&state)?;
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
    let model_cfg = ModelConfig { base_url: profile.base_url.clone(), model: model.clone() };

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

// ——— 额度供应商密钥（Windows 凭据管理器） ———
// 与对话密钥同一 service（com.modelquota.desktop），条目键 `quota_key:<provider_id>`，
// 值为 {apiKey, apiSecret} JSON（双凭证类型如火山 IAM 一条存齐）。
// 前端 localStorage 只留 hasSecret 标记，明文密钥不落盘。

const QUOTA_KEY_PREFIX: &str = "quota_key:";

#[tauri::command]
pub fn quota_secret_set(
    state: State<'_, ChatState>,
    provider_id: String,
    api_key: String,
    api_secret: String,
) -> Result<(), String> {
    if provider_id.trim().is_empty() {
        return Err("provider_id 不能为空".into());
    }
    let value = serde_json::json!({ "apiKey": api_key, "apiSecret": api_secret }).to_string();
    state
        .secrets
        .set(&format!("{QUOTA_KEY_PREFIX}{provider_id}"), &value)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn quota_secret_get(state: State<'_, ChatState>, provider_id: String) -> Result<Option<serde_json::Value>, String> {
    let raw = state
        .secrets
        .get(&format!("{QUOTA_KEY_PREFIX}{provider_id}"))
        .map_err(|e| e.to_string())?;
    Ok(raw.and_then(|r| serde_json::from_str(&r).ok()))
}

#[tauri::command]
pub fn quota_secret_has(state: State<'_, ChatState>, provider_id: String) -> Result<bool, String> {
    state
        .secrets
        .get(&format!("{QUOTA_KEY_PREFIX}{provider_id}"))
        .map(|k| k.is_some())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn quota_secret_delete(state: State<'_, ChatState>, provider_id: String) -> Result<(), String> {
    state
        .secrets
        .delete(&format!("{QUOTA_KEY_PREFIX}{provider_id}"))
        .map_err(|e| e.to_string())
}

// ——— 会话附件：解析文件为文本（复用轻析解析器） ———

const CHAT_ATTACH_MAX_BYTES: u64 = 20 * 1024 * 1024;
const CHAT_ATTACH_MAX_CHARS: usize = 8000;

/// 读取并解析文件为文本，供对话附件使用。支持解析器覆盖的全部格式
/// （pdf/docx/xlsx/txt/md/csv/json/代码文件等），内容截断至 8000 字符。
#[tauri::command]
pub fn chat_read_file(path: String) -> Result<serde_json::Value, String> {
    let p = std::path::Path::new(&path);
    if !p.is_file() {
        return Err("文件不存在或不是普通文件".into());
    }
    let meta = std::fs::metadata(p).map_err(|e| format!("读取文件信息失败：{e}"))?;
    if meta.len() > CHAT_ATTACH_MAX_BYTES {
        return Err("文件超过 20MB，无法作为会话附件".into());
    }
    let registry = liteai_parsers::default_registry();
    let parser = registry
        .get(p)
        .ok_or_else(|| "该文件类型不支持作为附件（支持 pdf / docx / xlsx / txt / md / csv / json / 代码文件等文本格式）".to_string())?;
    let doc = parser.parse(p).map_err(|e| format!("解析失败：{e}"))?;
    if doc.text.trim().is_empty() {
        return Err("未能从文件中提取到文本（可能是扫描版 PDF 或空文件）".into());
    }
    let mut text = doc.text;
    let mut truncated = doc.truncated;
    if text.chars().count() > CHAT_ATTACH_MAX_CHARS {
        text = text.chars().take(CHAT_ATTACH_MAX_CHARS).collect();
        truncated = true;
    }
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(serde_json::json!({
        "name": name,
        "content": text,
        "chars": text.chars().count(),
        "truncated": truncated,
    }))
}

// ——— 语音对话：识别（ASR）与合成（TTS） ———
// 走 OpenAI 兼容音频端点（默认预置硅基流动）。base_url/model/音色由前端每次传参
// （存 localStorage，非敏感），Key 存凭据管理器（条目 voice_key），明文不落盘。

const VOICE_KEY_ENTRY: &str = "voice_key";
const VOICE_TRANSCRIBE_TIMEOUT_SECS: u64 = 30;
const VOICE_SPEAK_TIMEOUT_SECS: u64 = 60;
/// 朗读文本限长：CosyVoice 单次合成在数百字内，防误传超长文本烧钱
const VOICE_SPEAK_MAX_CHARS: usize = 1000;

#[tauri::command]
pub fn voice_secret_set(state: State<'_, ChatState>, key: String) -> Result<(), String> {
    state
        .secrets
        .set(VOICE_KEY_ENTRY, &key)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn voice_secret_has(state: State<'_, ChatState>) -> Result<bool, String> {
    state
        .secrets
        .get(VOICE_KEY_ENTRY)
        .map(|k| k.is_some())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn voice_secret_delete(state: State<'_, ChatState>) -> Result<(), String> {
    state
        .secrets
        .delete(VOICE_KEY_ENTRY)
        .map_err(|e| e.to_string())
}

fn voice_key(state: &ChatState) -> Result<String, String> {
    state
        .secrets
        .get(VOICE_KEY_ENTRY)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "语音服务未设置 API Key，请在对话页「语音服务」中配置".into())
}

fn voice_endpoint(base_url: &str, path: &str) -> String {
    format!("{}/{}", base_url.trim_end_matches('/'), path)
}

/// 云端错误响应截断（避免整页 HTML/长 JSON 直接抛给前端）
fn voice_error_body(body: &str) -> String {
    let t = body.trim();
    let t = if t.is_empty() { "(空响应)" } else { t };
    if t.chars().count() > 200 {
        format!("{}…", t.chars().take(200).collect::<String>())
    } else {
        t.to_string()
    }
}

fn voice_http_error(what: &str, e: reqwest::Error) -> String {
    if e.is_timeout() {
        format!("{what}请求超时，请检查网络或服务可用性")
    } else if e.is_connect() {
        format!("{what}连接失败，请检查 base_url 与网络：{e}")
    } else {
        format!("{what}请求失败：{e}")
    }
}

fn voice_http_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| e.to_string())
}

/// 语音识别：WAV 字节（base64）→ POST /audio/transcriptions → 文本
#[tauri::command]
pub async fn voice_transcribe(
    state: State<'_, ChatState>,
    base_url: String,
    model: String,
    audio_base64: String,
) -> Result<String, String> {
    let key = voice_key(&state)?;
    use base64::Engine as _;
    let audio = base64::engine::general_purpose::STANDARD
        .decode(audio_base64.trim())
        .map_err(|e| format!("音频数据解码失败：{e}"))?;
    if audio.is_empty() {
        return Err("没有收到录音数据".into());
    }
    let part = reqwest::multipart::Part::bytes(audio)
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .text("model", model)
        .part("file", part);
    let client = voice_http_client(VOICE_TRANSCRIBE_TIMEOUT_SECS)?;
    let resp = client
        .post(voice_endpoint(&base_url, "audio/transcriptions"))
        .bearer_auth(&key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| voice_http_error("语音识别", e))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("读取识别结果失败：{e}"))?;
    if !status.is_success() {
        return Err(format!(
            "语音识别失败（HTTP {}）：{}",
            status.as_u16(),
            voice_error_body(&body)
        ));
    }
    serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("text").and_then(|t| t.as_str()).map(str::to_string))
        .ok_or_else(|| format!("识别结果格式异常：{}", voice_error_body(&body)))
}

/// 语音合成：文本 → POST /audio/speech → mp3 字节（base64 返回，前端解码播放）
#[tauri::command]
pub async fn voice_speak(
    state: State<'_, ChatState>,
    base_url: String,
    model: String,
    voice: String,
    text: String,
) -> Result<String, String> {
    let key = voice_key(&state)?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("没有可朗读的文本".into());
    }
    let input: String = trimmed.chars().take(VOICE_SPEAK_MAX_CHARS).collect();
    let client = voice_http_client(VOICE_SPEAK_TIMEOUT_SECS)?;
    let resp = client
        .post(voice_endpoint(&base_url, "audio/speech"))
        .bearer_auth(&key)
        .json(&serde_json::json!({
            "model": model,
            "input": input,
            "voice": voice,
            "response_format": "mp3",
        }))
        .send()
        .await
        .map_err(|e| voice_http_error("语音合成", e))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "语音合成失败（HTTP {}）：{}",
            status.as_u16(),
            voice_error_body(&body)
        ));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取合成音频失败：{e}"))?;
    if bytes.is_empty() {
        return Err("语音合成返回了空音频".into());
    }
    use base64::Engine as _;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

// ——— 后端定时刷新调度（时钟在 Rust 常驻线程） ———
// 前端把设置页的刷新间隔同步过来；到点 emit `backend-refresh-due`，由主窗
// （WebView 常驻，IPC 事件不受隐藏窗口定时器节流影响）执行既有 JS 刷新编排。

/// 调度共享状态：配置 + 变更序号（Condvar 唤醒调度线程重算下一轮）
pub struct RefreshSchedule {
    pub prefs: Mutex<RefreshPrefs>,
    pub seq: Mutex<u64>,
    pub cond: std::sync::Condvar,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct RefreshPrefs {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub interval_minutes: u64,
}

#[tauri::command]
pub fn set_refresh_schedule(
    app: AppHandle,
    sched: State<'_, std::sync::Arc<RefreshSchedule>>,
    enabled: bool,
    interval_minutes: u64,
) -> Result<(), String> {
    let prefs = RefreshPrefs {
        enabled: enabled && interval_minutes > 0,
        interval_minutes,
    };
    // 配置没变就不重置：前端改无关设置（如提醒阈值）重发同值时，不打断刷新倒计时
    {
        let cur = sched.prefs.lock().unwrap();
        if cur.enabled == prefs.enabled && cur.interval_minutes == prefs.interval_minutes {
            return Ok(());
        }
    }
    persist_refresh_prefs(&app, &prefs)?;
    *sched.prefs.lock().unwrap() = prefs;
    *sched.seq.lock().unwrap() += 1;
    sched.cond.notify_all();
    Ok(())
}

fn refresh_prefs_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("refresh.json"))
}

fn persist_refresh_prefs(app: &AppHandle, prefs: &RefreshPrefs) -> Result<(), String> {
    let path = refresh_prefs_path(app).ok_or("无法定位配置目录")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string(prefs).map_err(|e| e.to_string())?;
    std::fs::write(path, raw).map_err(|e| e.to_string())
}

pub fn load_refresh_prefs(app: &AppHandle) -> RefreshPrefs {
    refresh_prefs_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(RefreshPrefs { enabled: false, interval_minutes: 0 })
}

/// 调度线程：序号变化（前端同步配置）即重算下一轮触发点；到点发事件后重新计时。
/// 启动即按已加载的配置武装（first 标记）——前端尚未同步前 refresh.json 已启用的
/// 配置也能生效，不依赖必有的一次 set_refresh_schedule。
pub fn spawn_refresh_scheduler(app: AppHandle, sched: std::sync::Arc<RefreshSchedule>) {
    std::thread::spawn(move || {
        let mut seen_seq: u64 = 0;
        let mut next_fire: Option<std::time::Instant> = None;
        let mut first = true;
        loop {
            let (prefs, seq) = {
                let prefs = sched.prefs.lock().unwrap().clone();
                let seq = *sched.seq.lock().unwrap();
                (prefs, seq)
            };
            if first || seq != seen_seq {
                first = false;
                seen_seq = seq;
                next_fire = if prefs.enabled && prefs.interval_minutes > 0 {
                    Some(std::time::Instant::now() + std::time::Duration::from_secs(prefs.interval_minutes * 60))
                } else {
                    None
                };
            }
            match next_fire {
                None => {
                    // 关闭状态：挂起等待，直到前端同步了新配置（序号变化被 notify 唤醒、谓词转假返回）
                    let guard = sched.prefs.lock().unwrap();
                    let _waited = sched.cond.wait_while(guard, |_inner: &mut RefreshPrefs| {
                        *sched.seq.lock().unwrap() == seen_seq
                    });
                }
                Some(deadline) => {
                    let now = std::time::Instant::now();
                    if now >= deadline {
                        let _ = app.emit("backend-refresh-due", ());
                        let interval = {
                            let prefs = sched.prefs.lock().unwrap().clone();
                            prefs.interval_minutes.max(1)
                        };
                        next_fire = Some(std::time::Instant::now() + std::time::Duration::from_secs(interval * 60));
                    } else {
                        let guard = sched.prefs.lock().unwrap();
                        let _ = sched.cond.wait_timeout_while(guard, deadline - now, |_inner: &mut RefreshPrefs| {
                            *sched.seq.lock().unwrap() == seen_seq
                        });
                    }
                }
            }
        }
    });
}

// ——— 托盘动态图标 ———
// 前端按当前全局健康度绘制 32×32 RGBA（底色=严重度、白字=最高用量%），
// 连同多行摘要 tooltip 一起推送；Rust 只做托盘更新胶水。

#[tauri::command]
pub fn update_tray_status(
    app: AppHandle,
    rgba: Vec<u8>,
    width: u32,
    height: u32,
    tooltip: String,
) -> Result<(), String> {
    if rgba.len() as u64 != width as u64 * height as u64 * 4 {
        return Err("图标像素数据大小不符".into());
    }
    let tray = app.tray_by_id("quota-tray").ok_or("托盘不可用")?;
    tray.set_icon(Some(tauri::image::Image::new_owned(rgba.clone(), width, height)))
        .map_err(|e| e.to_string())?;
    tray.set_tooltip(Some(if tooltip.is_empty() { "桌看".to_string() } else { tooltip }))
        .map_err(|e| e.to_string())?;
    // 主窗/任务栏大图标与托盘同款三色状态图，视觉一致
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_icon(tauri::image::Image::new_owned(rgba, width, height));
    }
    Ok(())
}

// ——— 日程提醒调度（时钟在 Rust 常驻线程）———
// 前端把未来窗口内（7 天）的提醒实例同步过来（set_schedule_reminders，schedule.json
// 持久化，重启恢复并补报错过项）；调度线程每 20s 扫描到期实例：桌宠窗开着且为 pet
// 形态 → emit `schedule-due` 由桌宠气泡播报，否则回退 Windows 原生 Toast。
// 与定时刷新同一套「后端持钟」设计，不受 WebView 隐藏窗口定时器节流影响。

/// 到期后多久以内算「新鲜错过」→ 立即补报（带 missed 标记）；
/// 超过 STALE（休眠跨夜、久未开机）静默吞掉，避免唤醒后提醒雪崩
const REMINDER_FRESH_MS: i64 = 15 * 60 * 1000;
const REMINDER_STALE_MS: i64 = 12 * 60 * 60 * 1000;
/// 调度扫描周期
const REMINDER_TICK_SECS: u64 = 20;

/// 一条提醒实例（前端 expandInstances 把重复日程展开成的具体某一次）
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleTask {
    /// `id@dueAt`：已触发判定键（防重启/补发重复）
    pub key: String,
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub note: String,
    /// 提醒触发时刻（原定时刻 − 提前量，ms epoch）
    pub due_at: i64,
    /// 原定开始时刻（展示用，ms epoch）
    pub at: i64,
    /// 原定时刻的 HH:mm 文本（Rust 无本地时区库，前端格式化好带过来）
    #[serde(default)]
    pub time_text: String,
}

/// 调度共享状态：待触发队列 + 已触发键集合 + 变更序号（Condvar 唤醒重扫）
#[derive(Default)]
pub struct ReminderState {
    pub tasks: Mutex<Vec<ScheduleTask>>,
    pub fired: Mutex<std::collections::HashSet<String>>,
    pub seq: Mutex<u64>,
    pub cond: std::sync::Condvar,
    /// 队列耗尽后补货请求（schedule-queue-low）只发一次，补货前不重复发
    pub refill_requested: AtomicBool,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn schedule_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("schedule.json"))
}

#[derive(Serialize, Deserialize, Default)]
struct PersistedSchedule {
    #[serde(default)]
    tasks: Vec<ScheduleTask>,
    #[serde(default)]
    fired: Vec<String>,
}

/// 持久化队列与已触发集合（fired 只保留 48h 内的，防文件无限增长）
fn persist_schedule(app: &AppHandle, state: &ReminderState) {
    let Some(path) = schedule_path(app) else { return };
    let now = now_ms();
    let fired: Vec<String> = state
        .fired
        .lock()
        .unwrap()
        .iter()
        .filter(|k| {
            k.rsplit('@')
                .next()
                .and_then(|s| s.parse::<i64>().ok())
                .map(|t| now - t < 48 * 60 * 60 * 1000)
                .unwrap_or(false)
        })
        .cloned()
        .collect();
    let data = PersistedSchedule { tasks: state.tasks.lock().unwrap().clone(), fired };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, serde_json::to_string(&data).unwrap_or_default());
}

/// 启动时恢复持久化状态（错过项由调度线程首轮扫描判定补报）
pub fn load_persisted_schedule(app: &AppHandle, state: &ReminderState) {
    let Some(path) = schedule_path(app) else { return };
    let Ok(raw) = std::fs::read_to_string(path) else { return };
    let Ok(data) = serde_json::from_str::<PersistedSchedule>(&raw) else { return };
    *state.tasks.lock().unwrap() = data.tasks;
    *state.fired.lock().unwrap() = data.fired.into_iter().collect();
}

/// 前端同步提醒队列（启动 / 日程增删改 / 补货请求后都会调用）。
/// 相同队列直接忽略：任意窗口在任意时机重发都幂等，不打断调度线程
#[tauri::command]
pub fn set_schedule_reminders(
    app: AppHandle,
    state: State<'_, std::sync::Arc<ReminderState>>,
    tasks: Vec<ScheduleTask>,
) -> Result<(), String> {
    let mut tasks = tasks;
    tasks.sort_by_key(|t| t.due_at);
    tasks.truncate(500);
    {
        let cur = state.tasks.lock().unwrap();
        let same = serde_json::to_string(&*cur)
            .map(|cur_j| serde_json::to_string(&tasks).map(|new_j| new_j == cur_j).unwrap_or(false))
            .unwrap_or(false);
        if same {
            return Ok(());
        }
    }
    *state.tasks.lock().unwrap() = tasks;
    *state.seq.lock().unwrap() += 1;
    state.cond.notify_all();
    state.refill_requested.store(false, Ordering::SeqCst);
    persist_schedule(&app, &state);
    Ok(())
}

/// 调度线程：扫描到期实例 → 桌宠气泡（schedule-due 事件，同批合并一条）或原生
/// Toast；队列将空时发 schedule-queue-low 请主窗补货（前端展开重复实例，
/// IPC 事件不受隐藏窗口节流）。启动首轮即处理上次运行错过的提醒。
pub fn spawn_schedule_reminder(app: AppHandle, state: std::sync::Arc<ReminderState>) {
    std::thread::spawn(move || loop {
        let seq = *state.seq.lock().unwrap();
        let now = now_ms();
        let due: Vec<ScheduleTask> = {
            let tasks = state.tasks.lock().unwrap();
            let fired = state.fired.lock().unwrap();
            tasks
                .iter()
                .filter(|t| t.due_at <= now && !fired.contains(&t.key))
                .cloned()
                .collect()
        };
        let pet_open = crate::pet_bubble_available(&app);
        let mut pet_batch: Vec<serde_json::Value> = Vec::new();
        let mut fired_now: Vec<String> = Vec::new();
        for t in due {
            let age = now - t.due_at;
            let missed = age > REMINDER_FRESH_MS;
            if age > REMINDER_STALE_MS {
                // 太旧：静默标记已触发
            } else if pet_open {
                pet_batch.push(serde_json::json!({
                    "key": t.key,
                    "title": t.title,
                    "note": t.note,
                    "at": t.at,
                    "missed": missed,
                }));
            } else {
                let mut body = format!("{} {}", t.time_text, t.title);
                if !t.note.is_empty() {
                    body.push_str(&format!("（{}）", t.note));
                }
                if missed {
                    body = format!("（已错过）{body}");
                }
                let result = app
                    .notification()
                    .builder()
                    .title("桌看 · 日程提醒")
                    .body(&body)
                    .show();
                // 诊断：Toast 静默失败（如裸 exe 无 AUMID）时落盘错误详情
                if let Err(e) = result {
                    if let Some(dir) = app.path().app_config_dir().ok() {
                        let _ = std::fs::write(dir.join("notify-error.txt"), format!("{e:?}"));
                    }
                }
            }
            fired_now.push(t.key);
        }
        if !pet_batch.is_empty() {
            let _ = app.emit("schedule-due", &pet_batch);
        }
        if !fired_now.is_empty() {
            state.fired.lock().unwrap().extend(fired_now.iter().cloned());
            persist_schedule(&app, &state);
        }
        // 队列将空：请主窗补货（只发一次，直到 set_schedule_reminders 复位标记）
        let has_upcoming = {
            let tasks = state.tasks.lock().unwrap();
            let fired = state.fired.lock().unwrap();
            tasks.iter().any(|t| t.due_at > now && !fired.contains(&t.key))
        };
        if has_upcoming {
            state.refill_requested.store(false, Ordering::SeqCst);
        } else if !state.refill_requested.swap(true, Ordering::SeqCst) {
            let _ = app.emit("schedule-queue-low", ());
        }
        let guard = state.seq.lock().unwrap();
        let _ = state.cond.wait_timeout_while(
            guard,
            std::time::Duration::from_secs(REMINDER_TICK_SECS),
            |s| *s == seq,
        );
    });
}
