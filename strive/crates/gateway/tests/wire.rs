#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason = "a test fails by panicking")]
use serde_json::{Value, json};
use strive_gateway::{Api, Holdback, MAX_METERED, RequestInfo, UsageMeter, check_betas, prepare_request};
use strive_proto::Usage;

fn usage(input: u64, output: u64, cache_write: u64, cache_read: u64) -> Usage {
    Usage { input, output, cache_write, cache_write_long: 0, cache_read }
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
    assert_eq!(
        info,
        RequestInfo {
            model: "claude-haiku-4-5".into(),
            max_output: Some(1024),
            stream: true,
            choices: 1,
            input_rate: strive_budget::InputRate::Plain,
        }
    );
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
    assert_eq!(
        responses,
        RequestInfo {
            model: "gpt-5".into(),
            max_output: Some(77),
            stream: false,
            choices: 1,
            input_rate: strive_budget::InputRate::Plain,
        }
    );
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

fn prepared(api: Api, body: &Value) -> Result<RequestInfo, &'static str> {
    prepare_request(api, &serde_json::to_vec(body).unwrap()).map(|(info, _)| info)
}

#[test]
fn several_chat_choices_multiply_the_output_bound() {
    let info =
        prepared(Api::OpenAiChat, &json!({"model": "gpt-4.1-mini", "n": 2, "max_completion_tokens": 1000})).unwrap();
    assert_eq!((info.max_output, info.choices), (Some(1000), 2));
    assert_eq!(prepared(Api::OpenAiChat, &json!({"model": "gpt-4.1-mini"})).unwrap().choices, 1);
}

#[test]
fn server_side_conversation_state_is_refused() {
    let why = "the request relies on conversation state kept by the provider, whose cost can't be bounded from the request; send the full history instead";
    assert_eq!(prepared(Api::OpenAiResponses, &json!({"model": "gpt-5", "previous_response_id": "resp_1"})), Err(why));
    assert_eq!(prepared(Api::OpenAiResponses, &json!({"model": "gpt-5", "conversation": "conv_1"})), Err(why));
}

#[test]
fn paid_server_side_tools_are_refused_and_client_tools_are_not() {
    let why = "the request enables tools the provider runs and bills separately, which strive can't bound; use tools the agent runs itself";
    let refused = [
        (Api::OpenAiResponses, json!({"model": "gpt-5", "tools": [{"type": "web_search"}]})),
        (
            Api::OpenAiResponses,
            json!({"model": "gpt-5", "tools": [{"type": "function", "name": "f"}, {"type": "file_search"}]}),
        ),
        (Api::OpenAiChat, json!({"model": "gpt-4.1", "web_search_options": {}})),
        (
            Api::AnthropicMessages,
            json!({"model": "claude-haiku-4-5", "max_tokens": 5, "tools": [{"type": "web_search_20250305", "name": "web_search"}]}),
        ),
        (
            Api::AnthropicMessages,
            json!({"model": "claude-haiku-4-5", "max_tokens": 5, "tools": [{"type": "code_execution_20250522", "name": "code_execution"}]}),
        ),
        (
            Api::AnthropicMessages,
            json!({"model": "claude-haiku-4-5", "max_tokens": 5, "mcp_servers": [{"url": "https://x"}]}),
        ),
    ];
    for (api, body) in refused {
        assert_eq!(prepared(api, &body), Err(why), "{body}");
    }
    let allowed = [
        (Api::OpenAiResponses, json!({"model": "gpt-5", "tools": [{"type": "function", "name": "read"}]})),
        (Api::OpenAiChat, json!({"model": "gpt-4.1", "tools": [{"type": "function", "function": {"name": "read"}}]})),
        (
            Api::AnthropicMessages,
            json!({"model": "claude-haiku-4-5", "max_tokens": 5, "tools": [{"name": "read", "input_schema": {}}]}),
        ),
        (
            Api::AnthropicMessages,
            json!({"model": "claude-haiku-4-5", "max_tokens": 5, "tools": [{"type": "bash_20250124", "name": "bash"}]}),
        ),
    ];
    for (api, body) in allowed {
        assert!(prepared(api, &body).is_ok(), "{body}");
    }
}

#[test]
fn requests_that_write_the_cache_are_bounded_at_the_cache_write_rate() {
    use strive_budget::InputRate;
    let plain = json!({"model": "claude-haiku-4-5", "max_tokens": 5, "messages": [{"role": "user", "content": "hi"}]});
    assert_eq!(prepared(Api::AnthropicMessages, &plain).unwrap().input_rate, InputRate::Plain);
    let cached = json!({"model": "claude-haiku-4-5", "max_tokens": 5, "system": [{"type": "text", "text": "s", "cache_control": {"type": "ephemeral"}}]});
    assert_eq!(prepared(Api::AnthropicMessages, &cached).unwrap().input_rate, InputRate::CacheWrite);
    let long = json!({"model": "claude-haiku-4-5", "max_tokens": 5, "messages": [{"role": "user", "content": [{"type": "text", "text": "x", "cache_control": {"type": "ephemeral", "ttl": "1h"}}]}]});
    assert_eq!(prepared(Api::AnthropicMessages, &long).unwrap().input_rate, InputRate::CacheWriteLong);
}

#[test]
fn one_hour_cache_writes_are_counted_apart() {
    let body = r#"{"usage":{"input_tokens":5,"output_tokens":2,"cache_creation_input_tokens":150,"cache_read_input_tokens":0,
"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":50}}}"#;
    assert_eq!(
        metered(Api::AnthropicMessages, false, body),
        Some(Usage { input: 5, output: 2, cache_write: 100, cache_write_long: 50, cache_read: 0 })
    );
}

#[test]
fn a_responses_stream_that_ends_incomplete_still_reports_usage() {
    let sse = "event: response.incomplete\n\
data: {\"type\":\"response.incomplete\",\"response\":{\"status\":\"incomplete\",\"usage\":{\"input_tokens\":40,\"output_tokens\":16,\"input_tokens_details\":{\"cached_tokens\":0}}}}\n\n";
    assert_eq!(metered(Api::OpenAiResponses, true, sse), Some(usage(40, 16, 0, 0)));
}

#[test]
fn streams_framed_with_crlf_or_multi_line_data_are_metered() {
    let crlf = ANTHROPIC_SSE.replace('\n', "\r\n");
    assert_eq!(metered(Api::AnthropicMessages, true, &crlf), Some(usage(25, 15, 0, 1000)));
    assert_eq!(metered_bytewise(Api::AnthropicMessages, &crlf), Some(usage(25, 15, 0, 1000)));
    let multi = "event: response.completed\n\
data: {\"type\":\"response.completed\",\n\
data: \"response\":{\"usage\":{\"input_tokens\":3,\"output_tokens\":4}}}\n\n";
    assert_eq!(metered(Api::OpenAiResponses, true, multi), Some(usage(3, 4, 0, 0)));
}

/// Usage the gateway can't read as numbers is unknown, not zero: the call
/// is then charged its hold.
#[test]
fn malformed_usage_is_unknown_not_free() {
    assert_eq!(metered(Api::AnthropicMessages, false, r#"{"usage":{"input_tokens":null,"output_tokens":3}}"#), None);
    assert_eq!(metered(Api::AnthropicMessages, false, r#"{"usage":{"input_tokens":3}}"#), None);
    assert_eq!(metered(Api::OpenAiChat, false, r#"{"usage":{"prompt_tokens":10}}"#), None);
    assert_eq!(metered(Api::OpenAiResponses, false, r#"{"usage":{"input_tokens":"10","output_tokens":1}}"#), None);
}

/// A stream the gateway can't frame (an event larger than any real one)
/// has unknown usage rather than growing without bound.
#[test]
fn an_oversized_stream_event_has_unknown_usage() {
    let mut m = UsageMeter::new(Api::AnthropicMessages, true);
    m.feed(&ANTHROPIC_SSE.as_bytes()[..ANTHROPIC_SSE.find("event: message_delta").unwrap()]);
    m.feed(&vec![b'x'; 17 * 1024 * 1024]);
    m.feed(b"\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":15}}\n\n");
    assert_eq!(m.finish(), None);
}

/// Real responses can be megabytes (long outputs, big tool arguments); the
/// meter must read them, and give up only past its limit.
#[test]
fn large_responses_are_metered_and_only_absurd_ones_are_not() {
    let text = "y".repeat(2 * 1024 * 1024);
    let body =
        format!(r#"{{"content":[{{"type":"text","text":"{text}"}}],"usage":{{"input_tokens":9,"output_tokens":8}}}}"#);
    assert_eq!(metered(Api::AnthropicMessages, false, &body), Some(usage(9, 8, 0, 0)));

    let sse = ANTHROPIC_SSE.replace("\"text\":\"Hello\"", &format!("\"text\":\"{text}\""));
    assert_eq!(metered(Api::AnthropicMessages, true, &sse), Some(usage(25, 15, 0, 1000)));

    let huge = "z".repeat(17 * 1024 * 1024);
    let body =
        format!(r#"{{"content":[{{"type":"text","text":"{huge}"}}],"usage":{{"input_tokens":9,"output_tokens":8}}}}"#);
    let mut m = UsageMeter::new(Api::AnthropicMessages, false);
    m.feed(body.as_bytes());
    assert_eq!(m.finish(), None, "a body past the meter's limit has unknown usage");
}

/// `cache_control` is Anthropic's; in an OpenAI request it's only a name (a
/// tool's parameter, say), and OpenAI has no cache-write rate to reserve at.
#[test]
fn only_anthropic_requests_are_bounded_at_a_cache_write_rate() {
    use strive_budget::InputRate;
    let body = json!({"model": "gpt-4.1", "max_tokens": 1, "messages": [{"role": "user", "content": "hi"}],
        "tools": [{"type": "function", "function": {"name": "f", "parameters": {"type": "object",
            "properties": {"cache_control": {"type": "string"}}}}}]});
    assert_eq!(prepared(Api::OpenAiChat, &body).unwrap().input_rate, InputRate::Plain);
}

/// An image or file the provider fetches (or keeps) costs tokens the body
/// doesn't show; one sent inline is bounded by its bytes.
#[test]
fn inputs_the_provider_fetches_are_refused_and_inline_ones_are_not() {
    let why = "the request includes an image or file the provider fetches or keeps, whose cost can't be bounded from the request; send it inline instead";
    let refused = [
        (
            Api::AnthropicMessages,
            json!({"model": "claude-haiku-4-5", "max_tokens": 1, "messages": [{"role": "user", "content": [
            {"type": "image", "source": {"type": "url", "url": "https://example.com/a.png"}}]}]}),
        ),
        (
            Api::AnthropicMessages,
            json!({"model": "claude-haiku-4-5", "max_tokens": 1, "messages": [{"role": "user", "content": [
            {"type": "document", "source": {"type": "file", "file_id": "file_1"}}]}]}),
        ),
        (
            Api::OpenAiChat,
            json!({"model": "gpt-4.1", "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "https://example.com/a.png"}}]}]}),
        ),
        (
            Api::OpenAiResponses,
            json!({"model": "gpt-5", "input": [{"role": "user", "content": [
            {"type": "input_file", "file_id": "file_1"}]}]}),
        ),
        (
            Api::OpenAiChat,
            json!({"model": "gpt-4.1", "messages": [{"role": "user", "content": [
            {"type": "file", "file": {"file_id": "file_1"}}]}]}),
        ),
        (
            Api::OpenAiResponses,
            json!({"model": "gpt-5", "input": [{"role": "user", "content": [
            {"type": "input_image", "image_url": "https://example.com/a.png"}]}]}),
        ),
        (
            Api::OpenAiResponses,
            json!({"model": "gpt-5", "input": [{"role": "user", "content": [
            {"type": "input_file", "file_url": "https://example.com/a.pdf"}]}]}),
        ),
        (Api::OpenAiResponses, json!({"model": "gpt-5", "input": [{"type": "item_reference", "id": "msg_1"}]})),
    ];
    for (api, body) in refused {
        assert_eq!(prepared(api, &body), Err(why), "{body}");
    }
    let inline = [
        (
            Api::OpenAiChat,
            json!({"model": "gpt-4.1", "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgo="}}]}]}),
        ),
        (
            Api::OpenAiChat,
            json!({"model": "gpt-4.1", "messages": [{"role": "user", "content": [
            {"type": "file", "file": {"filename": "a.pdf", "file_data": "data:application/pdf;base64,JVBERi0="}}]}]}),
        ),
        (
            Api::OpenAiResponses,
            json!({"model": "gpt-5", "input": [{"role": "user", "content": [
            {"type": "input_image", "image_url": "data:image/png;base64,iVBORw0KGgo="}]}]}),
        ),
    ];
    for (api, body) in inline {
        assert!(prepared(api, &body).is_ok(), "{body}");
    }
    // The same names in a tool's schema or a tool call's arguments are the tool's own.
    let tool_names = json!({"model": "claude-haiku-4-5", "max_tokens": 1,
        "tools": [{"name": "open", "input_schema": {"type": "object", "properties": {"file_id": {"type": "string"}}}}],
        "messages": [{"role": "assistant", "content": [{"type": "tool_use", "id": "t", "name": "open",
            "input": {"file_id": "f1", "source": {"type": "url"}, "type": "image"}}]}]});
    assert!(prepared(Api::AnthropicMessages, &tool_names).is_ok());
}

/// Priority processing costs more than the prices strive knows.
#[test]
fn a_premium_service_tier_is_refused() {
    let why =
        "the request asks for a service tier priced above the standard rates strive knows; leave service_tier unset";
    assert_eq!(prepared(Api::OpenAiResponses, &json!({"model": "gpt-5", "service_tier": "priority"})), Err(why));
    assert_eq!(
        prepared(
            Api::AnthropicMessages,
            &json!({"model": "claude-haiku-4-5", "max_tokens": 1, "service_tier": "priority"})
        ),
        Err(why)
    );
    for tier in ["auto", "default", "flex", "standard_only"] {
        assert!(prepared(Api::OpenAiChat, &json!({"model": "gpt-4.1", "service_tier": tier})).is_ok(), "{tier}");
    }
}

/// A stream's last delta may repeat the cache counts without saying which
/// were one-hour writes; they stay one-hour writes.
#[test]
fn a_final_delta_without_the_cache_breakdown_keeps_one_hour_writes() {
    let sse = "event: message_start\n\
data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":5,\"cache_creation_input_tokens\":10000,\"cache_read_input_tokens\":0,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":10000},\"output_tokens\":1}}}\n\n\
event: message_delta\n\
data: {\"type\":\"message_delta\",\"usage\":{\"input_tokens\":5,\"cache_creation_input_tokens\":10000,\"cache_read_input_tokens\":0,\"output_tokens\":40}}\n\n";
    assert_eq!(
        metered(Api::AnthropicMessages, true, sse),
        Some(Usage { input: 5, output: 40, cache_write: 0, cache_write_long: 10000, cache_read: 0 })
    );
}

/// Everything before a stream's last event passes at once (whole lines);
/// the last event and what follows wait, however the bytes are split.
#[test]
fn a_streams_last_event_is_held_back_however_it_is_split() {
    for (stream, last) in [
        (CHAT_SSE, "data: [DONE]"),
        (ANTHROPIC_SSE, "event: message_stop"),
        (RESPONSES_SSE, "event: response.completed"),
    ] {
        let at = stream.find(last).unwrap();
        for chunk in [1, 7, stream.len()] {
            let mut h = Holdback::default();
            let mut sent = Vec::new();
            for piece in stream.as_bytes().chunks(chunk) {
                sent.extend(h.feed(piece));
            }
            assert_eq!(String::from_utf8(sent).unwrap(), stream[..at], "{last}, chunks of {chunk}");
            assert_eq!(String::from_utf8(h.rest()).unwrap(), stream[at..], "{last}, chunks of {chunk}");
        }
    }
}

/// Long-context pricing (context-1m) is dearer than the rates strive knows.
#[test]
fn betas_that_change_the_price_are_refused_and_others_are_not() {
    assert!(check_betas("context-1m-2025-08-07").is_err());
    assert!(check_betas("fine-grained-tool-streaming-2025-05-14, context-1m-2025-08-07").is_err());
    assert_eq!(check_betas("fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14"), Ok(()));
}

/// A whole line goes to the client as soon as it arrives: a client waiting
/// for an event's closing blank line must not wait for the next chunk.
#[test]
fn whole_lines_pass_as_soon_as_they_arrive() {
    let mut h = Holdback::default();
    let first = &ANTHROPIC_SSE[..ANTHROPIC_SSE.find("event: content_block_delta").unwrap()];
    assert_eq!(String::from_utf8(h.feed(first.as_bytes())).unwrap(), first);
    let next = h.feed(b"event: content_block_delta\ndata: {");
    assert_eq!(String::from_utf8(next).unwrap(), "event: content_block_delta\n");
}

/// [`MAX_METERED`] is the largest body, or stream event, still read.
#[test]
fn the_meter_reads_up_to_its_limit_exactly() {
    let json = r#"{"content":[],"usage":{"input_tokens":9,"output_tokens":8}}"#;
    let body = format!("{json}{}", " ".repeat(MAX_METERED - json.len()));
    assert_eq!(metered(Api::AnthropicMessages, false, &body), Some(usage(9, 8, 0, 0)));
    assert_eq!(metered(Api::AnthropicMessages, false, &format!("{body} ")), None);

    let line = ANTHROPIC_SSE.lines().find(|l| l.contains("text_delta")).unwrap();
    let pad = "y".repeat(MAX_METERED - (line.len() - "Hello".len()));
    let sse = ANTHROPIC_SSE.replace("\"text\":\"Hello\"", &format!("\"text\":\"{pad}\""));
    assert_eq!(sse.lines().map(str::len).max(), Some(MAX_METERED));
    assert_eq!(metered(Api::AnthropicMessages, true, &sse), Some(usage(25, 15, 0, 1000)));
    let over = ANTHROPIC_SSE.replace("\"text\":\"Hello\"", &format!("\"text\":\"{pad}y\""));
    assert_eq!(metered(Api::AnthropicMessages, true, &over), None);
}

/// SSE joins an event's data lines with a line break. Glued together, a
/// number split across two lines would read as another number; joined, the
/// event isn't JSON and its usage is unknown.
#[test]
fn an_events_data_lines_are_joined_with_a_line_break() {
    let split = "event: response.completed\n\
data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":1\n\
data: 0,\"output_tokens\":4}}}\n\n";
    assert_eq!(metered(Api::OpenAiResponses, true, split), None);
}

/// Without the breakdown, the writes the stream's start said were
/// five-minute ones stay so; only the rest is priced as one-hour writes.
#[test]
fn a_final_delta_without_the_cache_breakdown_keeps_known_five_minute_writes() {
    let sse = "event: message_start\n\
data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":5,\"cache_creation_input_tokens\":300,\"cache_read_input_tokens\":0,\"cache_creation\":{\"ephemeral_5m_input_tokens\":300,\"ephemeral_1h_input_tokens\":0},\"output_tokens\":1}}}\n\n\
event: message_delta\n\
data: {\"type\":\"message_delta\",\"usage\":{\"input_tokens\":5,\"cache_creation_input_tokens\":1000,\"cache_read_input_tokens\":0,\"output_tokens\":40}}\n\n";
    assert_eq!(
        metered(Api::AnthropicMessages, true, sse),
        Some(Usage { input: 5, output: 40, cache_write: 300, cache_write_long: 700, cache_read: 0 })
    );
}
