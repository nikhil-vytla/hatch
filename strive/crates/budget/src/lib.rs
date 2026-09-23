//! Model prices, call costs and reservation budgets.
//!
//! Money is integer micro-dollars. Costs round up, so the ledger never
//! understates spend. A call is admitted only if its reservation, the most
//! it can cost, fits in what the session has left; when it finishes, the
//! reservation is replaced by the actual cost.

use std::collections::{BTreeMap, HashMap};

use serde::Deserialize;
use strive_proto::{CallOutcome, Event, Usage};

/// Micro-dollars per million tokens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Price {
    pub input: u64,
    pub output: u64,
    pub cache_write: u64,
    pub cache_read: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Model {
    pub price: Price,
    /// The most input tokens one request can carry.
    pub context_window: u64,
    /// The most output tokens one response can carry; bounds requests that
    /// set no cap of their own.
    pub max_output: u64,
}

/// The cost of `usage` at `price`, rounded up to a whole micro-dollar.
pub fn cost(price: &Price, usage: &Usage) -> u64 {
    let nano = u128::from(usage.input) * u128::from(price.input)
        + u128::from(usage.output) * u128::from(price.output)
        + u128::from(usage.cache_write) * u128::from(price.cache_write)
        + u128::from(usage.cache_read) * u128::from(price.cache_read);
    u64::try_from(nano.div_ceil(1_000_000)).unwrap_or(u64::MAX)
}

/// `$D.DDDD`, rounded up so a nonzero cost never shows as zero.
pub fn format_usd(micros: u64) -> String {
    let hundredths_of_cents = micros.div_ceil(100);
    format!("${}.{:04}", hundredths_of_cents / 10_000, hundredths_of_cents % 10_000)
}

/// Built-in prices, as published by each provider. Anything else must be
/// priced in settings; an unpriced model is refused rather than guessed.
const BUILTIN: &[(&str, f64, f64, f64, f64, u64, u64)] = &[
    // id prefix, $/MTok input, output, cache write, cache read, context window, max output
    ("claude-haiku-4-5", 1.0, 5.0, 1.25, 0.10, 200_000, 64_000),
    ("claude-sonnet-4-5", 3.0, 15.0, 3.75, 0.30, 200_000, 64_000),
    ("claude-opus-4-5", 5.0, 25.0, 6.25, 0.50, 200_000, 64_000),
    ("claude-opus-4-1", 15.0, 75.0, 18.75, 1.50, 200_000, 32_000),
    ("gpt-4.1-mini", 0.40, 1.60, 0.0, 0.10, 1_047_576, 32_768),
    ("gpt-4.1", 2.0, 8.0, 0.0, 0.50, 1_047_576, 32_768),
    ("gpt-5-mini", 0.25, 2.0, 0.0, 0.025, 400_000, 128_000),
    ("gpt-5", 1.25, 10.0, 0.0, 0.125, 400_000, 128_000),
];

fn micros_per_mtok(dollars: f64) -> u64 {
    // Prices are published to at most three decimals of a dollar.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, reason = "non-negative, small")]
    let m = (dollars * 1_000_000.0).round() as u64;
    m
}

/// A price as written in settings: dollars per million tokens.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceSetting {
    pub input: f64,
    pub output: f64,
    #[serde(default)]
    pub cache_write: f64,
    #[serde(default)]
    pub cache_read: f64,
    pub context_window: u64,
    /// Defaults to the context window.
    #[serde(default)]
    pub max_output: Option<u64>,
}

impl PriceSetting {
    fn model(&self) -> Model {
        Model {
            price: Price {
                input: micros_per_mtok(self.input),
                output: micros_per_mtok(self.output),
                cache_write: micros_per_mtok(self.cache_write),
                cache_read: micros_per_mtok(self.cache_read),
            },
            context_window: self.context_window,
            max_output: self.max_output.unwrap_or(self.context_window),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Models(BTreeMap<String, Model>);

impl Models {
    pub fn builtin() -> Self {
        Self(
            BUILTIN
                .iter()
                .map(|&(id, input, output, cache_write, cache_read, context_window, max_output)| {
                    let setting = PriceSetting {
                        input,
                        output,
                        cache_write,
                        cache_read,
                        context_window,
                        max_output: Some(max_output),
                    };
                    (id.to_string(), setting.model())
                })
                .collect(),
        )
    }

    /// Settings entries replace built-in ones with the same id and add new ones.
    #[must_use]
    pub fn with_overrides(mut self, settings: &BTreeMap<String, PriceSetting>) -> Self {
        for (id, s) in settings {
            self.0.insert(id.clone(), s.model());
        }
        self
    }

    /// The entry whose id is the longest prefix of `model`, so dated model
    /// ids (`claude-haiku-4-5-20251001`) find their family's price.
    pub fn get(&self, model: &str) -> Option<&Model> {
        self.0.iter().filter(|(id, _)| model.starts_with(id.as_str())).max_by_key(|(id, _)| id.len()).map(|(_, m)| m)
    }
}

/// The most a call can cost and use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Reservation {
    pub usd_micros: u64,
    pub tokens: u64,
}

impl Reservation {
    /// Input is bounded by the request's size in bytes (a byte-level
    /// tokenizer yields at most one token per byte) and by the context
    /// window; output by the request's cap, or the model's maximum when it
    /// sets none. Priced at the full input rate, so cache discounts only make
    /// the real cost lower.
    pub fn for_request(model: &Model, body_bytes: u64, max_output: Option<u64>) -> Self {
        let input = body_bytes.min(model.context_window);
        let output = max_output.unwrap_or(model.max_output).min(model.max_output);
        let usage = Usage { input, output, ..Usage::default() };
        Self { usd_micros: cost(&model.price, &usage), tokens: input + output }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Limits {
    pub usd_micros: Option<u64>,
    pub tokens: Option<u64>,
}

/// Why a call was not admitted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    Usd { limit: u64, committed: u64, wanted: u64 },
    Tokens { limit: u64, committed: u64, wanted: u64 },
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match *self {
            Refusal::Usd { limit, committed, wanted } => write!(
                f,
                "this call could cost up to {}, but only {} of the {} session budget is left",
                format_usd(wanted),
                format_usd(limit.saturating_sub(committed)),
                format_usd(limit)
            ),
            Refusal::Tokens { limit, committed, wanted } => write!(
                f,
                "this call could use up to {wanted} tokens, but only {} of the session's {limit} are left",
                limit.saturating_sub(committed)
            ),
        }
    }
}

impl std::error::Error for Refusal {}

#[derive(Debug, Clone, Default)]
pub struct Ledger {
    limits: Limits,
    spent_usd: u64,
    spent_tokens: u64,
    open: HashMap<u64, Reservation>,
}

impl Ledger {
    pub fn new(limits: Limits) -> Self {
        Self { limits, ..Self::default() }
    }

    pub fn limits(&self) -> Limits {
        self.limits
    }

    pub fn set_limits(&mut self, limits: Limits) {
        self.limits = limits;
    }

    pub fn spent_usd(&self) -> u64 {
        self.spent_usd
    }

    pub fn spent_tokens(&self) -> u64 {
        self.spent_tokens
    }

    /// Spent plus held by calls in flight.
    pub fn committed_usd(&self) -> u64 {
        self.spent_usd + self.open.values().map(|r| r.usd_micros).sum::<u64>()
    }

    fn committed_tokens(&self) -> u64 {
        self.spent_tokens + self.open.values().map(|r| r.tokens).sum::<u64>()
    }

    pub fn reserve(&mut self, call: u64, r: Reservation) -> Result<(), Refusal> {
        if let Some(limit) = self.limits.usd_micros {
            let committed = self.committed_usd();
            if committed + r.usd_micros > limit {
                return Err(Refusal::Usd { limit, committed, wanted: r.usd_micros });
            }
        }
        if let Some(limit) = self.limits.tokens {
            let committed = self.committed_tokens();
            if committed + r.tokens > limit {
                return Err(Refusal::Tokens { limit, committed, wanted: r.tokens });
            }
        }
        self.open.insert(call, r);
        Ok(())
    }

    /// Releases the call's reservation and charges what it actually cost.
    pub fn settle(&mut self, call: u64, usd_micros: u64, tokens: u64) {
        self.open.remove(&call);
        self.spent_usd += usd_micros;
        self.spent_tokens += tokens;
    }

    /// Rebuilds a ledger from a session's events. Calls that started but
    /// never finished are charged their full reservation, since no one can
    /// know what they cost.
    pub fn replay(events: &[Event]) -> Self {
        let mut l = Ledger::default();
        let mut abandoned = HashMap::new();
        for e in events {
            match e {
                Event::BudgetSet { usd_micros, tokens } => {
                    l.limits = Limits { usd_micros: *usd_micros, tokens: *tokens };
                }
                Event::ModelCallStarted { call, reserved_usd_micros, reserved_tokens, .. } => {
                    abandoned.insert(*call, Reservation { usd_micros: *reserved_usd_micros, tokens: *reserved_tokens });
                }
                Event::ModelCallFinished { call, outcome, .. } => {
                    abandoned.remove(call);
                    let (usd, tokens) = charge(outcome);
                    l.spent_usd += usd;
                    l.spent_tokens += tokens;
                }
                Event::SessionStarted { .. }
                | Event::UserMessage { .. }
                | Event::Recovered { .. }
                | Event::EffectStarted { .. }
                | Event::EffectFinished { .. }
                | Event::ApprovalModeSet { .. }
                | Event::ApprovalRequested { .. }
                | Event::ApprovalDecided { .. } => {}
            }
        }
        for r in abandoned.values() {
            l.spent_usd += r.usd_micros;
            l.spent_tokens += r.tokens;
        }
        l
    }
}

/// Calls that started but never finished, with what they reserved, in call
/// order. After a crash these are closed as broken, charged the reservation.
pub fn open_calls(events: &[Event]) -> Vec<(u64, Reservation)> {
    let mut open = std::collections::BTreeMap::new();
    for e in events {
        match e {
            Event::ModelCallStarted { call, reserved_usd_micros, reserved_tokens, .. } => {
                open.insert(*call, Reservation { usd_micros: *reserved_usd_micros, tokens: *reserved_tokens });
            }
            Event::ModelCallFinished { call, .. } => {
                open.remove(call);
            }
            _ => {}
        }
    }
    open.into_iter().collect()
}

/// What a finished call is charged.
pub fn charge(outcome: &CallOutcome) -> (u64, u64) {
    match outcome {
        CallOutcome::Complete { usage, cost_usd_micros, .. } => (*cost_usd_micros, usage.total()),
        CallOutcome::Rejected { .. } => (0, 0),
        CallOutcome::Broken { cost_usd_micros, tokens, .. } => (*cost_usd_micros, *tokens),
    }
}
