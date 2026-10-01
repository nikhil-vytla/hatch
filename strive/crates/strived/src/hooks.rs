//! Hooks (ADR-0028): an accepted extension's code, run in the sandbox
//! before an effect, that may ask a person about it or refuse it, and
//! nothing else.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use serde_json::Value;
use strive_proto::EffectRequest;

use crate::effects::{Gate, Scope};
use crate::server::State;

/// The runner `bun -e` runs: its arguments are the extension's directory
/// and the call as hex-encoded JSON. What the hook answers follows the
/// marker, so what it logs can't be taken for its answer. It holds no
/// single quote, so the shell keeps it whole.
const RUNNER: &str = "const [dir, hex] = process.argv.slice(1);\
const call = JSON.parse(Buffer.from(hex, \"hex\").toString(\"utf8\"));\
const mod = await import(dir + \"/index.ts\");\
const fn = mod.hooks && mod.hooks.tool_call;\
if (typeof fn !== \"function\") { console.error(\"index.ts exports no hooks.tool_call function\"); process.exit(2); }\
const out = await fn(call, { cwd: process.cwd() });\
process.stdout.write(\"\\n\" + MARK + JSON.stringify(out ?? null));";

/// What precedes a hook's answer in its output.
const MARK: &str = "@@strive-hook@@";

/// The most a call shown to a hook holds, as JSON: hex-encoded, it is one
/// argument of the command, and Linux allows 128 KiB for one.
const CALL_LIMIT: usize = 32 * 1024;

/// How long a hook may run.
const HOOK_MS: u64 = 10_000;

/// The call as a hook is shown it: the request as the protocol has it,
/// without a write's or edit's text or a tool's arguments if together
/// they'd pass the limit, and then with `"truncated": true`. `None` if
/// even that passes it.
pub fn call(request: &EffectRequest) -> Option<Value> {
    let mut call = serde_json::to_value(request).ok()?;
    if call.to_string().len() > CALL_LIMIT
        && let Some(fields) = call.as_object_mut()
    {
        for key in ["content", "oldText", "newText", "arguments"] {
            fields.remove(key);
        }
        fields.insert("truncated".into(), Value::Bool(true));
    }
    (call.to_string().len() <= CALL_LIMIT).then_some(call)
}

/// What a call does, as a person is asked about it.
fn describe(request: &EffectRequest) -> String {
    match request {
        EffectRequest::Read { path, .. } => format!("read {path}"),
        EffectRequest::Write { path, .. } => format!("write {path}"),
        EffectRequest::Edit { path, .. } => format!("edit {path}"),
        EffectRequest::Bash { command, .. } => format!("run: {command}"),
        EffectRequest::Mcp { server, tool, .. } => format!("use {server}'s {tool} tool"),
        EffectRequest::Check { name } => format!("run the check {name}"),
        EffectRequest::Extension { name, tool, .. } => format!("use {name}'s tool {tool}"),
    }
}

/// The effect kind, as a hook's `tools` names it.
fn kind(request: &EffectRequest) -> &'static str {
    match request {
        EffectRequest::Read { .. } => "read",
        EffectRequest::Write { .. } => "write",
        EffectRequest::Edit { .. } => "edit",
        EffectRequest::Bash { .. } => "bash",
        EffectRequest::Mcp { .. } => "mcp",
        EffectRequest::Check { .. } => "check",
        EffectRequest::Extension { .. } => "extension",
    }
}

/// What one hook said about a call.
enum Said {
    Nothing,
    Ask(String),
    Deny(String),
}

/// `gate` for `request` (as the host asked for it), made stricter by the
/// project's accepted hooks: a refusal if one denies it, a question if one
/// asks or fails. Never less strict than `gate`. Whether a hook changed it
/// comes with it. A session in safe mode runs none.
pub async fn stricter(
    state: &State,
    session: &strive_proto::SessionInfo,
    scope: &Scope,
    request: &EffectRequest,
    allowed: &[PathBuf],
    gate: Gate,
) -> (Gate, bool) {
    if session.safe || matches!(gate, Gate::Deny(_)) {
        return (gate, false);
    }
    let kind = kind(request);
    let ws = scope.workspace.clone();
    let Ok(extensions) = tokio::task::spawn_blocking(move || crate::context::extensions(&ws, &mut Vec::new())).await
    else {
        return (gate, false);
    };
    let mut asks = Vec::new();
    for e in extensions.iter().filter(|e| e.hooks.iter().any(|h| h.sees(kind))) {
        let name = e.info.name.clone();
        let digest = strive_journal::cas::digest(&strive_learning::extension_dir::canonical(&e.files));
        let accepted = crate::extensions::proposed(state, &session.cwd, &name, &digest)
            || allowed.contains(&crate::extensions::allowance(&name, &digest));
        if !accepted {
            continue;
        }
        let Some(shown) = call(request) else {
            asks.push(format!("the call is too large for {name}'s hook to see"));
            continue;
        };
        let dir = scope.workspace.join(strive_learning::EXTENSIONS_DIR).join(&name);
        let scope = scope.clone();
        let answered =
            tokio::task::spawn_blocking(move || run(&scope, &dir, &shown)).await.unwrap_or_else(|e| Err(e.to_string()));
        match answered {
            Ok(Said::Nothing) => {}
            Ok(Said::Ask(why)) => asks.push(format!("{name}'s hook asks: {why}")),
            Ok(Said::Deny(why)) => return (Gate::Deny(format!("{name}'s hook refused this: {why}")), true),
            // Every time: leaving out a hook that keeps failing would let
            // through what it might refuse, and the agent can make it fail.
            Err(why) => asks.push(format!("{name}'s hook failed: {why}; rolling {name} back stops it")),
        }
    }
    if asks.is_empty() {
        return (gate, false);
    }
    let because = asks.join("; ");
    let gate = match gate {
        Gate::Allow => Gate::Ask(format!("{} ({because})", describe(request)), None),
        Gate::Ask(what, file) => Gate::Ask(format!("{what} ({because})"), file),
        Gate::Deny(why) => Gate::Deny(why),
    };
    (gate, true)
}

/// Runs the hook in `dir` on `call`, in the sandbox.
fn run(scope: &Scope, dir: &Path, call: &Value) -> Result<Said, String> {
    let sandboxed = !scope.unconfined && crate::effects::sandbox_available();
    if !sandboxed && !scope.unconfined {
        return Err("there's no sandbox to run it in".into());
    }
    let hex = call.to_string().bytes().fold(String::new(), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    });
    let runner = RUNNER.replace("MARK", &format!("\"{MARK}\""));
    let command = format!("bun -e '{runner}' '{}' {hex}", dir.display().to_string().replace('\'', "'\\''"));
    let cancelled = std::sync::atomic::AtomicBool::new(false);
    match crate::effects::bash(scope, &command, HOOK_MS, sandboxed, &cancelled) {
        crate::effects::Result::Done { text, exit_code: Some(0), .. } => answer(&text),
        crate::effects::Result::Done { text, exit_code: Some(code), .. } => {
            Err(format!("it exited {code}: {}", text.trim().lines().last().unwrap_or("")))
        }
        crate::effects::Result::Done { .. } => Err(format!("it ran past {}s", HOOK_MS / 1000)),
        crate::effects::Result::Refused(why) => Err(why),
    }
}

/// What a hook's output says it answered.
fn answer(output: &str) -> Result<Said, String> {
    let Some((_, json)) = output.rsplit_once(MARK) else { return Err("it gave no answer".into()) };
    let value: Value = serde_json::from_str(json.trim()).map_err(|_| format!("it answered {}", json.trim()))?;
    let reason = || value["reason"].as_str().filter(|r| !r.trim().is_empty()).unwrap_or("no reason given").to_string();
    match (&value, value["decision"].as_str()) {
        (Value::Null, _) => Ok(Said::Nothing),
        (Value::Object(_), Some("ask")) => Ok(Said::Ask(reason())),
        (Value::Object(_), Some("deny")) => Ok(Said::Deny(reason())),
        _ => Err(format!(
            "it answered {value}; a hook answers {{\"decision\": \"ask\" or \"deny\", \"reason\"}}, or nothing"
        )),
    }
}
