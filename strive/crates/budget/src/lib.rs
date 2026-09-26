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
    /// One-hour cache writes.
    pub cache_write_long: u64,
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
        + u128::from(usage.cache_write_long) * u128::from(price.cache_write_long)
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
const BUILTIN: &[(&str, PriceSetting)] = &[
    (
        "claude-haiku-4-5",
        PriceSetting {
            input: 1.0,
            output: 5.0,
            cache_write: Some(1.25),
            cache_write_long: Some(2.0),
            cache_read: Some(0.1),
            context_window: 200_000,
            max_output: Some(64_000),
        },
    ),
    (
        "claude-sonnet-4-5",
        PriceSetting {
            input: 3.0,
            output: 15.0,
            cache_write: Some(3.75),
            cache_write_long: Some(6.0),
            cache_read: Some(0.3),
            context_window: 200_000,
            max_output: Some(64_000),
        },
    ),
    (
        "claude-opus-4-5",
        PriceSetting {
            input: 5.0,
            output: 25.0,
            cache_write: Some(6.25),
            cache_write_long: Some(10.0),
            cache_read: Some(0.5),
            context_window: 200_000,
            max_output: Some(64_000),
        },
    ),
    (
        "claude-opus-4-1",
        PriceSetting {
            input: 15.0,
            output: 75.0,
            cache_write: Some(18.75),
            cache_write_long: Some(30.0),
            cache_read: Some(1.5),
            context_window: 200_000,
            max_output: Some(32_000),
        },
    ),
    (
        "gpt-4.1-mini",
        PriceSetting {
            input: 0.4,
            output: 1.6,
            cache_write: Some(0.0),
            cache_write_long: Some(0.0),
            cache_read: Some(0.1),
            context_window: 1_047_576,
            max_output: Some(32_768),
        },
    ),
    (
        "gpt-4.1",
        PriceSetting {
            input: 2.0,
            output: 8.0,
            cache_write: Some(0.0),
            cache_write_long: Some(0.0),
            cache_read: Some(0.5),
            context_window: 1_047_576,
            max_output: Some(32_768),
        },
    ),
    (
        "gpt-5-mini",
        PriceSetting {
            input: 0.25,
            output: 2.0,
            cache_write: Some(0.0),
            cache_write_long: Some(0.0),
            cache_read: Some(0.025),
            context_window: 400_000,
            max_output: Some(128_000),
        },
    ),
    (
        "gpt-5",
        PriceSetting {
            input: 1.25,
            output: 10.0,
            cache_write: Some(0.0),
            cache_write_long: Some(0.0),
            cache_read: Some(0.125),
            context_window: 400_000,
            max_output: Some(128_000),
        },
    ),
];

fn micros_per_mtok(dollars: f64) -> u64 {
    // Prices are published to at most three decimals of a dollar.
    #[expect(clippy::cast_possible_truncation, clippy::cast_sign_loss, reason = "non-negative, small")]
    let m = (dollars * 1_000_000.0).round() as u64;
    m
}

/// A price as written in settings: dollars per million tokens. Unset cache
/// rates default to the dearest rate any provider charges (writes 1.25x
/// input, one-hour writes 2x, reads at full input), so an omission can only
/// overstate cost.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PriceSetting {
    pub input: f64,
    pub output: f64,
    #[serde(default)]
    pub cache_write: Option<f64>,
    #[serde(default)]
    pub cache_write_long: Option<f64>,
    #[serde(default)]
    pub cache_read: Option<f64>,
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
                cache_write: micros_per_mtok(self.cache_write.unwrap_or(self.input * 1.25)),
                cache_write_long: micros_per_mtok(self.cache_write_long.unwrap_or(self.input * 2.0)),
                cache_read: micros_per_mtok(self.cache_read.unwrap_or(self.input)),
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
        Self(BUILTIN.iter().map(|(id, setting)| ((*id).to_string(), setting.model())).collect())
    }

    /// Settings entries replace built-in ones with the same id and add new ones.
    #[must_use]
    pub fn with_overrides(mut self, settings: &BTreeMap<String, PriceSetting>) -> Self {
        for (id, s) in settings {
            self.0.insert(id.clone(), s.model());
        }
        self
    }

    /// Every priced model, by id.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &Model)> {
        self.0.iter().map(|(id, m)| (id.as_str(), m))
    }

    /// The entry for `model`, or for the model it is a dated release of
    /// (`claude-haiku-4-5-20251001`, `gpt-4.1-2025-04-14`). Any other
    /// suffix names a different model (`gpt-5-pro` is not `gpt-5`) and gets
    /// no price.
    pub fn get(&self, model: &str) -> Option<&Model> {
        if let Some(m) = self.0.get(model) {
            return Some(m);
        }
        self.0.iter().find_map(|(id, m)| {
            let suffix = model.strip_prefix(id.as_str())?.strip_prefix('-')?;
            let digits = suffix.chars().filter(char::is_ascii_digit).count();
            let dated = digits == 8 && suffix.chars().all(|c| c.is_ascii_digit() || c == '-');
            dated.then_some(m)
        })
    }
}

/// Which rate bounds a request's input: a request that writes the cache can
/// be billed above the plain input rate for everything it sends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputRate {
    Plain,
    CacheWrite,
    CacheWriteLong,
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
    /// window, priced at the dearest rate the request can incur; output by
    /// the request's cap, or the model's maximum when it sets none, for each
    /// choice it asks for.
    pub fn for_call(model: &Model, body_bytes: u64, max_output: Option<u64>, choices: u64, rate: InputRate) -> Self {
        let input = body_bytes.min(model.context_window);
        let output = max_output.unwrap_or(model.max_output).min(model.max_output).saturating_mul(choices.max(1));
        let usage = match rate {
            InputRate::Plain => Usage { input, output, ..Usage::default() },
            InputRate::CacheWrite => Usage { cache_write: input, output, ..Usage::default() },
            InputRate::CacheWriteLong => Usage { cache_write_long: input, output, ..Usage::default() },
        };
        Self { usd_micros: cost(&model.price, &usage), tokens: input.saturating_add(output) }
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
    /// Replay gates running for proposals, by proposal: each holds money
    /// until its runs are over. One cut off by a crash is never released.
    holds: Vec<(u64, u64)>,
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

    /// Spent plus held by calls in flight and by replays.
    pub fn committed_usd(&self) -> u64 {
        let held = self.holds.iter().fold(self.spent_usd, |a, (_, usd)| a.saturating_add(*usd));
        self.open.values().fold(held, |a, r| a.saturating_add(r.usd_micros))
    }

    fn committed_tokens(&self) -> u64 {
        self.open.values().fold(self.spent_tokens, |a, r| a.saturating_add(r.tokens))
    }

    /// Whether `r` fits in what is left, without holding anything.
    pub fn check(&self, r: Reservation) -> Result<(), Refusal> {
        if let Some(limit) = self.limits.usd_micros {
            let committed = self.committed_usd();
            if committed.saturating_add(r.usd_micros) > limit {
                return Err(Refusal::Usd { limit, committed, wanted: r.usd_micros });
            }
        }
        if let Some(limit) = self.limits.tokens {
            let committed = self.committed_tokens();
            if committed.saturating_add(r.tokens) > limit {
                return Err(Refusal::Tokens { limit, committed, wanted: r.tokens });
            }
        }
        Ok(())
    }

    /// Whether `call` holds a reservation that hasn't been settled.
    pub fn is_open(&self, call: u64) -> bool {
        self.open.contains_key(&call)
    }

    pub fn reserve(&mut self, call: u64, r: Reservation) -> Result<(), Refusal> {
        self.check(r)?;
        self.open.insert(call, r);
        Ok(())
    }

    /// Holds `usd_micros` for proposal `proposal`'s replay, if it fits.
    pub fn hold(&mut self, proposal: u64, usd_micros: u64) -> Result<(), Refusal> {
        self.check(Reservation { usd_micros, tokens: 0 })?;
        self.holds.push((proposal, usd_micros));
        Ok(())
    }

    /// Releases the proposal's latest replay hold and charges what the
    /// replay cost. An earlier hold for the same proposal (a run a crash cut
    /// off) stays held.
    pub fn release(&mut self, proposal: u64, usd_micros: u64, tokens: u64) {
        if let Some(i) = self.holds.iter().rposition(|(p, _)| *p == proposal) {
            self.holds.remove(i);
        }
        self.spent_usd = self.spent_usd.saturating_add(usd_micros);
        self.spent_tokens = self.spent_tokens.saturating_add(tokens);
    }

    /// Releases the call's reservation and charges what it actually cost.
    pub fn settle(&mut self, call: u64, usd_micros: u64, tokens: u64) {
        self.open.remove(&call);
        self.spent_usd = self.spent_usd.saturating_add(usd_micros);
        self.spent_tokens = self.spent_tokens.saturating_add(tokens);
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
                    l.spent_usd = l.spent_usd.saturating_add(usd);
                    l.spent_tokens = l.spent_tokens.saturating_add(tokens);
                }
                Event::SessionStarted { .. }
                | Event::UserMessage { .. }
                | Event::Recovered { .. }
                | Event::EffectStarted { .. }
                | Event::EffectFinished { .. }
                | Event::ApprovalModeSet { .. }
                | Event::ApprovalRequested { .. }
                | Event::ApprovalDecided { .. }
                | Event::Checkpointed { .. }
                | Event::Rewound { .. }
                | Event::TurnStarted { .. }
                | Event::LayoutProposed { .. }
                | Event::AssistantMessage { .. }
                | Event::TurnEnded { .. }
                | Event::ContextLoaded { .. }
                | Event::Compacted { .. }
                | Event::LearnRequested { .. }
                | Event::ProposalMade { .. }
                | Event::GateFinished { .. }
                | Event::ProposalDecided { .. }
                | Event::ProposalApplied { .. }
                | Event::ProposalRolledBack { .. }
                | Event::PredictionChecked { .. }
                | Event::ModelSet { .. } => {}
                Event::ReplayStarted { proposal, reserved_usd_micros } => {
                    l.holds.push((*proposal, *reserved_usd_micros));
                }
                Event::ReplayFinished { proposal, cost_usd_micros, tokens, .. } => {
                    l.release(*proposal, *cost_usd_micros, *tokens);
                }
            }
        }
        for r in abandoned.values() {
            l.spent_usd = l.spent_usd.saturating_add(r.usd_micros);
            l.spent_tokens = l.spent_tokens.saturating_add(r.tokens);
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
