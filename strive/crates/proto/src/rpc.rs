//! JSON-RPC 2.0 envelopes. One message per line (NDJSON).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

/// A request id. Clients use increasing integers; strings are accepted.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(untagged)]
#[ts(export)]
pub enum RequestId {
    Number(i64),
    String(String),
}

/// Any message a peer can receive. Requests carry `id` and `method`,
/// notifications only `method`, responses only `id`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub jsonrpc: Version,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<RequestId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

/// The literal `"2.0"`; anything else fails to parse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Version;

impl Serialize for Version {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str("2.0")
    }
}

impl<'de> Deserialize<'de> for Version {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = String::deserialize(d)?;
        if v == "2.0" { Ok(Version) } else { Err(serde::de::Error::custom("jsonrpc must be \"2.0\"")) }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "unknown")]
    pub data: Option<Value>,
}

impl RpcError {
    pub const PARSE_ERROR: i32 = -32700;
    pub const INVALID_REQUEST: i32 = -32600;
    pub const METHOD_NOT_FOUND: i32 = -32601;
    pub const INVALID_PARAMS: i32 = -32602;
    pub const INTERNAL_ERROR: i32 = -32603;
    /// A method other than `initialize` arrived first.
    pub const NOT_INITIALIZED: i32 = -32002;
    /// Client and daemon speak different protocol versions.
    pub const PROTOCOL_MISMATCH: i32 = -32003;
    /// The session does not exist.
    pub const SESSION_NOT_FOUND: i32 = -32010;
    /// The session's journal failed verification; `data.problem` says why.
    pub const JOURNAL_INVALID: i32 = -32011;
    /// No approval is pending for that effect (unknown, or already decided).
    pub const APPROVAL_NOT_PENDING: i32 = -32012;
    /// Only a person decides on approvals; an agent host can't.
    pub const NOT_A_PERSON: i32 = -32013;
    /// Another host is already registered for the session.
    pub const HOST_EXISTS: i32 = -32014;
    /// Only the session's registered host speaks for its agent.
    pub const NOT_THE_HOST: i32 = -32015;

    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), data: None }
    }
}

impl Message {
    pub fn request(id: RequestId, method: &str, params: Value) -> Self {
        Self {
            jsonrpc: Version,
            id: Some(id),
            method: Some(method.into()),
            params: Some(params),
            result: None,
            error: None,
        }
    }
    pub fn notification(method: &str, params: Value) -> Self {
        Self {
            jsonrpc: Version,
            id: None,
            method: Some(method.into()),
            params: Some(params),
            result: None,
            error: None,
        }
    }
    pub fn ok(id: RequestId, result: Value) -> Self {
        Self { jsonrpc: Version, id: Some(id), method: None, params: None, result: Some(result), error: None }
    }
    /// An error response. `id` is `None` only when the request id was unreadable.
    pub fn err(id: Option<RequestId>, error: RpcError) -> Self {
        Self { jsonrpc: Version, id, method: None, params: None, result: None, error: Some(error) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_wrong_version() {
        assert!(serde_json::from_str::<Message>(r#"{"jsonrpc":"1.0","id":1,"method":"x"}"#).is_err());
    }

    #[test]
    fn round_trips_request() {
        let m = Message::request(RequestId::Number(7), "daemon/status", serde_json::json!({}));
        let s = serde_json::to_string(&m).unwrap();
        assert_eq!(s, r#"{"jsonrpc":"2.0","id":7,"method":"daemon/status","params":{}}"#);
        assert_eq!(serde_json::from_str::<Message>(&s).unwrap(), m);
    }

    /// The predefined codes are the JSON-RPC 2.0 spec's (section 5.1:
    /// -32700 parse error, -32600 invalid request, -32601 method not found,
    /// -32602 invalid params, -32603 internal error), so a client written to
    /// the spec reads strive's errors as the spec defines them.
    #[test]
    fn predefined_error_codes_are_the_specs() {
        for (wire, code) in [
            (-32700, RpcError::PARSE_ERROR),
            (-32600, RpcError::INVALID_REQUEST),
            (-32601, RpcError::METHOD_NOT_FOUND),
            (-32602, RpcError::INVALID_PARAMS),
            (-32603, RpcError::INTERNAL_ERROR),
        ] {
            let line = format!(r#"{{"jsonrpc":"2.0","id":"1","error":{{"code":{wire},"message":"m"}}}}"#);
            let m: Message = serde_json::from_str(&line).unwrap();
            assert_eq!(m.error.as_ref().map(|e| e.code), Some(code), "{line}");
            assert_eq!(serde_json::to_string(&m).unwrap(), line);
        }
    }

    /// The spec reserves -32000 to -32099 for implementation-defined server
    /// errors (section 5.1). strive's own codes must sit there, clear of the
    /// predefined ones, and differ from each other: clients tell them apart
    /// by code alone.
    #[test]
    fn strives_own_error_codes_are_distinct_server_errors() {
        let own = [
            RpcError::NOT_INITIALIZED,
            RpcError::PROTOCOL_MISMATCH,
            RpcError::SESSION_NOT_FOUND,
            RpcError::JOURNAL_INVALID,
            RpcError::APPROVAL_NOT_PENDING,
            RpcError::NOT_A_PERSON,
            RpcError::HOST_EXISTS,
            RpcError::NOT_THE_HOST,
        ];
        for code in own {
            assert!((-32099..=-32000).contains(&code), "{code} is outside the server-error range");
        }
        let mut distinct = own.to_vec();
        distinct.sort_unstable();
        distinct.dedup();
        assert_eq!(distinct.len(), own.len(), "two errors share a code");
    }
}
