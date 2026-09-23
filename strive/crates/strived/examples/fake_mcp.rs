//! A scripted MCP server for strived's tests: stdio, newline-delimited
//! JSON-RPC. `cargo test` builds it; tests point `mcpServers` at it.
//!
//! Tools: `echo {text}`, `fail` (an error result), `slow` (answers after
//! 30 s), `where` (its working directory and what it can see of the
//! environment). `FAKE_MCP_PID` names a file to write its pid to, and
//! `FAKE_MCP_LOG` a file to append the notifications it gets to. With
//! `FAKE_MCP_STUBBORN` it outlives its stdin closing, as some servers do.
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
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let msg: Value = serde_json::from_str(&line).unwrap();
        let method = msg["method"].as_str().unwrap_or_default().to_string();
        let Some(id) = msg.get("id").cloned() else {
            if let Ok(log) = std::env::var("FAKE_MCP_LOG") {
                let mut f = std::fs::OpenOptions::new().create(true).append(true).open(log).unwrap();
                writeln!(f, "{method} {}", msg["params"]).unwrap();
            }
            continue;
        };
        let out = out.clone();
        // Calls run on their own threads, so a slow one doesn't hold up the rest.
        std::thread::spawn(move || {
            let result = match method.as_str() {
                "initialize" => json!({"protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
                    "serverInfo": {"name": "fake", "version": "0"}}),
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
            {"name": "where", "description": "Where it runs.", "inputSchema": empty},
        ]}),
    }
}

fn call(tool: &str, args: &Value) -> Value {
    let text = |t: String| json!({"content": [{"type": "text", "text": t}]});
    match tool {
        "echo" => text(format!("echo: {}", args["text"].as_str().unwrap_or_default())),
        "fail" => json!({"content": [{"type": "text", "text": "it broke"}], "isError": true}),
        "slow" => {
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
