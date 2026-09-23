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

#[allow(clippy::unnecessary_wraps, reason = "serde's default must return the field's type")]
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
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, reason = "validated non-negative on load")]
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
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::from_str("{}").expect("defaults parse"),
            Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
        };
        if s.budget.usd.is_some_and(|d| !d.is_finite() || d < 0.0) {
            anyhow::bail!("{}: budget.usd must be a non-negative number of dollars", path.display());
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
