use serde_json::{Value, json};
use strive_gateway::{Api, RequestInfo, UsageMeter, prepare_request};
use strive_proto::Usage;

fn usage(input: u64, output: u64, cache_write: u64, cache_read: u64) -> Usage {
    Usage { input, output, cache_write, cache_read }
}

#[test]
fn apis_are_recognized_by_provider_and_path() {
    assert_eq!(Api::for_path("anthropic", "/v1/messages"), Some(Api::AnthropicMessages));
    assert_eq!(Api::for_path("openai", "/v1/chat/completions"), Some(Api::OpenAiChat));
    assert_eq!(Api::for_path("openai", "/v1/responses"), Some(Api::OpenAiResponses));
    assert_eq!(Api::for_path("anthropic", "/v1/chat/completions"), None);
    assert_eq!(Api::for_path("openai", "/v1/files"), None);
    assert_eq!(Api::for_path("other", "/v1/messages"), None);
}

#[test]
fn anthropic_requests_name_their_model_cap_and_streaming() {
    let body = json!({"model": "claude-haiku-4-5", "max_tokens": 1024, "stream": true, "messages": []});
    let (info, sent) = prepare_request(Api::AnthropicMessages, &serde_json::to_vec(&body).unwrap()).unwrap();
    assert_eq!(info, RequestInfo { model: "claude-haiku-4-5".into(), max_output: Some(1024), stream: true });
    assert_eq!(serde_json::from_slice::<Value>(&sent).unwrap(), body, "Anthropic bodies are sent unchanged");
}

#[test]
fn openai_caps_come_from_whichever_field_the_request_uses() {
    let chat = |b: Value| prepare_request(Api::OpenAiChat, &serde_json::to_vec(&b).unwrap()).unwrap().0.max_output;
    assert_eq!(chat(json!({"model": "gpt-4.1", "max_completion_tokens": 300})), Some(300));
    assert_eq!(chat(json!({"model": "gpt-4.1", "max_tokens": 200})), Some(200));
    assert_eq!(chat(json!({"model": "gpt-4.1"})), None);
    let responses =
        prepare_request(Api::OpenAiResponses, br#"{"model":"gpt-5","max_output_tokens":77,"input":"hi"}"#).unwrap().0;
    assert_eq!(responses, RequestInfo { model: "gpt-5".into(), max_output: Some(77), stream: false });
}

/// Chat Completions streams report usage only when asked, and the gateway
/// can't bill a call it can't measure, so it asks.
#[test]
fn streaming_chat_requests_are_made_to_report_usage() {
    let body = json!({"model": "gpt-4.1", "stream": true, "messages": [{"role": "user", "content": "hi"}]});
    let (_, sent) = prepare_request(Api::OpenAiChat, &serde_json::to_vec(&body).unwrap()).unwrap();
    let sent: Value = serde_json::from_slice(&sent).unwrap();
    assert_eq!(sent["stream_options"], json!({"include_usage": true}));
    assert_eq!(sent["messages"], body["messages"]);

    let explicit = json!({"model": "gpt-4.1", "stream": true, "stream_options": {"include_usage": false}});
    let (_, sent) = prepare_request(Api::OpenAiChat, &serde_json::to_vec(&explicit).unwrap()).unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&sent).unwrap()["stream_options"]["include_usage"], true);
}

#[test]
fn malformed_requests_are_refused_with_a_reason() {
    assert_eq!(prepare_request(Api::AnthropicMessages, b"not json").unwrap_err(), "the request body is not JSON");
    assert_eq!(
        prepare_request(Api::AnthropicMessages, br#"{"max_tokens":5}"#).unwrap_err(),
        "the request names no model"
    );
    assert_eq!(prepare_request(Api::AnthropicMessages, b"[1]").unwrap_err(), "the request body is not a JSON object");
}

const ANTHROPIC_JSON: &str = r#"{"id":"msg_01","type":"message","role":"assistant","model":"claude-haiku-4-5-20251001",
"content":[{"type":"text","text":"Hi"}],"stop_reason":"end_turn",
"usage":{"input_tokens":12,"cache_creation_input_tokens":100,"cache_read_input_tokens":2000,"output_tokens":7}}"#;

const ANTHROPIC_SSE: &str = "event: message_start\n\
data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_01\",\"model\":\"claude-haiku-4-5\",\"usage\":{\"input_tokens\":25,\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":1000,\"output_tokens\":1}}}\n\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n\
event: message_delta\n\
data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":15}}\n\n\
event: message_stop\n\
data: {\"type\":\"message_stop\"}\n\n";

const CHAT_JSON: &str = r#"{"id":"chatcmpl-1","object":"chat.completion","model":"gpt-4.1",
"choices":[{"index":0,"message":{"role":"assistant","content":"Hi"},"finish_reason":"stop"}],
"usage":{"prompt_tokens":1200,"completion_tokens":30,"total_tokens":1230,"prompt_tokens_details":{"cached_tokens":1024}}}"#;

const CHAT_SSE: &str = "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hi\"}}],\"usage\":null}\n\n\
data: {\"id\":\"c1\",\"choices\":[],\"usage\":{\"prompt_tokens\":50,\"completion_tokens\":9,\"total_tokens\":59,\"prompt_tokens_details\":{\"cached_tokens\":0}}}\n\n\
data: [DONE]\n\n";

const RESPONSES_JSON: &str = r#"{"id":"resp_1","object":"response","status":"completed","model":"gpt-5",
"usage":{"input_tokens":300,"input_tokens_details":{"cached_tokens":100},"output_tokens":40,"output_tokens_details":{"reasoning_tokens":20},"total_tokens":340}}"#;

const RESPONSES_SSE: &str = "event: response.created\n\
data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"usage\":null}}\n\n\
event: response.output_text.delta\n\
data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hi\"}\n\n\
event: response.completed\n\
data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"usage\":{\"input_tokens\":80,\"input_tokens_details\":{\"cached_tokens\":64},\"output_tokens\":5,\"total_tokens\":85}}}\n\n";

fn metered(api: Api, stream: bool, body: &str) -> Option<Usage> {
    let mut m = UsageMeter::new(api, stream);
    m.feed(body.as_bytes());
    m.finish()
}

fn metered_bytewise(api: Api, body: &str) -> Option<Usage> {
    let mut m = UsageMeter::new(api, true);
    for b in body.as_bytes() {
        m.feed(std::slice::from_ref(b));
    }
    m.finish()
}

#[test]
fn anthropic_usage_counts_cache_writes_and_reads_separately() {
    assert_eq!(metered(Api::AnthropicMessages, false, ANTHROPIC_JSON), Some(usage(12, 7, 100, 2000)));
}

#[test]
fn anthropic_streams_take_input_from_the_start_and_output_from_the_last_delta() {
    assert_eq!(metered(Api::AnthropicMessages, true, ANTHROPIC_SSE), Some(usage(25, 15, 0, 1000)));
    assert_eq!(metered_bytewise(Api::AnthropicMessages, ANTHROPIC_SSE), Some(usage(25, 15, 0, 1000)));
}

/// OpenAI counts cached tokens inside the input total; strive's usage keeps
/// them apart so each is priced at its own rate.
#[test]
fn openai_cached_tokens_are_split_out_of_the_input() {
    assert_eq!(metered(Api::OpenAiChat, false, CHAT_JSON), Some(usage(176, 30, 0, 1024)));
    assert_eq!(metered(Api::OpenAiResponses, false, RESPONSES_JSON), Some(usage(200, 40, 0, 100)));
}

#[test]
fn openai_streams_report_usage_at_the_end() {
    assert_eq!(metered(Api::OpenAiChat, true, CHAT_SSE), Some(usage(50, 9, 0, 0)));
    assert_eq!(metered_bytewise(Api::OpenAiChat, CHAT_SSE), Some(usage(50, 9, 0, 0)));
    assert_eq!(metered(Api::OpenAiResponses, true, RESPONSES_SSE), Some(usage(16, 5, 0, 64)));
    assert_eq!(metered_bytewise(Api::OpenAiResponses, RESPONSES_SSE), Some(usage(16, 5, 0, 64)));
}

/// A stream cut before its usage arrived has no usage, which the gateway
/// charges as a broken call.
#[test]
fn a_stream_cut_before_its_usage_has_none() {
    let cut = &ANTHROPIC_SSE[..ANTHROPIC_SSE.find("event: message_delta").unwrap()];
    assert_eq!(metered(Api::AnthropicMessages, true, cut), None);
    let cut = &CHAT_SSE[..CHAT_SSE.find("data: {\"id\":\"c1\",\"choices\":[]").unwrap()];
    assert_eq!(metered(Api::OpenAiChat, true, cut), None);
    assert_eq!(metered(Api::OpenAiResponses, false, r#"{"error":{"message":"bad"}}"#), None);
}
