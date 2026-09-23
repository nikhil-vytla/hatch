//! What the gateway knows about provider wire formats: which API a request
//! targets, what it asks for, and how many tokens its response used.
//!
//! Everything here is pure; the daemon owns the network.

use serde_json::{Map, Value};
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
}

/// Reads a request body and returns what it asks for and the exact bytes to
/// send upstream. Streaming Chat Completions requests are made to report
/// usage, since a call that can't be measured can't be billed.
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
    if api == Api::OpenAiChat && stream {
        let opts = obj.entry("stream_options").or_insert_with(|| Value::Object(Map::new()));
        if let Some(o) = opts.as_object_mut() {
            o.insert("include_usage".into(), Value::Bool(true));
        }
        let sent = serde_json::to_vec(&v).map_err(|_| "the request body is not JSON")?;
        return Ok((RequestInfo { model, max_output, stream }, sent));
    }
    Ok((RequestInfo { model, max_output, stream }, body.to_vec()))
}

/// Reads usage out of a response as its bytes arrive.
pub struct UsageMeter {
    api: Api,
    stream: bool,
    buf: Vec<u8>,
    usage: Option<Usage>,
    /// Anthropic streams give input usage at the start and final output usage
    /// in `message_delta`; usage is final only once that arrives.
    anthropic_final: bool,
}

impl UsageMeter {
    pub fn new(api: Api, stream: bool) -> Self {
        Self { api, stream, buf: Vec::new(), usage: None, anthropic_final: false }
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
        if !self.stream {
            return;
        }
        while let Some(end) = find(&self.buf, b"\n\n") {
            let event: Vec<u8> = self.buf.drain(..end + 2).collect();
            for line in event.split(|&b| b == b'\n') {
                if let Some(data) = line.strip_prefix(b"data:") {
                    let data = data.strip_prefix(b" ").unwrap_or(data);
                    if let Ok(v) = serde_json::from_slice::<Value>(data) {
                        self.on_event(&v);
                    }
                }
            }
        }
    }

    /// The call's usage, or `None` if the response never reported it (an
    /// error body, or a stream cut before its usage arrived).
    pub fn finish(self) -> Option<Usage> {
        if self.stream {
            return match self.api {
                Api::AnthropicMessages if !self.anthropic_final => None,
                _ => self.usage,
            };
        }
        let v: Value = serde_json::from_slice(&self.buf).ok()?;
        match self.api {
            Api::AnthropicMessages => anthropic(v.get("usage")?),
            Api::OpenAiChat => openai(v.get("usage")?, "prompt_tokens", "completion_tokens", "prompt_tokens_details"),
            Api::OpenAiResponses => openai(v.get("usage")?, "input_tokens", "output_tokens", "input_tokens_details"),
        }
    }

    fn on_event(&mut self, v: &Value) {
        match (self.api, v.get("type").and_then(Value::as_str)) {
            (Api::AnthropicMessages, Some("message_start")) => {
                self.usage = v.pointer("/message/usage").and_then(anthropic);
            }
            (Api::AnthropicMessages, Some("message_delta")) => {
                let (Some(u), Some(delta)) = (self.usage.as_mut(), v.get("usage")) else { return };
                let n = |k: &str| delta.get(k).and_then(Value::as_u64);
                u.output = n("output_tokens").unwrap_or(u.output);
                u.input = n("input_tokens").unwrap_or(u.input);
                u.cache_write = n("cache_creation_input_tokens").unwrap_or(u.cache_write);
                u.cache_read = n("cache_read_input_tokens").unwrap_or(u.cache_read);
                self.anthropic_final = true;
            }
            (Api::OpenAiChat, _) => {
                if let Some(u) = v.get("usage").filter(|u| u.is_object()) {
                    self.usage = openai(u, "prompt_tokens", "completion_tokens", "prompt_tokens_details");
                }
            }
            (Api::OpenAiResponses, Some("response.completed")) => {
                self.usage = v
                    .pointer("/response/usage")
                    .and_then(|u| openai(u, "input_tokens", "output_tokens", "input_tokens_details"));
            }
            _ => {}
        }
    }
}

fn anthropic(u: &Value) -> Option<Usage> {
    let n = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
    u.get("input_tokens")?;
    Some(Usage {
        input: n("input_tokens"),
        output: n("output_tokens"),
        cache_write: n("cache_creation_input_tokens"),
        cache_read: n("cache_read_input_tokens"),
    })
}

/// OpenAI reports cached tokens inside the input total.
fn openai(u: &Value, input: &str, output: &str, details: &str) -> Option<Usage> {
    let total_in = u.get(input)?.as_u64()?;
    let cached = u.get(details).and_then(|d| d.get("cached_tokens")).and_then(Value::as_u64).unwrap_or(0);
    Some(Usage {
        input: total_in.saturating_sub(cached),
        output: u.get(output).and_then(Value::as_u64).unwrap_or(0),
        cache_write: 0,
        cache_read: cached,
    })
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}
