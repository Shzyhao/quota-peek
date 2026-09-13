//! Agent：单步确认式工具循环（OpenAI 兼容 function calling）。
//!
//! 安全设计（红线，勿裁剪）：
//! - 每个工具调用必须经前端确认卡片批准后才执行，无任何自动批准；
//! - 全部调用落审计日志 app_config_dir/agent-audit.jsonl（工具/参数/结果摘要/耗时）；
//! - 模型密钥只用于模型请求，不进入任何工具的参数或输出；
//! - 单轮用户消息最多 8 次工具调用，超限强制结束。
//!
//! 循环可挂起：模型提出工具调用后 agent_send 返回（事件已推送 ToolProposed），
//! 前端确认后经 agent_resolve 续跑，直到下一次挂起或给出最终回答（Done）。

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::commands::ChatState;

/// 单轮最多工具调用次数
const MAX_STEPS: u32 = 8;
/// 模型请求超时
const HTTP_TIMEOUT: Duration = Duration::from_secs(60);
/// 命令执行超时
const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
/// 文本读取/命令输出的字符上限
const OUTPUT_CAP: usize = 4000;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Agent 事件（Channel 推送；type snake_case）
#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum AgentEvent {
    ToolProposed { call_id: String, name: String, args: Value, danger: bool },
    ToolResult { call_id: String, name: String, ok: bool, output: String, duration_ms: u64, auto: bool },
    Done { text: String },
    Error { message: String },
}

/// 待确认的工具调用（含模型 assistant 消息，续跑时已在 messages 末尾）
pub struct PendingCall {
    pub id: String,
    pub name: String,
    pub args: Value,
    /// 同一条 assistant 消息里除首个外的其余 tool_call_id（resolve 时回填「已跳过」）
    pub skipped_ids: Vec<String>,
}

/// Agent 运行状态（单飞：同一时刻只允许一个 Agent 循环）
#[derive(Default)]
pub struct AgentState {
    pub running: AtomicBool,
    pub cancel: AtomicBool,
    pub steps: AtomicU32,
    /// 多步自主模式：本任务内后续工具调用不再逐个确认（用户批准整条链后置位；新任务重置）
    pub chain_approved: AtomicBool,
    /// 进行中的对话（OpenAI messages 格式，含工具消息；[0] 为 agent 系统提示）
    pub messages: Mutex<Vec<Value>>,
    pub pending: Mutex<Option<PendingCall>>,
}

impl AgentState {
    pub fn new() -> Self {
        Self::default()
    }
}

// ——— 工具定义 ———

fn tools_spec() -> Value {
    json!([
        { "type": "function", "function": { "name": "get_current_time", "description": "获取当前本地日期时间（含星期）", "parameters": { "type": "object", "properties": {} } } },
        { "type": "function", "function": { "name": "get_system_info", "description": "获取系统基本信息（系统/架构/计算机名/用户名）", "parameters": { "type": "object", "properties": {} } } },
        { "type": "function", "function": { "name": "list_directory", "description": "列出目录内容（最多 200 项）", "parameters": { "type": "object", "properties": { "path": { "type": "string", "description": "目录绝对路径" } }, "required": ["path"] } } },
        { "type": "function", "function": { "name": "read_text_file", "description": "读取文本文件内容（截断至 4000 字符）", "parameters": { "type": "object", "properties": { "path": { "type": "string", "description": "文件绝对路径" } }, "required": ["path"] } } },
        { "type": "function", "function": { "name": "open_url", "description": "用默认浏览器打开网址（仅 http/https）", "parameters": { "type": "object", "properties": { "url": { "type": "string" } }, "required": ["url"] } } },
        { "type": "function", "function": { "name": "open_path", "description": "用系统默认方式打开文件或文件夹", "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] } } },
        { "type": "function", "function": { "name": "write_clipboard", "description": "写入系统剪贴板", "parameters": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] } } },
        { "type": "function", "function": { "name": "write_text_file", "description": "写入文本文件（覆盖同名文件，高危需谨慎）", "parameters": { "type": "object", "properties": { "path": { "type": "string" }, "content": { "type": "string" } }, "required": ["path", "content"] } } },
        { "type": "function", "function": { "name": "run_command", "description": "执行 PowerShell 命令（20 秒超时，输出截断，高危操作）", "parameters": { "type": "object", "properties": { "command": { "type": "string" } }, "required": ["command"] } } }
    ])
}

/// 危险工具（前端确认卡片标红）
fn tool_danger(name: &str) -> bool {
    matches!(name, "write_text_file" | "run_command")
}

/// 只读工具（与前端 isReadonlyTool 同集合）：无系统副作用，可安全自动执行
fn tool_readonly(name: &str) -> bool {
    matches!(name, "get_current_time" | "get_system_info" | "list_directory" | "read_text_file")
}

fn valid_tool(name: &str) -> bool {
    matches!(
        name,
        "get_current_time"
            | "get_system_info"
            | "list_directory"
            | "read_text_file"
            | "open_url"
            | "open_path"
            | "write_clipboard"
            | "write_text_file"
            | "run_command"
    )
}

// ——— 工具执行 ———

fn spawn_quiet(program: &str, args: &[&str]) -> std::io::Result<std::process::Child> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new(program)
            .args(args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new(program)
            .args(args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
    }
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("缺少参数 {key}"))
}

async fn execute_tool(name: &str, args: &Value) -> Result<String, String> {
    match name {
        "get_current_time" => {
            use chrono::Datelike;
            let now = chrono::Local::now();
            let weekday = match now.weekday() {
                chrono::Weekday::Mon => "周一",
                chrono::Weekday::Tue => "周二",
                chrono::Weekday::Wed => "周三",
                chrono::Weekday::Thu => "周四",
                chrono::Weekday::Fri => "周五",
                chrono::Weekday::Sat => "周六",
                chrono::Weekday::Sun => "周日",
            };
            Ok(format!("{} {}", now.format("%Y-%m-%d %H:%M:%S"), weekday))
        }
        "get_system_info" => Ok(format!(
            "系统: {} / 架构: {} / 计算机名: {} / 用户: {}",
            std::env::consts::OS,
            std::env::consts::ARCH,
            std::env::var("COMPUTERNAME").unwrap_or_else(|_| "?".into()),
            std::env::var("USERNAME").unwrap_or_else(|_| "?".into()),
        )),
        "list_directory" => {
            let path = str_arg(args, "path")?;
            let dir = std::path::Path::new(&path);
            if !dir.is_dir() {
                return Err(format!("目录不存在：{path}"));
            }
            let mut out = Vec::new();
            for entry in std::fs::read_dir(dir).map_err(|e| format!("读取目录失败：{e}"))? {
                let entry = entry.map_err(|e| format!("读取目录失败：{e}"))?;
                let name = entry.file_name().to_string_lossy().to_string();
                let kind = if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    "<dir>".to_string()
                } else {
                    format!("{} bytes", entry.metadata().map(|m| m.len()).unwrap_or(0))
                };
                out.push(format!("{name}\t{kind}"));
                if out.len() >= 200 {
                    out.push("…（超过 200 项已截断）".into());
                    break;
                }
            }
            Ok(if out.is_empty() { "（空目录）".into() } else { out.join("\n") })
        }
        "read_text_file" => {
            let path = str_arg(args, "path")?;
            let bytes = std::fs::read(&path).map_err(|e| format!("读取失败：{e}"))?;
            if bytes.iter().filter(|&&b| b == 0).count() > 8 {
                return Err("疑似二进制文件，无法作为文本读取".into());
            }
            let text = String::from_utf8_lossy(&bytes);
            if text.chars().count() > OUTPUT_CAP {
                Ok(format!(
                    "{}…（超长已截断至 {OUTPUT_CAP} 字符）",
                    text.chars().take(OUTPUT_CAP).collect::<String>()
                ))
            } else {
                Ok(text.to_string())
            }
        }
        "open_url" => {
            let url = str_arg(args, "url")?;
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return Err("仅允许 http/https 网址".into());
            }
            // 不经 cmd /C start：URL 中的 & 等元字符会被 cmd 当命令分隔符（注入面），
            // explorer.exe 直开不经过 shell 解析
            spawn_quiet("explorer.exe", &[url]).map_err(|e| format!("打开失败：{e}"))?;
            Ok(format!("已打开 {url}"))
        }
        "open_path" => {
            let path = str_arg(args, "path")?;
            if !std::path::Path::new(&path).exists() {
                return Err(format!("路径不存在：{path}"));
            }
            spawn_quiet("explorer.exe", &[path]).map_err(|e| format!("打开失败：{e}"))?;
            Ok(format!("已打开 {path}"))
        }
        "write_clipboard" => {
            let text = str_arg(args, "text")?;
            let mut board = arboard::Clipboard::new().map_err(|e| format!("剪贴板不可用：{e}"))?;
            board
                .set_text(text.to_string())
                .map_err(|e| format!("写入剪贴板失败：{e}"))?;
            Ok(format!("已写入剪贴板（{} 字符）", text.chars().count()))
        }
        "write_text_file" => {
            let path = str_arg(args, "path")?;
            let content = str_arg(args, "content")?;
            if content.len() > 1024 * 1024 {
                return Err("内容超过 1MB，拒绝写入".into());
            }
            std::fs::write(path, content).map_err(|e| format!("写入失败：{e}"))?;
            Ok(format!("已写入 {path}"))
        }
        "run_command" => {
            let command = str_arg(args, "command")?;
            if command.chars().count() > 8000 {
                return Err("命令超过 8000 字符，拒绝执行".into());
            }
            let mut child = spawn_quiet(
                "powershell",
                &["-NoProfile", "-NonInteractive", "-Command", command],
            )
            .map_err(|e| format!("启动命令失败：{e}"))?;
            // 管道读取放独立线程（避免大输出阻塞子进程），主循环轮询超时
            let mut stdout_pipe = child.stdout.take().expect("stdout piped");
            let mut stderr_pipe = child.stderr.take().expect("stderr piped");
            let out_reader = std::thread::spawn(move || {
                let mut buf = Vec::new();
                let _ = std::io::Read::read_to_end(&mut stdout_pipe, &mut buf);
                buf
            });
            let err_reader = std::thread::spawn(move || {
                let mut buf = Vec::new();
                let _ = std::io::Read::read_to_end(&mut stderr_pipe, &mut buf);
                buf
            });
            let start = Instant::now();
            let status = loop {
                match child.try_wait() {
                    Ok(Some(status)) => break status,
                    Ok(None) if start.elapsed() > COMMAND_TIMEOUT => {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(format!("命令超时（{} 秒）已终止", COMMAND_TIMEOUT.as_secs()));
                    }
                    Ok(None) => tokio::time::sleep(Duration::from_millis(150)).await,
                    Err(e) => return Err(format!("等待命令失败：{e}")),
                }
            };
            let mut text = String::from_utf8_lossy(&out_reader.join().unwrap_or_default()).to_string();
            let err = String::from_utf8_lossy(&err_reader.join().unwrap_or_default()).to_string();
            if !err.trim().is_empty() {
                text.push_str("\n[stderr] ");
                text.push_str(err.trim());
            }
            if !status.success() {
                text.push_str(&format!("\n[退出码 {}]", status.code().unwrap_or(-1)));
            }
            let text = text.trim().to_string();
            Ok(if text.is_empty() {
                "（命令执行完成，无输出）".into()
            } else if text.chars().count() > OUTPUT_CAP {
                format!(
                    "{}…（输出超长已截断）",
                    text.chars().take(OUTPUT_CAP).collect::<String>()
                )
            } else {
                text
            })
        }
        _ => Err(format!("未知工具：{name}")),
    }
}

// ——— 审计日志 ———

#[allow(clippy::too_many_arguments)]
fn audit(app: &AppHandle, tool: &str, args: &Value, approved: bool, auto: bool, ok: bool, duration_ms: u128, output: &str) {
    let Ok(dir) = app.path().app_config_dir() else { return };
    let path = dir.join("agent-audit.jsonl");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        use std::io::Write;
        let entry = json!({
            "time": chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            "tool": tool,
            "args": args,
            "approved": approved,
            "auto": auto,
            "ok": ok,
            "duration_ms": duration_ms as u64,
            "output_preview": output.chars().take(200).collect::<String>(),
        });
        let _ = writeln!(f, "{entry}");
    }
}

// ——— 模型客户端（OpenAI 兼容 tools） ———

struct AgentClient {
    http: reqwest::Client,
    key: String,
    base_url: String,
    model: String,
}

impl AgentClient {
    fn new(key: String, base_url: String, model: String) -> Self {
        Self {
            http: reqwest::Client::builder().timeout(HTTP_TIMEOUT).build().unwrap_or_default(),
            key,
            base_url: base_url.trim_end_matches('/').to_string(),
            model,
        }
    }

    /// 单轮补全（非流式，带 tools）。返回 assistant message（含 content / tool_calls）。
    async fn chat_completion(&self, messages: &[Value]) -> Result<Value, String> {
        let body = json!({
            "model": self.model,
            "messages": messages,
            "tools": tools_spec(),
            "tool_choice": "auto",
            "temperature": 0.3,
        });
        let resp = self
            .http
            .post(format!("{}/chat/completions", self.base_url))
            .bearer_auth(&self.key)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("请求模型失败：{e}"))?;
        let status = resp.status();
        let payload: Value = resp.json().await.map_err(|e| format!("解析模型响应失败：{e}"))?;
        if !status.is_success() {
            let msg = payload
                .pointer("/error/message")
                .and_then(|v| v.as_str())
                .unwrap_or("未知错误");
            return Err(format!("模型返回错误（HTTP {}）：{}", status.as_u16(), msg));
        }
        payload
            .pointer("/choices/0/message")
            .cloned()
            .ok_or_else(|| "模型响应缺少 choices[0].message".to_string())
    }
}

// ——— 循环体 ———

const AGENT_SYSTEM: &str = "你是桌看 Agent，可以调用工具帮用户完成系统操作。调用工具前先用一句话（同一条回复的文字部分）说明你要做什么；工具需要用户批准才会执行。每次回复只调用一个工具，等它的结果返回后再决定下一步。全程用中文，回答简洁。";

async fn run_loop(
    app: &AppHandle,
    agent: &AgentState,
    client: &AgentClient,
    events: &Channel<AgentEvent>,
) -> Result<(), String> {
    loop {
        if agent.cancel.load(Ordering::SeqCst) {
            let _ = events.send(AgentEvent::Done { text: "（已停止）".into() });
            return Ok(());
        }
        if agent.steps.load(Ordering::SeqCst) >= MAX_STEPS {
            let _ = events.send(AgentEvent::Done {
                text: "（工具调用次数已达上限，本次 Agent 任务结束）".into(),
            });
            return Ok(());
        }
        let messages_snapshot = agent.messages.lock().unwrap().clone();
        let message = client.chat_completion(&messages_snapshot).await.map_err(|e| {
            let _ = events.send(AgentEvent::Error { message: e.clone() });
            e
        })?;

        let tool_calls = message
            .get("tool_calls")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let Some(call) = tool_calls.first().cloned() else {
            let text = message
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("（模型未返回内容）")
                .to_string();
            agent.messages.lock().unwrap().push(json!({ "role": "assistant", "content": text }));
            let _ = events.send(AgentEvent::Done { text });
            return Ok(());
        };

        let call_id = call.get("id").and_then(|v| v.as_str()).unwrap_or("call_0").to_string();
        let name = call
            .pointer("/function/name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let args_raw = call
            .pointer("/function/arguments")
            .and_then(|v| v.as_str())
            .unwrap_or("{}");
        let args: Value = serde_json::from_str(args_raw).unwrap_or_else(|_| json!({}));

        agent.messages.lock().unwrap().push(message.clone());

        // 多步自主模式：本消息内的全部 tool_calls 自动执行——只读工具直接跑；
        // 写/执行类降级：跳过并回填提示（链中读取的不可信内容可能诱导危险调用，
        // 不能让它绕过人工批准），模型会改用确认卡路径重新提议
        if agent.chain_approved.load(Ordering::SeqCst) {
            let mut executed = 0;
            for call in &tool_calls {
                let cid = call.get("id").and_then(|v| v.as_str()).unwrap_or("call_x").to_string();
                let cname = call
                    .pointer("/function/name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let cargs: Value = serde_json::from_str(
                    call.pointer("/function/arguments").and_then(|v| v.as_str()).unwrap_or("{}"),
                )
                .unwrap_or_else(|_| json!({}));
                if !valid_tool(&cname) || !tool_readonly(&cname) {
                    agent.messages.lock().unwrap().push(json!({
                        "role": "tool",
                        "tool_call_id": cid,
                        "content": if valid_tool(&cname) {
                            "该工具需要单独确认，已跳过自动执行。请重新提议或直接回答。".to_string()
                        } else {
                            format!("未知工具 {cname}，请改用其他方式或直接回答")
                        },
                    }));
                    continue;
                }
                let start = Instant::now();
                let result = execute_tool(&cname, &cargs).await;
                let duration = start.elapsed().as_millis();
                let (ok, output) = match result {
                    Ok(out) => (true, out),
                    Err(e) => (false, e),
                };
                audit(app, &cname, &cargs, true, true, ok, duration, &output);
                let _ = events.send(AgentEvent::ToolResult {
                    call_id: cid.clone(),
                    name: cname.clone(),
                    ok,
                    output: output.clone(),
                    duration_ms: duration as u64,
                    auto: true,
                });
                agent.messages.lock().unwrap().push(json!({
                    "role": "tool",
                    "tool_call_id": cid,
                    "content": output,
                }));
                executed += 1;
            }
            if executed > 0 {
                agent.steps.fetch_add(1, Ordering::SeqCst);
            }
            continue;
        }

        // 单步模式：首个 tool_call 挂起待确认；若模型一次给了多个，其余在
        // agent_resolve 里回填「已跳过」，保证每个 tool_call_id 都有响应（否则 HTTP 400）
        if !valid_tool(&name) {
            // 模型幻觉出的工具：以工具结果形式拒绝并继续，不打断会话
            push_tool_results_for_all_calls(agent, |cid| {
                json!({
                    "role": "tool",
                    "tool_call_id": cid,
                    "content": if cid == call_id {
                        format!("未知工具 {name}，请改用其他方式或直接回答")
                    } else {
                        "已跳过（一次只处理一个工具调用）".to_string()
                    },
                })
            });
            agent.steps.fetch_add(1, Ordering::SeqCst);
            continue;
        }

        // 挂起：存待确认调用，推送 ToolProposed，等 agent_resolve 续跑
        let skipped_ids = tool_calls
            .iter()
            .skip(1)
            .filter_map(|c| c.get("id").and_then(|v| v.as_str()))
            .map(|x| x.to_string())
            .collect();
        *agent.pending.lock().unwrap() = Some(PendingCall {
            id: call_id.clone(),
            name: name.clone(),
            args: args.clone(),
            skipped_ids,
        });
        let _ = events.send(AgentEvent::ToolProposed {
            call_id,
            name,
            args,
            danger: tool_danger(
                agent
                    .pending
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|p| p.name.as_str())
                    .unwrap_or(""),
            ),
        });
        return Ok(());
    }
}

/// 为 messages 末尾 assistant 消息中的全部 tool_calls 生成回填（unknown-tool 场景）
fn push_tool_results_for_all_calls(agent: &AgentState, make: impl Fn(&str) -> Value) {
    let last = agent.messages.lock().unwrap().last().cloned();
    let Some(last) = last else { return };
    let ids: Vec<String> = last
        .get("tool_calls")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| c.get("id").and_then(|v| v.as_str()))
                .map(|x| x.to_string())
                .collect()
        })
        .unwrap_or_default();
    let mut msgs = agent.messages.lock().unwrap();
    for cid in ids {
        msgs.push(make(&cid));
    }
}

// ——— Tauri 命令 ———

/// 发起 Agent 任务：事件经 Channel 推送；模型提出工具调用时挂起，等 agent_resolve。
#[tauri::command]
pub async fn agent_send(
    app: AppHandle,
    chat: State<'_, ChatState>,
    agent: State<'_, AgentState>,
    messages: Vec<Value>,
    on_event: Channel<AgentEvent>,
) -> Result<(), String> {
    // 单飞判定：running 且无待确认调用 = 有循环真正在跑（模型请求/工具执行中），拒绝并发；
    // running 但有 pending = 循环已挂起在等人批准（前端可能已丢失确认卡），安全接管重置。
    // （修复：旧逻辑先查 running 导致「挂起未理睬」后永久卡死。）
    let busy = agent.running.load(Ordering::SeqCst);
    let suspended = agent.pending.lock().unwrap().is_some();
    if busy && !suspended {
        return Err("Agent 正在执行中".into());
    }
    agent.running.store(true, Ordering::SeqCst);
    *agent.pending.lock().unwrap() = None;
    agent.cancel.store(false, Ordering::SeqCst);
    agent.steps.store(0, Ordering::SeqCst);
    agent.chain_approved.store(false, Ordering::SeqCst);
    let mut msgs = vec![json!({ "role": "system", "content": AGENT_SYSTEM })];
    msgs.extend(messages);
    *agent.messages.lock().unwrap() = msgs;

    let (profile, key) = crate::commands::active_profile_with_key(&chat)?;
    let client = AgentClient::new(key, profile.base_url.clone(), profile.model.clone());

    let result = run_loop(&app, &agent, &client, &on_event).await;
    // 挂起（存在待确认调用）时保持 running=true，由 agent_resolve 继续；其余情况复位
    if agent.pending.lock().unwrap().is_none() {
        agent.running.store(false, Ordering::SeqCst);
    }
    result
}

/// 用户对挂起的工具调用作出决定（批准/拒绝）；续跑循环直至下一次挂起或完成。
#[tauri::command]
pub async fn agent_resolve(
    app: AppHandle,
    chat: State<'_, ChatState>,
    agent: State<'_, AgentState>,
    approved: bool,
    approve_chain: Option<bool>,
    auto: Option<bool>,
    on_event: Channel<AgentEvent>,
) -> Result<(), String> {
    if !agent.running.load(Ordering::SeqCst) {
        return Err("没有进行中的 Agent 任务".into());
    }
    let Some(pending) = agent.pending.lock().unwrap().take() else {
        agent.running.store(false, Ordering::SeqCst);
        return Err("没有待确认的工具调用".into());
    };
    // 「批准整条链」：本任务内后续工具调用直接执行（仍受步数上限与取消约束）
    if approve_chain.unwrap_or(false) {
        agent.chain_approved.store(true, Ordering::SeqCst);
    }
    let auto_flag = auto.unwrap_or(false) || approve_chain.unwrap_or(false);

    if approved {
        let start = Instant::now();
        let result = execute_tool(&pending.name, &pending.args).await;
        let duration = start.elapsed().as_millis();
        let (ok, output) = match result {
            Ok(out) => (true, out),
            Err(e) => (false, e),
        };
        audit(&app, &pending.name, &pending.args, true, auto_flag, ok, duration, &output);
        let _ = on_event.send(AgentEvent::ToolResult {
            call_id: pending.id.clone(),
            name: pending.name.clone(),
            ok,
            output: output.clone(),
            duration_ms: duration as u64,
            auto: auto_flag,
        });
        agent.messages.lock().unwrap().push(json!({
            "role": "tool",
            "tool_call_id": pending.id,
            "content": output,
        }));
        // 同消息内未确认的其余调用：安全回填「已跳过」（用户只批准过首个）
        let mut msgs = agent.messages.lock().unwrap();
        for sid in &pending.skipped_ids {
            msgs.push(json!({
                "role": "tool",
                "tool_call_id": sid,
                "content": "已跳过（一次只处理一个工具调用）",
            }));
        }
        drop(msgs);
        agent.steps.fetch_add(1, Ordering::SeqCst);
    } else {
        audit(&app, &pending.name, &pending.args, false, false, false, 0, "（用户拒绝）");
        let _ = on_event.send(AgentEvent::ToolResult {
            call_id: pending.id.clone(),
            name: pending.name.clone(),
            ok: false,
            output: "（用户已拒绝）".into(),
            duration_ms: 0,
            auto: false,
        });
        // 全部 tool_calls 回填拒绝
        let mut msgs = agent.messages.lock().unwrap();
        msgs.push(json!({
            "role": "tool",
            "tool_call_id": pending.id,
            "content": "用户拒绝了该工具调用，请改用其他方式或直接回答",
        }));
        for sid in &pending.skipped_ids {
            msgs.push(json!({
                "role": "tool",
                "tool_call_id": sid,
                "content": "已跳过（用户拒绝了本批工具调用）",
            }));
        }
        drop(msgs);
    }

    let (profile, key) = crate::commands::active_profile_with_key(&chat)?;
    let client = AgentClient::new(key, profile.base_url.clone(), profile.model.clone());

    let result = run_loop(&app, &agent, &client, &on_event).await;
    if agent.pending.lock().unwrap().is_none() {
        agent.running.store(false, Ordering::SeqCst);
    }
    result
}

#[tauri::command]
pub fn agent_cancel(agent: State<'_, AgentState>) -> Result<(), String> {
    agent.cancel.store(true, Ordering::SeqCst);
    Ok(())
}
