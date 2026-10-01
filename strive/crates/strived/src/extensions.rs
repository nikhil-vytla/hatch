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

/// An extension proposal for `name` that is applied now, with this digest
/// of its files: a person accepted it as it is.
pub fn proposed(state: &crate::server::State, cwd: &str, name: &str, digest: &Digest) -> bool {
    let Ok(Some(sid)) = crate::learning::find(state, cwd) else { return false };
    let Ok(entries) = crate::learning::journal(state, &sid) else { return false };
    strive_learning::fold(&entries).iter().any(|f| {
        matches!(&f.state.proposal.change, strive_proto::Change::Extension { name: n, .. } if n == name)
            && f.applied.as_ref().is_some_and(|a| a.after == *digest)
    })
}

/// What allowing the extension `name`, as it is now, for the session grants.
pub fn allowance(name: &str, digest: &Digest) -> PathBuf {
    PathBuf::from(format!("extension:{name}:{digest}"))
}

/// How long an extension's tests may run before they fail.
const TESTS_MS: u64 = 120_000;

/// The tests gate (ADR-0027): `files`' own `*.test.ts`, run with `bun test`
/// as a command in the sandbox, in a directory of their own the daemon
/// makes and removes. Without a sandbox they don't run, and that fails: an
/// extension's code isn't run unconfined to check it.
pub fn tests(
    files: &[strive_proto::ExtensionFile],
    strive_home: &Path,
    unconfined: bool,
) -> (strive_proto::Verdict, String) {
    use strive_proto::Verdict;
    if !files.iter().any(|f| f.path.ends_with(".test.ts")) {
        return (Verdict::Skipped, "it has no tests (*.test.ts)".into());
    }
    let sandboxed = !unconfined && crate::effects::sandbox_available();
    if !sandboxed && !unconfined {
        return (Verdict::Fail, "there's no sandbox to run its tests in".into());
    }
    let made = std::env::temp_dir().join(format!(
        "strive-ext-tests-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos())
    ));
    let run = || -> std::io::Result<crate::effects::Result> {
        std::fs::create_dir(&made)?;
        let dir = made.canonicalize()?;
        for f in files {
            let path = dir.join(&f.path);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(path, &f.content)?;
        }
        let scope = crate::effects::Scope {
            workspace: dir,
            strive_home: strive_home.to_path_buf(),
            unconfined,
            imports: Vec::new(),
        };
        let cancelled = std::sync::atomic::AtomicBool::new(false);
        Ok(crate::effects::bash(&scope, "bun test", TESTS_MS, sandboxed, &cancelled))
    };
    let result = run();
    let _ = std::fs::remove_dir_all(&made);
    match result {
        Err(e) => (Verdict::Fail, format!("its tests couldn't be set up: {e}")),
        Ok(crate::effects::Result::Done { text, exit_code: Some(0), .. }) => (Verdict::Pass, tail(&text)),
        Ok(crate::effects::Result::Done { text, exit_code: Some(code), .. }) => {
            (Verdict::Fail, format!("bun test exited {code}:\n{}", tail(&text)))
        }
        Ok(crate::effects::Result::Done { .. }) => (Verdict::Fail, format!("its tests ran past {}s", TESTS_MS / 1000)),
        Ok(crate::effects::Result::Refused(why)) => (Verdict::Fail, format!("its tests didn't run: {why}")),
    }
}

/// The end of a test run's output, where its summary is.
fn tail(text: &str) -> String {
    let lines: Vec<&str> = text.trim_end().lines().collect();
    lines[lines.len().saturating_sub(15)..].join("\n")
}
