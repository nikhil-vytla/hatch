//! What the gateway knows about provider wire formats: which API a request
//! targets, what it asks for, and how many tokens its response used.
//!
//! Everything here is pure; the daemon owns the network.

use serde_json::{Map, Value};
use strive_budget::InputRate;
use strive_proto::Usage;

/// A provider API the gateway can meter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Api {
    AnthropicMessages,
    OpenAiChat,
    OpenAiResponses,
}

impl Api {
    /// The API behind a gateway path, e.g. provider `anthropic`, path `/v1/messages`.
    pub fn for_path(provider: &str, path: &str) -> Option<Self> {
        match (provider, path) {
            ("anthropic", "/v1/messages") => Some(Api::AnthropicMessages),
            ("openai", "/v1/chat/completions") => Some(Api::OpenAiChat),
            ("openai", "/v1/responses") => Some(Api::OpenAiResponses),
            _ => None,
        }
    }
}

/// What a request asks for, as far as budgeting cares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestInfo {
    pub model: String,
    /// The request's own output cap, if it sets one.
    pub max_output: Option<u64>,
    pub stream: bool,
    /// Completions asked for (Chat Completions `n`); each can use the cap.
    pub choices: u64,
    /// The dearest rate the request's input can be billed at.
    pub input_rate: InputRate,
}

const SERVER_STATE: &str = "the request relies on conversation state kept by the provider, whose cost can't be bounded from the request; send the full history instead";
const REMOTE_INPUT: &str = "the request includes an image or file the provider fetches or keeps, whose cost can't be bounded from the request; send it inline instead";
const PREMIUM_TIER: &str =
    "the request asks for a service tier priced above the standard rates strive knows; leave service_tier unset";
/// Service tiers billed at (or below) the standard rates.
const STANDARD_TIERS: &[&str] = &["auto", "default", "flex", "standard_only"];
const SERVER_TOOLS: &str = "the request enables tools the provider runs and bills separately, which strive can't bound; use tools the agent runs itself";
/// Anthropic tools the provider runs itself (and bills per use). Other
/// Anthropic-defined tools (bash, text editor, computer) run on the client.
const ANTHROPIC_SERVER_TOOLS: &[&str] = &["web_search", "web_fetch", "code_execution"];

/// Reads a request body and returns what it asks for and the exact bytes to
/// send upstream. Refuses requests whose cost the body can't bound: those
/// relying on provider-kept conversation state or paid server-side tools.
/// Streaming Chat Completions requests are made to report usage, since a
/// call that can't be measured can't be billed.
pub fn prepare_request(api: Api, body: &[u8]) -> Result<(RequestInfo, Vec<u8>), &'static str> {
    let mut v: Value = serde_json::from_slice(body).map_err(|_| "the request body is not JSON")?;
    let obj = v.as_object_mut().ok_or("the request body is not a JSON object")?;
    let model = obj.get("model").and_then(Value::as_str).ok_or("the request names no model")?.to_string();
    let stream = obj.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let cap = |keys: &[&str]| keys.iter().find_map(|k| obj.get(*k).and_then(Value::as_u64));
    let max_output = match api {
        Api::AnthropicMessages => cap(&["max_tokens"]),
        Api::OpenAiChat => cap(&["max_completion_tokens", "max_tokens"]),
        Api::OpenAiResponses => cap(&["max_output_tokens"]),
    };
    let choices = if api == Api::OpenAiChat { obj.get("n").and_then(Value::as_u64).unwrap_or(1).max(1) } else { 1 };
    if api == Api::OpenAiResponses && (obj.contains_key("previous_response_id") || obj.contains_key("conversation")) {
        return Err(SERVER_STATE);
    }
    if uses_server_tools(api, obj) {
        return Err(SERVER_TOOLS);
    }
    if obj.get("service_tier").is_some_and(|t| !t.as_str().is_some_and(|t| STANDARD_TIERS.contains(&t))) {
        return Err(PREMIUM_TIER);
    }
    if names_remote_input(&Value::Object(obj.clone())) {
        return Err(REMOTE_INPUT);
    }
    // `cache_control` means a cache write only to Anthropic; elsewhere it's
    // just a name, in a tool's schema say.
    let input_rate =
        if api == Api::AnthropicMessages { cache_rate(&Value::Object(obj.clone())) } else { InputRate::Plain };
    let info = RequestInfo { model, max_output, stream, choices, input_rate };
    if api == Api::OpenAiChat && stream {
        let opts = obj.entry("stream_options").or_insert_with(|| Value::Object(Map::new()));
        if let Some(o) = opts.as_object_mut() {
            o.insert("include_usage".into(), Value::Bool(true));
        }
        let sent = serde_json::to_vec(&v).map_err(|_| "the request body is not JSON")?;
        return Ok((info, sent));
    }
    Ok((info, body.to_vec()))
}

fn uses_server_tools(api: Api, obj: &Map<String, Value>) -> bool {
    let tools = obj.get("tools").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    let kind = |t: &Value| t.get("type").and_then(Value::as_str).map(str::to_string);
    match api {
        Api::AnthropicMessages => {
            obj.contains_key("mcp_servers")
                || tools.iter().filter_map(kind).any(|k| ANTHROPIC_SERVER_TOOLS.iter().any(|s| k.starts_with(s)))
        }
        Api::OpenAiChat | Api::OpenAiResponses => {
            obj.contains_key("web_search_options")
                || tools.iter().any(|t| !matches!(kind(t).as_deref(), Some("function" | "custom")))
        }
    }
}

/// Whether the request's content names an image or file the provider
/// fetches by URL or keeps by id: its tokens don't show in the body. Inline
/// data does. Only content blocks count: a tool's schema or a tool call's
/// arguments may use the same names for their own things.
fn names_remote_input(v: &Value) -> bool {
    match v {
        Value::Object(o) => {
            let remote = |u: Option<&Value>| u.and_then(Value::as_str).is_some_and(|u| !u.starts_with("data:"));
            let source = o.get("source").and_then(|s| s.get("type")).and_then(Value::as_str);
            let fetched = match o.get("type").and_then(Value::as_str) {
                // Anthropic: the block's source says where its content is.
                Some("image" | "document") => matches!(source, Some("url" | "file")),
                // OpenAI Chat: an image by URL, or a file by id.
                Some("image_url") => remote(o.get("image_url").and_then(|i| i.get("url"))),
                Some("file") => o.get("file").is_some_and(|f| f.get("file_id").is_some()),
                // OpenAI Responses: an image or file by URL or id.
                Some("input_image" | "input_file") => {
                    remote(o.get("image_url")) || remote(o.get("file_url")) || o.contains_key("file_id")
                }
                _ => false,
            };
            let own_args = o.get("type").and_then(Value::as_str) == Some("tool_use");
            fetched
                || o.iter()
                    .filter(|(k, _)| !matches!(k.as_str(), "tools" | "input_schema" | "parameters"))
                    .filter(|(k, _)| !(own_args && k.as_str() == "input"))
                    .any(|(_, v)| names_remote_input(v))
        }
        Value::Array(a) => a.iter().any(names_remote_input),
        _ => false,
    }
}

/// Anthropic bills cache writes above the input rate, and one-hour writes
/// above that; a request asks for them with `cache_control` blocks.
fn cache_rate(v: &Value) -> InputRate {
    fn walk(v: &Value, rate: &mut InputRate) {
        match v {
            Value::Object(o) => {
                if let Some(cc) = o.get("cache_control") {
                    let long = cc.get("ttl").and_then(Value::as_str) == Some("1h");
                    *rate = if long || *rate == InputRate::CacheWriteLong {
                        InputRate::CacheWriteLong
                    } else {
                        InputRate::CacheWrite
                    };
                }
                o.values().for_each(|v| walk(v, rate));
            }
            Value::Array(a) => a.iter().for_each(|v| walk(v, rate)),
            _ => {}
        }
    }
    let mut rate = InputRate::Plain;
    walk(v, &mut rate);
    rate
}

/// Holds back a stream's last event until the call is settled. SDKs stop at
/// that event (`[DONE]`, `message_stop`, `response.completed`) without
/// waiting for the connection to close, so letting it through first would
/// let a client finish before the journal records how the call ended. Only
/// whole lines pass, so a marker split across chunks is still caught.
#[derive(Default)]
pub struct Holdback {
    partial: Vec<u8>,
    held: Vec<u8>,
    holding: bool,
}

const LAST_EVENTS: &[&str] = &["message_stop", "response.completed", "response.incomplete", "response.failed"];

fn is_last_event(line: &[u8]) -> bool {
    let line = String::from_utf8_lossy(line);
    let line = line.trim_end();
    if line == "data: [DONE]" || line == "data:[DONE]" {
        return true;
    }
    if let Some(name) = line.strip_prefix("event:") {
        return LAST_EVENTS.contains(&name.trim());
    }
    line.strip_prefix("data:").is_some_and(|data| {
        serde_json::from_str::<Value>(data.trim())
            .ok()
            .and_then(|v| v.get("type").and_then(Value::as_str).map(|t| LAST_EVENTS.contains(&t)))
            .unwrap_or(false)
    })
}

impl Holdback {
    /// What may go to the client now.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<u8> {
        if self.holding {
            self.held.extend_from_slice(bytes);
            return Vec::new();
        }
        self.partial.extend_from_slice(bytes);
        let Some(end) = self.partial.iter().rposition(|&b| b == b'\n') else { return Vec::new() };
        let rest = self.partial.split_off(end + 1);
        let whole = std::mem::replace(&mut self.partial, rest);
        let mut out = Vec::new();
        let mut lines = whole.split_inclusive(|&b| b == b'\n');
        for line in lines.by_ref() {
            if is_last_event(line) {
                self.holding = true;
                self.held.extend_from_slice(line);
                break;
            }
            out.extend_from_slice(line);
        }
        for line in lines {
            self.held.extend_from_slice(line);
        }
        if self.holding {
            self.held.append(&mut self.partial);
        }
        out
    }

    /// Everything not yet sent, for once the call is settled.
    pub fn rest(mut self) -> Vec<u8> {
        self.held.append(&mut self.partial);
        self.held
    }
}

/// The largest response (or single stream event) the meter reads. Real
/// responses are far smaller; past this, usage is unknown.
pub const MAX_METERED: usize = 16 * 1024 * 1024;

/// Reads usage out of a response as its bytes arrive.
pub struct UsageMeter {
    api: Api,
    stream: bool,
    /// Non-streaming: the body so far. Streaming: the current partial line.
    buf: Vec<u8>,
    /// Streaming: the data lines of the event being read.
    data: Vec<u8>,
    overflowed: bool,
    usage: Option<Usage>,
    /// Anthropic streams give input usage at the start and final output usage
    /// in `message_delta`; usage is final only once that arrives.
    anthropic_final: bool,
}

impl UsageMeter {
    pub fn new(api: Api, stream: bool) -> Self {
        Self { api, stream, buf: Vec::new(), data: Vec::new(), overflowed: false, usage: None, anthropic_final: false }
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        if self.overflowed {
            return;
        }
        if !self.stream {
            self.buf.extend_from_slice(bytes);
            self.overflowed = self.buf.len() > MAX_METERED;
            return;
        }
        for &b in bytes {
            if b != b'\n' {
                self.buf.push(b);
                if self.buf.len() + self.data.len() > MAX_METERED {
                    self.overflowed = true;
                    return;
                }
                continue;
            }
            let mut line = std::mem::take(&mut self.buf);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.is_empty() {
                let data = std::mem::take(&mut self.data);
                if let Ok(v) = serde_json::from_slice::<Value>(&data) {
                    self.on_event(&v);
                }
            } else if let Some(d) = line.strip_prefix(b"data:") {
                if !self.data.is_empty() {
                    self.data.push(b'\n');
                }
                self.data.extend_from_slice(d.strip_prefix(b" ").unwrap_or(d));
            }
        }
    }

    /// The call's usage, or `None` if the response never reported it (an
    /// error body, a stream cut before its usage arrived, or usage that
    /// isn't well-formed).
    pub fn finish(self) -> Option<Usage> {
        if self.overflowed {
            return None;
        }
        if self.stream {
            return match self.api {
                Api::AnthropicMessages if !self.anthropic_final => None,
                _ => self.usage,
            };
        }
        let v: Value = serde_json::from_slice(&self.buf).ok()?;
        match self.api {
            Api::AnthropicMessages => anthropic(v.get("usage")?, true),
            Api::OpenAiChat => openai(v.get("usage")?, "prompt_tokens", "completion_tokens", "prompt_tokens_details"),
            Api::OpenAiResponses => openai(v.get("usage")?, "input_tokens", "output_tokens", "input_tokens_details"),
        }
    }

    fn on_event(&mut self, v: &Value) {
        match (self.api, v.get("type").and_then(Value::as_str)) {
            (Api::AnthropicMessages, Some("message_start")) => {
                self.usage = v.pointer("/message/usage").and_then(|u| anthropic(u, false));
            }
            (Api::AnthropicMessages, Some("message_delta")) => {
                let (Some(u), Some(delta)) = (self.usage.as_mut(), v.get("usage")) else { return };
                let Some(output) = delta.get("output_tokens").and_then(Value::as_u64) else { return };
                u.output = output;
                if let Some((input, write, write_long, read)) = anthropic_counts(delta) {
                    (u.input, u.cache_read) = (input, read);
                    if delta.get("cache_creation").is_some() {
                        (u.cache_write, u.cache_write_long) = (write, write_long);
                    } else {
                        // Only the total: the writes known to be five-minute
                        // ones stay so, and the rest is priced at the dearer
                        // one-hour rate.
                        let total = write;
                        u.cache_write = u.cache_write.min(total);
                        u.cache_write_long = total - u.cache_write;
                    }
                }
                self.anthropic_final = true;
            }
            (Api::OpenAiChat, _) => {
                if let Some(u) = v.get("usage").filter(|u| u.is_object()) {
                    self.usage = openai(u, "prompt_tokens", "completion_tokens", "prompt_tokens_details");
                }
            }
            (Api::OpenAiResponses, Some("response.completed" | "response.incomplete" | "response.failed")) => {
                if let Some(u) = v.pointer("/response/usage").filter(|u| u.is_object()) {
                    self.usage = openai(u, "input_tokens", "output_tokens", "input_tokens_details");
                }
            }
            _ => {}
        }
    }
}

/// Input, cache-write (standard and one-hour) and cache-read counts, when
/// the input count is present.
fn anthropic_counts(u: &Value) -> Option<(u64, u64, u64, u64)> {
    let n = |k: &str| u.get(k).and_then(Value::as_u64);
    let input = n("input_tokens")?;
    let (write, write_long) = match u.get("cache_creation") {
        Some(cc) => (
            cc.get("ephemeral_5m_input_tokens").and_then(Value::as_u64).unwrap_or(0),
            cc.get("ephemeral_1h_input_tokens").and_then(Value::as_u64).unwrap_or(0),
        ),
        None => (n("cache_creation_input_tokens").unwrap_or(0), 0),
    };
    Some((input, write, write_long, n("cache_read_input_tokens").unwrap_or(0)))
}

/// Anthropic usage. A final report must carry numeric input and output
/// counts; anything else is unknown usage, not zero.
fn anthropic(u: &Value, final_report: bool) -> Option<Usage> {
    let (input, cache_write, cache_write_long, cache_read) = anthropic_counts(u)?;
    let output = u.get("output_tokens").and_then(Value::as_u64);
    if final_report && output.is_none() {
        return None;
    }
    Some(Usage { input, output: output.unwrap_or(0), cache_write, cache_write_long, cache_read })
}

/// OpenAI reports cached tokens inside the input total. Input and output
/// counts must both be numbers.
fn openai(u: &Value, input: &str, output: &str, details: &str) -> Option<Usage> {
    let total_in = u.get(input)?.as_u64()?;
    let out = u.get(output)?.as_u64()?;
    let cached = u.get(details).and_then(|d| d.get("cached_tokens")).and_then(Value::as_u64).unwrap_or(0);
    Some(Usage {
        input: total_in.saturating_sub(cached),
        output: out,
        cache_write: 0,
        cache_write_long: 0,
        cache_read: cached,
    })
}
