//! Running an extension's tool (ADR-0027): a fixed runner, inline, that
//! imports the extension and calls one tool, run as a command in the
//! sandbox. The extension's code never runs in the daemon or the host.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use strive_proto::{Digest, EffectRequest};

/// The runner `bun -e` runs: its arguments are the extension's directory,
/// the tool, and the arguments as hex-encoded JSON. A tool returns a string,
/// or anything JSON shows. It holds no single quote, so the shell keeps it whole.
const RUNNER: &str = "const [dir, tool, hex] = process.argv.slice(1);\
const args = JSON.parse(Buffer.from(hex, \"hex\").toString(\"utf8\"));\
const mod = await import(dir + \"/index.ts\");\
const fn = mod.tools && mod.tools[tool];\
if (typeof fn !== \"function\") { console.error(\"index.ts exports no tools.\" + tool + \" function\"); process.exit(2); }\
const out = await fn(args, { cwd: process.cwd() });\
process.stdout.write(typeof out === \"string\" ? out : JSON.stringify(out, null, 2) ?? \"\");";

/// The command that calls `tool` of `extension` with `arguments`, if the
/// tool is declared and the arguments are an object.
pub fn run(
    workspace: &Path,
    extension: &crate::context::Extension,
    tool: &str,
    arguments: &serde_json::Value,
) -> Result<EffectRequest, String> {
    if !extension.info.tools.iter().any(|t| t.name == tool) {
        return Err(format!("the extension {} declares no tool {tool:?}", extension.info.name));
    }
    if !arguments.is_object() {
        return Err(format!("{}'s {tool} takes its arguments as a JSON object", extension.info.name));
    }
    let dir = workspace.join(strive_learning::EXTENSIONS_DIR).join(&extension.info.name);
    let hex = serde_json::to_vec(arguments).map_err(|e| e.to_string())?.iter().fold(String::new(), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    });
    let command = format!("bun -e '{RUNNER}' {} {tool} {hex}", quote(&dir.display().to_string()));
    Ok(EffectRequest::Bash { command, timeout_ms: None })
}

/// `s` as one shell word.
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// What allowing the extension `name`, as it is now, for the session grants.
pub fn allowance(name: &str, digest: &Digest) -> PathBuf {
    PathBuf::from(format!("extension:{name}:{digest}"))
}
