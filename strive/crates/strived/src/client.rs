//! A minimal sequential JSON-RPC client, used by the CLI and the tests.

use std::path::Path;

use anyhow::{Context, Result, anyhow, bail};
use strive_proto::rpc::{Message, RequestId, RpcError};
use strive_proto::{ClientInfo, Initialize, InitializeParams, InitializeResult, Method, PROTOCOL_VERSION};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};

pub struct Client {
    /// Lines, rather than a reader: `next_line` is cancel-safe, so
    /// `notification` can be raced against Ctrl+C without losing a line.
    lines: tokio::io::Lines<BufReader<OwnedReadHalf>>,
    writer: OwnedWriteHalf,
    next_id: i64,
    /// Notifications that arrived while waiting for a reply, in order.
    notes: std::collections::VecDeque<Message>,
}

/// A JSON-RPC error returned by the daemon.
#[derive(Debug)]
pub struct ServerError(pub RpcError);

impl std::fmt::Display for ServerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0.message)
    }
}
impl std::error::Error for ServerError {}

impl Client {
    pub async fn connect(socket: &Path) -> Result<Self> {
        let stream = UnixStream::connect(socket).await?;
        let (r, w) = stream.into_split();
        Ok(Self { lines: BufReader::new(r).lines(), writer: w, next_id: 1, notes: std::collections::VecDeque::new() })
    }

    pub async fn initialize(&mut self, name: &str) -> Result<InitializeResult> {
        self.request::<Initialize>(InitializeParams {
            protocol_version: PROTOCOL_VERSION,
            client: ClientInfo { name: name.into(), version: env!("CARGO_PKG_VERSION").into() },
        })
        .await
    }

    pub async fn request<M: Method>(&mut self, params: M::Params) -> Result<M::Result> {
        let id = self.next_id;
        self.next_id += 1;
        let msg = Message::request(RequestId::Number(id), M::NAME, serde_json::to_value(params)?);
        let mut line = serde_json::to_vec(&msg)?;
        line.push(b'\n');
        self.writer.write_all(&line).await?;
        loop {
            let Some(buf) = self.lines.next_line().await? else {
                bail!("daemon closed the connection during {}", M::NAME);
            };
            let reply: Message = serde_json::from_str(&buf).context("daemon sent invalid JSON-RPC")?;
            if reply.method.is_some() {
                self.notes.push_back(reply); // kept for `notification`
                continue;
            }
            if reply.id != Some(RequestId::Number(id)) {
                continue;
            }
            if let Some(e) = reply.error {
                return Err(ServerError(e).into());
            }
            let result = reply.result.ok_or_else(|| anyhow!("response without result"))?;
            return Ok(serde_json::from_value(result)?);
        }
    }

    /// The next notification: one kept while waiting for a reply, or the
    /// next to arrive.
    pub async fn notification(&mut self) -> Result<Message> {
        if let Some(n) = self.notes.pop_front() {
            return Ok(n);
        }
        loop {
            let Some(buf) = self.lines.next_line().await? else {
                bail!("the daemon closed the connection");
            };
            let msg: Message = serde_json::from_str(&buf).context("daemon sent invalid JSON-RPC")?;
            if msg.method.is_some() {
                return Ok(msg);
            }
        }
    }
}
