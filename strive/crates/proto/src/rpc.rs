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
}
