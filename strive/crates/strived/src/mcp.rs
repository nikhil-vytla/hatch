//! MCP servers from settings, started by the daemon: one set per session, in
//! the session's directory. The agent reaches their tools only through `mcp`
//! effects, so every call is gated, journaled and cancellable like any other
//! effect. Servers speak newline-delimited JSON-RPC over stdio.

use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde_json::{Value, json};
use strive_proto::{McpStatus, McpTool};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{Mutex, oneshot};
use tokio::task::JoinHandle;

use crate::sessions::SessionId;
use crate::settings::McpServerSetting;

const PROTOCOL_VERSION: &str = "2025-06-18";
const START_TIMEOUT: Duration = Duration::from_secs(30);
/// A tool call's result is cut to this much text.
const RESULT_KEEP: usize = 256 * 1024;
/// A line from a server longer than this ends the connection.
const MAX_LINE: u64 = 16 * 1024 * 1024;

/// Every session's servers, started when its agent first registers.
#[derive(Default)]
pub struct Servers {
    by_session: Mutex<HashMap<SessionId, Arc<Started>>>,
}

pub struct Started {
    servers: Vec<Arc<Server>>,
    pub status: Vec<McpStatus>,
}

impl Started {
    pub fn tools(&self) -> Vec<McpTool> {
        self.servers.iter().flat_map(|s| s.tools.iter().cloned()).collect()
    }
}

impl Servers {
    /// The session's servers, starting them if this is the first ask.
    pub async fn for_session(
        &self,
        id: &SessionId,
        cwd: &Path,
        settings: &BTreeMap<String, McpServerSetting>,
        log_dir: &Path,
    ) -> Arc<Started> {
        // Held while starting, so one session's servers start once.
        let mut map = self.by_session.lock().await;
        if let Some(s) = map.get(id) {
            return s.clone();
        }
        let mut servers = Vec::new();
        let mut status = Vec::new();
        for (name, setting) in settings {
            let log = log_dir.join(format!("mcp-{name}.log"));
            match Server::start(name, setting, cwd, &log).await {
                Ok(s) => {
                    status.push(McpStatus { server: name.clone(), tools: s.tools.len() as u64, error: None });
                    servers.push(Arc::new(s));
                }
                Err(why) => {
                    crate::log!("MCP server {name} for session {} didn't start: {why}", id.as_str());
                    status.push(McpStatus { server: name.clone(), tools: 0, error: Some(why) });
                }
            }
        }
        let started = Arc::new(Started { servers, status });
        map.insert(id.clone(), started.clone());
        started
    }

    pub async fn server(&self, id: &SessionId, name: &str) -> Option<Arc<Server>> {
        self.by_session.lock().await.get(id)?.servers.iter().find(|s| s.name == name).cloned()
    }

    /// Stops every server (dropping the last reference kills its process group).
    pub async fn stop_all(&self) {
        self.by_session.lock().await.clear();
    }
}

type Reply = Result<Value, String>;
type Pending = Arc<StdMutex<HashMap<u64, oneshot::Sender<Reply>>>>;

pub struct Server {
    pub name: String,
    pub tools: Vec<McpTool>,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Pending,
    next_id: AtomicU64,
    pgid: i32,
    reader: JoinHandle<()>,
    _child: Child,
}

impl Drop for Server {
    fn drop(&mut self) {
        // The whole group: servers started through npx or a shell have children.
        let _ = nix::sys::signal::killpg(nix::unistd::Pid::from_raw(self.pgid), nix::sys::signal::Signal::SIGKILL);
        self.reader.abort();
    }
}

/// How a tool call ended.
pub enum Called {
    Done { text: String, is_error: bool, truncated: bool },
    Failed(String),
    Cancelled,
    TimedOut,
}

impl Server {
    async fn start(name: &str, setting: &McpServerSetting, cwd: &Path, log: &Path) -> Result<Server, String> {
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log)
            .map_err(|e| format!("can't open its log {}: {e}", log.display()))?;
        let mut cmd = tokio::process::Command::new(&setting.command);
        cmd.args(&setting.args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(log)
            .kill_on_drop(true)
            .process_group(0);
        for (k, _) in std::env::vars_os() {
            if k.to_str().is_some_and(|k| k.starts_with("STRIVE_") || k == "ANTHROPIC_API_KEY" || k == "OPENAI_API_KEY")
            {
                cmd.env_remove(&k);
            }
        }
        cmd.envs(&setting.env);
        let mut child = cmd.spawn().map_err(|e| format!("can't run {}: {e}", setting.command))?;
        let pgid = child.id().and_then(|p| i32::try_from(p).ok()).ok_or("it exited at once")?;
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            return Err("its stdio wasn't piped".into());
        };
        let stdin = Arc::new(Mutex::new(stdin));
        let pending: Pending = Arc::default();
        let reader = tokio::spawn(read_replies(stdout, stdin.clone(), pending.clone()));
        let mut server = Server {
            name: name.to_string(),
            tools: Vec::new(),
            stdin,
            pending,
            next_id: AtomicU64::new(1),
            pgid,
            reader,
            _child: child,
        };
        let init = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "strive", "version": env!("CARGO_PKG_VERSION")},
        });
        server.ask("initialize", init).await?;
        server.notify("notifications/initialized", json!({})).await?;
        let mut cursor: Option<String> = None;
        loop {
            let params = cursor.as_ref().map_or_else(|| json!({}), |c| json!({"cursor": c}));
            let page = server.ask("tools/list", params).await?;
            for t in page["tools"].as_array().into_iter().flatten() {
                let Some(tool) = t["name"].as_str() else { continue };
                server.tools.push(McpTool {
                    server: name.to_string(),
                    name: tool.to_string(),
                    description: t["description"].as_str().unwrap_or_default().to_string(),
                    input_schema: t.get("inputSchema").cloned().unwrap_or_else(|| json!({"type": "object"})),
                });
            }
            match page["nextCursor"].as_str() {
                Some(next) => cursor = Some(next.to_string()),
                None => break,
            }
        }
        Ok(server)
    }

    /// Sends a request and waits for its reply during startup.
    async fn ask(&self, method: &str, params: Value) -> Result<Value, String> {
        let (_, reply) = self.send(method, params).await?;
        match tokio::time::timeout(START_TIMEOUT, reply).await {
            Ok(Ok(r)) => r.map_err(|e| format!("{method} failed: {e}")),
            Ok(Err(_)) => Err(format!("it exited during {method}")),
            Err(_) => Err(format!("no reply to {method} in {}s", START_TIMEOUT.as_secs())),
        }
    }

    async fn send(&self, method: &str, params: Value) -> Result<(u64, oneshot::Receiver<Reply>), String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        crate::sync::lock(&self.pending).insert(id, tx);
        let msg = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        if let Err(e) = write_line(&self.stdin, &msg).await {
            crate::sync::lock(&self.pending).remove(&id);
            // A server that has exited closes its end: the same failure as
            // seeing it exit while waiting for the reply.
            if e.kind() == std::io::ErrorKind::BrokenPipe {
                return Err(format!("it exited during {method}"));
            }
            return Err(format!("can't write to it: {e}"));
        }
        Ok((id, rx))
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let msg = json!({"jsonrpc": "2.0", "method": method, "params": params});
        write_line(&self.stdin, &msg).await.map_err(|e| format!("can't write to it: {e}"))
    }

    /// Calls a tool. `cancelled` is polled; a cancelled call is also
    /// cancelled at the server.
    pub async fn call(&self, tool: &str, arguments: Value, cancelled: &AtomicBool, timeout: Duration) -> Called {
        let (id, mut reply) = match self.send("tools/call", json!({"name": tool, "arguments": arguments})).await {
            Ok(r) => r,
            Err(why) => return Called::Failed(why),
        };
        let deadline = tokio::time::Instant::now() + timeout;
        let mut poll = tokio::time::interval(Duration::from_millis(100));
        let gave_up = loop {
            tokio::select! {
                r = &mut reply => return match r {
                    Ok(Ok(result)) => content(&result),
                    Ok(Err(e)) => Called::Failed(e),
                    Err(_) => Called::Failed("the server exited during the call".into()),
                },
                () = tokio::time::sleep_until(deadline) => break Called::TimedOut,
                _ = poll.tick() => if cancelled.load(Ordering::SeqCst) { break Called::Cancelled },
            }
        };
        crate::sync::lock(&self.pending).remove(&id);
        let _ = self.notify("notifications/cancelled", json!({"requestId": id})).await; // best effort
        gave_up
    }
}

async fn write_line(stdin: &Mutex<ChildStdin>, msg: &Value) -> std::io::Result<()> {
    let mut line = serde_json::to_vec(msg).map_err(std::io::Error::other)?;
    line.push(b'\n');
    let mut w = stdin.lock().await;
    w.write_all(&line).await?;
    w.flush().await
}

/// Routes replies to their requests, and refuses requests from the server
/// (strive offers it no sampling, roots or elicitation).
async fn read_replies(stdout: tokio::process::ChildStdout, stdin: Arc<Mutex<ChildStdin>>, pending: Pending) {
    let mut r = BufReader::new(stdout);
    let mut line = Vec::new();
    loop {
        line.clear();
        match (&mut r).take(MAX_LINE).read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) if !line.ends_with(b"\n") => break, // over the limit
            Ok(_) => {}
        }
        let Ok(msg) = serde_json::from_slice::<Value>(&line) else { continue };
        match (msg.get("id"), msg.get("method")) {
            (Some(id), None) => {
                let Some(waiting) = id.as_u64().and_then(|id| crate::sync::lock(&pending).remove(&id)) else {
                    continue;
                };
                let reply = match msg.get("error") {
                    Some(e) => Err(e["message"].as_str().unwrap_or("an error").to_string()),
                    None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = waiting.send(reply); // the caller may have given up
            }
            (Some(id), Some(_)) => {
                let refusal =
                    json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "not supported"}});
                if write_line(&stdin, &refusal).await.is_err() {
                    break;
                }
            }
            _ => {} // a notification
        }
    }
    crate::sync::lock(&pending).clear(); // dropping the senders fails every waiting call
}

/// A tool result's content as text for the model.
fn content(result: &Value) -> Called {
    let mut text = String::new();
    for item in result["content"].as_array().into_iter().flatten() {
        if !text.is_empty() {
            text.push('\n');
        }
        match item["type"].as_str() {
            Some("text") => text.push_str(item["text"].as_str().unwrap_or_default()),
            Some("image" | "audio") => {
                let _ = write!(
                    text,
                    "[{} {}]",
                    item["type"].as_str().unwrap_or("media"),
                    item["mimeType"].as_str().unwrap_or("")
                );
            }
            Some("resource") => text.push_str(
                item["resource"]["text"].as_str().or_else(|| item["resource"]["uri"].as_str()).unwrap_or_default(),
            ),
            Some("resource_link") => text.push_str(item["uri"].as_str().unwrap_or_default()),
            _ => {}
        }
    }
    if text.is_empty()
        && let Some(structured) = result.get("structuredContent")
    {
        text = structured.to_string();
    }
    let truncated = text.len() > RESULT_KEEP;
    if truncated {
        let mut cut = RESULT_KEEP;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str("\n[... the rest of the result was cut]");
    }
    Called::Done { text, is_error: result["isError"].as_bool().unwrap_or(false), truncated }
}
