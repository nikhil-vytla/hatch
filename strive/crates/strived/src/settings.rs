//! `~/.strive/settings.json`. Every field has a default, so the file is
//! optional. Unknown fields are errors: a typo in a budget or a price must
//! not be silently ignored.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, Result};
use serde::Deserialize;
use strive_budget::{Limits, PriceSetting};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    #[serde(default)]
    pub budget: BudgetSetting,
    /// Prices for models the built-in table doesn't know, or overrides.
    #[serde(default)]
    pub models: BTreeMap<String, PriceSetting>,
    #[serde(default)]
    pub providers: BTreeMap<String, ProviderSetting>,
    /// What new sessions may do without asking.
    #[serde(default = "default_approvals")]
    pub approvals: strive_proto::ApprovalMode,
    #[serde(default)]
    pub gateway: GatewaySetting,
    /// The model the agent uses.
    #[serde(default = "default_model")]
    pub model: String,
    /// The model the judge gate uses; the agent's `model` when unset. It
    /// must be an Anthropic model.
    #[serde(default)]
    pub judge_model: Option<String>,
    /// The longest a turn may run before it is stopped.
    #[serde(default = "default_turn_seconds")]
    pub turn_seconds: u64,
    /// The agent's per-reply output cap. Each model call holds budget for a
    /// reply this long, so a smaller cap leaves more of the budget usable.
    #[serde(default = "default_agent_max_output")]
    pub agent_max_output: u64,
    /// Summarize the conversation before a turn at this many estimated
    /// tokens. 0 means 80% of the model's context window.
    #[serde(default)]
    pub compact_at_tokens: u64,
    /// `off` runs commands unconfined, gated by the approval mode as
    /// sandboxed ones are: only for a disposable container (a benchmark
    /// task) that is itself the sandbox. `auto`, the default, uses the OS
    /// sandbox where there is one.
    #[serde(default)]
    pub sandbox: SandboxSetting,
    /// MCP servers whose tools the agent may call, by name: the same shape
    /// as Claude Code's `mcpServers`.
    #[serde(default)]
    pub mcp_servers: BTreeMap<String, McpServerSetting>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SandboxSetting {
    #[default]
    Auto,
    Off,
}

/// A stdio MCP server: the daemon starts it in the session's directory.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpServerSetting {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Only `stdio` is supported; accepted so Claude Code configs load.
    #[serde(default, rename = "type")]
    pub transport: Option<String>,
}

fn default_agent_max_output() -> u64 {
    16_384
}

fn default_model() -> String {
    "claude-sonnet-4-5".into()
}

fn default_turn_seconds() -> u64 {
    1800
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewaySetting {
    /// A provider silent this long mid-response is cut off.
    #[serde(default = "default_stream_idle")]
    pub stream_idle_secs: u64,
}

fn default_stream_idle() -> u64 {
    600
}

impl Default for GatewaySetting {
    fn default() -> Self {
        Self { stream_idle_secs: default_stream_idle() }
    }
}

fn default_approvals() -> strive_proto::ApprovalMode {
    strive_proto::ApprovalMode::AutoEdit
}

/// The limits new sessions start with. `null` means unlimited.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BudgetSetting {
    /// Dollars per session.
    #[serde(default = "default_usd")]
    pub usd: Option<f64>,
    #[serde(default)]
    pub tokens: Option<u64>,
}

#[expect(clippy::unnecessary_wraps, reason = "serde's default must return the field's type")]
fn default_usd() -> Option<f64> {
    Some(5.0)
}

impl Default for BudgetSetting {
    fn default() -> Self {
        Self { usd: default_usd(), tokens: None }
    }
}

impl BudgetSetting {
    pub fn limits(&self) -> Limits {
        #[expect(clippy::cast_possible_truncation, clippy::cast_sign_loss, reason = "validated non-negative on load")]
        let usd_micros = self.usd.map(|d| (d * 1_000_000.0).round() as u64);
        Limits { usd_micros, tokens: self.tokens }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderSetting {
    pub base_url: String,
}

impl Settings {
    pub fn load(home: &Path) -> Result<Self> {
        let path = home.join("settings.json");
        let s: Settings = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).with_context(|| format!("reading {}", path.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                serde_json::from_str("{}").context("the default settings")?
            }
            Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
        };
        if s.budget.usd.is_some_and(|d| !d.is_finite() || d < 0.0) {
            anyhow::bail!("{}: budget.usd must be a non-negative number of dollars", path.display());
        }
        for (name, server) in &s.mcp_servers {
            if server.transport.as_deref().is_some_and(|t| t != "stdio") {
                anyhow::bail!("{}: mcpServers.{name}: only stdio servers are supported", path.display());
            }
            if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
                anyhow::bail!("{}: mcpServers.{name:?}: use letters, digits, - and _ in server names", path.display());
            }
        }
        Ok(s)
    }

    /// The upstream base URL for a provider: `STRIVE_UPSTREAM_<PROVIDER>`,
    /// then settings, then the provider's public API.
    pub fn upstream(&self, provider: &str) -> String {
        std::env::var(format!("STRIVE_UPSTREAM_{}", provider.to_uppercase()))
            .ok()
            .or_else(|| self.providers.get(provider).map(|p| p.base_url.clone()))
            .unwrap_or_else(|| match provider {
                "anthropic" => "https://api.anthropic.com".into(),
                _ => "https://api.openai.com".into(),
            })
            .trim_end_matches('/')
            .to_string()
    }
}
