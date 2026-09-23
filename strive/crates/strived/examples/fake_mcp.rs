//! A scripted MCP server for strived's tests: stdio, newline-delimited
//! JSON-RPC. `cargo test` builds it; tests point `mcpServers` at it.
//!
//! Tools: `echo {text}`, `fail` (an error result), `slow` (answers after
//! 30 s, ignoring cancellation), `patient` (the same, but a cancellation
//! ends it at once), `where` (its working directory and what it can see of
//! the environment). `FAKE_MCP_PID` names a file to write its pid to, and
//! `FAKE_MCP_LOG` a file to append the tool calls and notifications it gets to. With
//! `FAKE_MCP_STUBBORN` it outlives its stdin closing, as some servers do.
//! With `FAKE_MCP_DEAF` it stops reading once it has listed its tools. With
//! `FAKE_MCP_LOOP` every tools/list page names the same next cursor.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "a test fixture")]

use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

fn main() {
    if let Ok(p) = std::env::var("FAKE_MCP_PID") {
        std::fs::write(p, std::process::id().to_string()).unwrap();
    }
    if std::env::var("FAKE_MCP_BROKEN").is_ok() {
        eprintln!("refusing to start");
        std::process::exit(3);
    }
    let out = Arc::new(Mutex::new(std::io::stdout()));
    let patient = Arc::new(Mutex::new(std::collections::HashSet::new()));
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let msg: Value = serde_json::from_str(&line).unwrap();
        let method = msg["method"].as_str().unwrap_or_default().to_string();
        let log = |line: String| {
            if let Ok(log) = std::env::var("FAKE_MCP_LOG") {
                let mut f = std::fs::OpenOptions::new().create(true).append(true).open(log).unwrap();
                writeln!(f, "{line}").unwrap();
            }
        };
        let Some(id) = msg.get("id").cloned() else {
            log(format!("{method} {}", msg["params"]));
            // A cancelled `patient` call answers now, with an error.
            let cancelled = msg["params"]["requestId"].clone();
            if method == "notifications/cancelled" && patient.lock().unwrap().remove(&cancelled.to_string()) {
                let reply =
                    json!({"jsonrpc": "2.0", "id": cancelled, "error": {"code": -32800, "message": "cancelled"}});
                writeln!(out.lock().unwrap(), "{reply}").unwrap();
            }
            continue;
        };
        if msg["params"]["name"] == "patient" {
            patient.lock().unwrap().insert(id.to_string());
        }
        if method == "tools/call" {
            log(format!("call {}", msg["params"]["name"]));
        }
        // Deaf after the last page of tools (the one asked for with a cursor).
        let deaf =
            method == "tools/list" && !msg["params"]["cursor"].is_null() && std::env::var("FAKE_MCP_DEAF").is_ok();
        let out = out.clone();
        // Calls run on their own threads, so a slow one doesn't hold up the rest.
        std::thread::spawn(move || {
            let result = match method.as_str() {
                "initialize" => json!({"protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
                    "serverInfo": {"name": "fake", "version": "0"}}),
                "tools/list" if std::env::var("FAKE_MCP_LOOP").is_ok() => {
                    json!({"tools": [{"name": "echo", "inputSchema": {"type": "object"}}], "nextCursor": "again"})
                }
                "tools/list" => tools(msg["params"]["cursor"].as_str()),
                "tools/call" => call(msg["params"]["name"].as_str().unwrap_or_default(), &msg["params"]["arguments"]),
                _ => {
                    let reply =
                        json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "no such method"}});
                    writeln!(out.lock().unwrap(), "{reply}").unwrap();
                    return;
                }
            };
            writeln!(out.lock().unwrap(), "{}", json!({"jsonrpc": "2.0", "id": id, "result": result})).unwrap();
        });
        if deaf {
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
    }
    if std::env::var("FAKE_MCP_STUBBORN").is_ok() {
        std::thread::sleep(std::time::Duration::from_secs(60));
    }
}

/// Two pages, to exercise cursors.
fn tools(cursor: Option<&str>) -> Value {
    let schema = json!({"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]});
    let empty = json!({"type": "object", "properties": {}});
    match cursor {
        None => json!({"tools": [
            {"name": "echo", "description": "Says the text back.", "inputSchema": schema},
            {"name": "fail", "description": "Always fails.", "inputSchema": empty},
        ], "nextCursor": "page2"}),
        Some(_) => json!({"tools": [
                        {"name": "slow", "description": "Takes 30 seconds.", "inputSchema": empty},
            {"name": "patient", "description": "Takes 30 seconds unless cancelled.", "inputSchema": empty},
            {"name": "where", "description": "Where it runs.", "inputSchema": empty},
        ]}),
    }
}

fn call(tool: &str, args: &Value) -> Value {
    let text = |t: String| json!({"content": [{"type": "text", "text": t}]});
    match tool {
        "echo" => text(format!("echo: {}", args["text"].as_str().unwrap_or_default())),
        "fail" => json!({"content": [{"type": "text", "text": "it broke"}], "isError": true}),
        "slow" | "patient" => {
            std::thread::sleep(std::time::Duration::from_secs(30));
            text("finally".into())
        }
        "where" => text(format!(
            "cwd={} key={} var={}",
            std::env::current_dir().unwrap().display(),
            std::env::var("ANTHROPIC_API_KEY").unwrap_or_else(|_| "unset".into()),
            std::env::var("FAKE_VAR").unwrap_or_else(|_| "unset".into()),
        )),
        _ => json!({"content": [{"type": "text", "text": format!("no tool {tool}")}], "isError": true}),
    }
}
