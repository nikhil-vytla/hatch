//! MCP servers from settings, started by the daemon: one set per session, in
//! the session's directory. The agent reaches their tools only through `mcp`
//! effects, so every call is gated, journaled and cancellable like any other
//! effect. Servers speak newline-delimited JSON-RPC over stdio.
//!
//! A server is user-configured and runs unsandboxed, as in other agents. The
//! daemon kills its process group when the daemon stops, when a write to it
//! stalls, and when it doesn't answer a call it was told is cancelled; a
//! process that leaves the group (`setsid`) is out of reach.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde_json::{Value, json};
use strive_proto::{McpStatus, McpTool};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{Mutex, OnceCell, mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::sessions::SessionId;
use crate::settings::McpServerSetting;

const PROTOCOL_VERSION: &str = "2025-06-18";
/// How long one request may take while a server starts.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a whole start (initialize and every tools/list page) may take.
const START_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_PAGES: usize = 100;
/// A write that takes longer means the server has stopped reading.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a server has to answer a call it was told is cancelled.
const CANCEL_GRACE: Duration = Duration::from_secs(2);
/// A tool call's result is cut to this much text.
const RESULT_KEEP: usize = 256 * 1024;
/// A line from a server longer than this ends the connection.
const MAX_LINE: u64 = 16 * 1024 * 1024;

/// Every session's servers, started when its agent first registers.
#[derive(Default)]
pub struct Servers {
    sessions: StdMutex<HashMap<SessionId, Arc<OnceCell<Started>>>>,
}

/// One session's servers. Each session starts its own, so a slow server
/// holds up only its session.
struct Started {
    slots: Vec<Slot>,
    status: Vec<McpStatus>,
}

/// A configured server: the running process, restarted when it has died.
struct Slot {
    name: String,
    setting: McpServerSetting,
    cwd: PathBuf,
    log: PathBuf,
    tools: Vec<McpTool>,
    current: Mutex<Option<Arc<Server>>>,
}

/// What the agent is told about a session's servers.
pub struct Summary {
    pub status: Vec<McpStatus>,
    pub tools: Vec<McpTool>,
}

impl Servers {
    fn session(&self, id: &SessionId) -> Arc<OnceCell<Started>> {
        crate::sync::lock(&self.sessions).entry(id.clone()).or_default().clone()
    }

    /// The session's servers, starting them if this is the first ask.
    pub async fn for_session(
        &self,
        id: &SessionId,
        cwd: &Path,
        settings: &BTreeMap<String, McpServerSetting>,
        log_dir: &Path,
    ) -> Summary {
        let session = self.session(id);
        let started = session
            .get_or_init(|| async {
                let mut slots = Vec::new();
                let mut status = Vec::new();
                for (name, setting) in settings {
                    let log = log_dir.join(format!("mcp-{name}.log"));
                    match start_bounded(name, setting, cwd, &log).await {
                        Ok(server) => {
                            let tools = server.tools.len() as u64;
                            status.push(McpStatus { server: name.clone(), tools, error: None });
                            slots.push(Slot {
                                name: name.clone(),
                                setting: setting.clone(),
                                cwd: cwd.to_path_buf(),
                                log,
                                tools: server.tools.clone(),
                                current: Mutex::new(Some(Arc::new(server))),
                            });
                        }
                        Err(why) => {
                            crate::log!("MCP server {name} for session {} didn't start: {why}", id.as_str());
                            status.push(McpStatus { server: name.clone(), tools: 0, error: Some(why) });
                        }
                    }
                }
                Started { slots, status }
            })
            .await;
        Summary {
            status: started.status.clone(),
            tools: started.slots.iter().flat_map(|s| s.tools.iter().cloned()).collect(),
        }
    }

    /// The session's running server by name, restarted if it died.
    pub async fn server(&self, id: &SessionId, name: &str) -> Result<Arc<Server>, String> {
        let session = self.session(id);
        let slot = session
            .get()
            .and_then(|s| s.slots.iter().find(|s| s.name == name))
            .ok_or_else(|| format!("no MCP server named {name} is running for this session"))?;
        let mut current = slot.current.lock().await;
        if let Some(s) = current.as_ref().filter(|s| !s.is_dead()) {
            return Ok(s.clone());
        }
        crate::log!("restarting MCP server {name} for session {}", id.as_str());
        let server = Arc::new(start_bounded(&slot.name, &slot.setting, &slot.cwd, &slot.log).await?);
        *current = Some(server.clone());
        Ok(server)
    }

    /// Kills every server now, even ones a call still holds.
    pub async fn stop_all(&self) {
        let sessions: Vec<Arc<OnceCell<Started>>> = crate::sync::lock(&self.sessions).drain().map(|(_, s)| s).collect();
        for session in sessions {
            let Some(started) = session.get() else { continue };
            for slot in &started.slots {
                if let Some(s) = slot.current.lock().await.take() {
                    s.kill();
                }
            }
        }
    }
}

type Reply = Result<Value, String>;
type Pending = Arc<StdMutex<HashMap<u64, oneshot::Sender<Reply>>>>;

pub struct Server {
    pub name: String,
    pub tools: Vec<McpTool>,
    /// Lines to write, in order, by the writer task: queueing never blocks.
    outbox: mpsc::UnboundedSender<Value>,
    pending: Pending,
    next_id: AtomicU64,
    /// Once set, the server takes no more requests.
    dead: Arc<AtomicBool>,
    pgid: i32,
    tasks: [JoinHandle<()>; 2],
    _child: Child,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.kill();
        for t in &self.tasks {
            t.abort();
        }
    }
}

/// How a tool call ended.
pub enum Called {
    Done { text: String, is_error: bool, truncated: bool },
    Failed(String),
    Cancelled,
    TimedOut,
}

/// Starts a server, giving up after `START_TIMEOUT` however it stalls.
async fn start_bounded(name: &str, setting: &McpServerSetting, cwd: &Path, log: &Path) -> Result<Server, String> {
    match tokio::time::timeout(START_TIMEOUT, Server::start(name, setting, cwd, log)).await {
        Ok(r) => r,
        Err(_) => Err(format!("it didn't finish starting in {}s", START_TIMEOUT.as_secs())),
    }
}

fn kill_group(pgid: i32, dead: &AtomicBool) {
    dead.store(true, Ordering::SeqCst);
    // The whole group: servers started through npx or a shell have children.
    let _ = nix::sys::signal::killpg(nix::unistd::Pid::from_raw(pgid), nix::sys::signal::Signal::SIGKILL);
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
        let dead = Arc::new(AtomicBool::new(false));
        let pending: Pending = Arc::default();
        let (outbox, queued) = mpsc::unbounded_channel();
        let writer = tokio::spawn(write_lines(stdin, queued, pgid, dead.clone()));
        let reader = tokio::spawn(read_replies(stdout, outbox.clone(), pending.clone(), dead.clone()));
        let mut server = Server {
            name: name.to_string(),
            tools: Vec::new(),
            outbox,
            pending,
            next_id: AtomicU64::new(1),
            dead,
            pgid,
            tasks: [writer, reader],
            _child: child,
        };
        let init = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "strive", "version": env!("CARGO_PKG_VERSION")},
        });
        server.ask("initialize", init).await?;
        server.notify("notifications/initialized", json!({}));
        let mut cursor: Option<String> = None;
        let mut seen = HashSet::new();
        for _ in 0..MAX_PAGES {
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
                // A cursor seen before would loop forever.
                Some(next) if seen.insert(next.to_string()) => cursor = Some(next.to_string()),
                _ => return Ok(server),
            }
        }
        Ok(server)
    }

    pub fn is_dead(&self) -> bool {
        self.dead.load(Ordering::SeqCst)
    }

    /// Kills the server's process group; it takes no more requests.
    pub fn kill(&self) {
        kill_group(self.pgid, &self.dead);
    }

    /// Sends a request and waits for its reply during startup.
    async fn ask(&self, method: &str, params: Value) -> Result<Value, String> {
        let (_, reply) = self.send(method, params)?;
        match tokio::time::timeout(REQUEST_TIMEOUT, reply).await {
            Ok(Ok(r)) => r.map_err(|e| format!("{method} failed: {e}")),
            Ok(Err(_)) => Err(format!("it exited during {method}")),
            Err(_) => Err(format!("no reply to {method} in {}s", REQUEST_TIMEOUT.as_secs())),
        }
    }

    /// Queues a request; its reply arrives on the receiver.
    fn send(&self, method: &str, params: Value) -> Result<(u64, oneshot::Receiver<Reply>), String> {
        if self.is_dead() {
            return Err("the server has stopped".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        crate::sync::lock(&self.pending).insert(id, tx);
        let mut msg = json!({"jsonrpc": "2.0", "id": id, "method": method});
        msg["params"] = params;
        if self.outbox.send(msg).is_err() {
            crate::sync::lock(&self.pending).remove(&id);
            return Err(format!("it exited during {method}"));
        }
        Ok((id, rx))
    }

    fn notify(&self, method: &str, params: Value) {
        let mut msg = json!({"jsonrpc": "2.0", "method": method});
        msg["params"] = params;
        let _ = self.outbox.send(msg); // a dead server needs no notice
    }

    /// Calls a tool. `cancelled` is polled. A cancelled call is cancelled at
    /// the server too, and a server that doesn't answer within
    /// `CANCEL_GRACE` is killed: until the call returns, its effect holds the
    /// workspace, so nothing (a rewind, say) can race a tool that ignores
    /// the cancellation.
    pub async fn call(&self, tool: &str, arguments: Value, cancelled: &AtomicBool, timeout: Duration) -> Called {
        if cancelled.load(Ordering::SeqCst) {
            return Called::Cancelled;
        }
        let (id, mut reply) = match self.send("tools/call", json!({"name": tool, "arguments": arguments})) {
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
        self.notify("notifications/cancelled", json!({"requestId": id}));
        // Any answer (a result or an error) means it has stopped working on it.
        if tokio::time::timeout(CANCEL_GRACE, &mut reply).await.is_err() {
            crate::log!("MCP server {} didn't answer a cancelled call; stopping it", self.name);
            self.kill();
        }
        crate::sync::lock(&self.pending).remove(&id);
        gave_up
    }
}

/// Writes queued lines to the server. A write that stalls means the server
/// stopped reading: it is killed rather than left to block everyone.
async fn write_lines(
    mut stdin: ChildStdin,
    mut queued: mpsc::UnboundedReceiver<Value>,
    pgid: i32,
    dead: Arc<AtomicBool>,
) {
    while let Some(msg) = queued.recv().await {
        let Ok(mut line) = serde_json::to_vec(&msg) else { continue };
        line.push(b'\n');
        let written = tokio::time::timeout(WRITE_TIMEOUT, async {
            stdin.write_all(&line).await?;
            stdin.flush().await
        })
        .await;
        if !matches!(written, Ok(Ok(()))) {
            kill_group(pgid, &dead);
            return;
        }
    }
}

/// Routes replies to their requests, and refuses requests from the server
/// (strive offers it no sampling, roots or elicitation). When the server's
/// output ends, the server is marked dead and every waiting call fails.
async fn read_replies(
    stdout: ChildStdout,
    outbox: mpsc::UnboundedSender<Value>,
    pending: Pending,
    dead: Arc<AtomicBool>,
) {
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
                let _ = outbox.send(refusal); // queued, so the reader never waits on a write
            }
            _ => {} // a notification
        }
    }
    // Marked before the senders drop, so no call slips in after the last reply.
    dead.store(true, Ordering::SeqCst);
    crate::sync::lock(&pending).clear();
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
