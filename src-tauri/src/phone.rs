//! 手机关联：局域网只读查看服务（纯 std HTTP，零新依赖）。
//! 前端把对话摘要（主窗）与桌宠形象快照（桌宠窗）经 phone_update_* 推到内存，
//! 手机扫码访问 http://<局域网IP>:<端口> 看只读页面（3 秒自动刷新）。
//! 隐私与安全：只读、不落盘、内容仅存内存；服务关闭即清空；首串入站连接
//! Windows 防火墙可能弹一次授权（选「允许」）。

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::State;

/// 手机查看页注入的对话轮数上限（防超长会话撑爆手机页面）
const MAX_MESSAGES: usize = 60;

pub struct PhoneState {
    /// 主窗推送的会话摘要 JSON（含 messages 数组，结构由前端约定）
    sessions: Mutex<Arc<String>>,
    /// 桌宠窗推送的形象快照（dataURL）
    pet_image: Mutex<Arc<String>>,
    active: AtomicBool,
    port: AtomicU16,
}

impl Default for PhoneState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(Arc::new("null".into())),
            pet_image: Mutex::new(Arc::new("null".into())),
            active: AtomicBool::new(false),
            port: AtomicU16::new(0),
        }
    }
}

/// 局域网源地址探测：UDP connect 只查路由表不发包；离线回退 127.0.0.1
fn lan_ip() -> String {
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("223.5.5.5:80")?;
            s.local_addr()
        })
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".into())
}

/// 手机查看页（内联 HTML，无外部资源；深色自适应）
fn page_html() -> &'static str {
    r#"<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>桌看 · 手机关联</title>
<style>
body{margin:0;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f4f5f7;color:#1f2329}
header{position:sticky;top:0;background:#fff;padding:12px 16px;font-weight:600;box-shadow:0 1px 4px rgba(0,0,0,.06);display:flex;align-items:center;gap:8px}
header .dot{width:8px;height:8px;border-radius:50%;background:#22a06b}
.wrap{max-width:640px;margin:0 auto;padding:14px}
.pet{background:#fff;border-radius:14px;padding:14px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.05);margin-bottom:14px}
.pet img{max-width:200px;width:100%;border-radius:10px}
.pet .empty{color:#9aa0a6;font-size:13px;padding:30px 0}
.session{background:#fff;border-radius:14px;padding:14px;margin-bottom:14px;box-shadow:0 1px 4px rgba(0,0,0,.05)}
.session h3{margin:0 0 10px;font-size:15px}
.msg{margin:8px 0;padding:9px 12px;border-radius:12px;font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.msg.user{background:#3b82f6;color:#fff;margin-left:15%}
.msg.assistant{background:#f1f2f4;margin-right:15%}
.msg .t{display:block;font-size:11px;opacity:.65;margin-top:4px}
.empty-all{text-align:center;color:#9aa0a6;padding:60px 20px;line-height:2}
</style></head><body>
<header><span class="dot"></span>桌看 · 实时查看</header>
<div class="wrap" id="root"><div class="empty-all">加载中…</div></div>
<script>
const esc=(s)=>String(s||'').replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt=(t)=>t?new Date(t).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):'';
async function tick(){
  try{
    const st=await (await fetch('/api/state')).json();
    const root=document.getElementById('root');
    if(!st || st.active===false){root.innerHTML='<div class="empty-all">服务已在电脑端关闭</div>';return;}
    let html='';
    if(st.petImage){html+=`<div class="pet"><img src="${st.petImage}" alt="桌宠"></div>`;}
    else{html+='<div class="pet"><div class="empty">（桌宠形象待桌宠开启后显示）</div></div>';}
    const sessions=Array.isArray(st.sessions)?st.sessions:[];
    if(!sessions.length){html+='<div class="empty-all">还没有对话记录<br>在电脑上和桌宠聊聊吧</div>';}
    for(const s of sessions.slice(0,5)){
      const msgs=(s.messages||[]).filter(m=>(m.role==='user'||m.role==='assistant')&&m.content).slice(-MAX);
      html+=`<div class="session"><h3>${esc(s.title||'对话')}</h3>`+
        msgs.map(m=>`<div class="msg ${m.role==='user'?'user':'assistant'}">${esc(m.content)}<span class="t">${fmt(m.time)}</span></div>`).join('')+
        '</div>';
    }
    root.innerHTML=html;
  }catch(e){document.getElementById('root').innerHTML='<div class="empty-all">连接已断开（电脑端可能已退出）</div>';}
}
const MAX=60;
tick();setInterval(tick,3000);
</script></body></html>"#
}

fn status_json(st: &PhoneState) -> serde_json::Value {
    let active = st.active.load(Ordering::SeqCst);
    let port = st.port.load(Ordering::SeqCst);
    serde_json::json!({ "active": active, "ip": lan_ip(), "port": port })
}

fn handle_conn(mut stream: TcpStream, st: &PhoneState) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let mut buf = [0u8; 2048];
    let mut req = Vec::new();
    if let Ok(n) = stream.read(&mut buf) {
        req.extend_from_slice(&buf[..n]);
    }
    let first = String::from_utf8_lossy(&req);
    let path = first.split_whitespace().nth(1).unwrap_or("/");
    let (status, ctype, body) = match path {
        "/api/state" => {
            let sessions = st.sessions.lock().unwrap().clone();
            let pet = st.pet_image.lock().unwrap().clone();
            let merged = serde_json::json!({
                "active": st.active.load(Ordering::SeqCst),
                "sessions": serde_json::from_str::<serde_json::Value>(&sessions).unwrap_or(serde_json::Value::Null),
                "petImage": serde_json::from_str::<serde_json::Value>(&pet).unwrap_or(serde_json::Value::Null),
            });
            ("200 OK", "application/json; charset=utf-8", merged.to_string())
        }
        "/" | "/index.html" => ("200 OK", "text/html; charset=utf-8", page_html().to_string()),
        _ => ("404 Not Found", "text/plain; charset=utf-8", "not found".into()),
    };
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.flush();
}

// ——— Tauri 命令 ———

/// 启动服务（幂等）：绑定随机端口，返回 {active, ip, port}
#[tauri::command]
pub fn phone_server_start(state: State<'_, Arc<PhoneState>>) -> Result<serde_json::Value, String> {
    if state.active.load(Ordering::SeqCst) {
        return Ok(status_json(&state));
    }
    let listener = TcpListener::bind(("0.0.0.0", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    state.port.store(port, Ordering::SeqCst);
    state.active.store(true, Ordering::SeqCst);
    let st = Arc::clone(&state);
    std::thread::spawn(move || {
        while st.active.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => handle_conn(stream, &st),
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(120));
                }
                Err(_) => break,
            }
        }
        st.active.store(false, Ordering::SeqCst);
    });
    Ok(status_json(&state))
}

#[tauri::command]
pub fn phone_server_stop(state: State<'_, Arc<PhoneState>>) -> Result<(), String> {
    state.active.store(false, Ordering::SeqCst);
    *state.sessions.lock().unwrap() = Arc::new("null".into());
    *state.pet_image.lock().unwrap() = Arc::new("null".into());
    Ok(())
}

#[tauri::command]
pub fn phone_server_status(state: State<'_, Arc<PhoneState>>) -> serde_json::Value {
    status_json(&state)
}

/// 主窗推送会话摘要（JSON 数组字符串；前端已裁剪附件与轮数）
#[tauri::command]
pub fn phone_update_sessions(state: State<'_, Arc<PhoneState>>, payload: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&payload).map_err(|e| format!("格式错误：{e}"))?;
    *state.sessions.lock().unwrap() = Arc::new(payload);
    Ok(())
}

/// 桌宠窗推送形象快照（dataURL 字符串）
#[tauri::command]
pub fn phone_update_pet(state: State<'_, Arc<PhoneState>>, payload: String) -> Result<(), String> {
    if !payload.starts_with("data:image/") {
        return Err("快照格式应为 data:image/*".into());
    }
    *state.pet_image.lock().unwrap() = Arc::new(payload);
    Ok(())
}

const _: usize = MAX_MESSAGES; // 保留常量（页面端使用同名上限）
