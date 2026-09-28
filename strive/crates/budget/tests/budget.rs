#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason = "a test fails by panicking")]
use strive_budget::{Ledger, Limits, Models, Price, Refusal, Reservation, cost, format_usd, open_calls};
use strive_proto::{CallOutcome, Digest, Event, Usage};

const HAIKU: Price = Price {
    input: 1_000_000,
    output: 5_000_000,
    cache_write: 1_250_000,
    cache_write_long: 2_000_000,
    cache_read: 100_000,
};
const SONNET: Price = Price {
    input: 3_000_000,
    output: 15_000_000,
    cache_write: 3_750_000,
    cache_write_long: 6_000_000,
    cache_read: 300_000,
};

fn usage(input: u64, output: u64) -> Usage {
    Usage { input, output, ..Usage::default() }
}

#[test]
fn cost_is_tokens_times_price_per_million() {
    assert_eq!(cost(&HAIKU, &usage(1000, 500)), 3500);
    assert_eq!(
        cost(&SONNET, &Usage { input: 10, output: 20, cache_write: 1000, cache_read: 100_000, ..Usage::default() }),
        30 + 300 + 3750 + 30_000
    );
}

#[test]
fn fractions_of_a_micro_dollar_round_up() {
    assert_eq!(cost(&HAIKU, &Usage { cache_read: 1, ..Usage::default() }), 1);
    assert_eq!(cost(&HAIKU, &Usage { cache_read: 10, ..Usage::default() }), 1);
    assert_eq!(cost(&HAIKU, &Usage { cache_read: 11, ..Usage::default() }), 2);
    assert_eq!(cost(&HAIKU, &Usage::default()), 0);
}

#[test]
fn dollars_format_to_four_places() {
    assert_eq!(format_usd(0), "$0.0000");
    assert_eq!(format_usd(3500), "$0.0035");
    assert_eq!(format_usd(5_000_000), "$5.0000");
    assert_eq!(format_usd(12_345_678), "$12.3457");
    assert_eq!(format_usd(49), "$0.0001", "a started cost never shows as zero");
}

#[test]
fn models_match_by_longest_prefix() {
    let m = Models::builtin();
    assert_eq!(m.get("claude-haiku-4-5-20251001").map(|m| m.price), Some(HAIKU));
    assert_eq!(m.get("claude-sonnet-4-5").map(|m| m.price), Some(SONNET));
    assert_eq!(m.get("claude-opus-4-1-20250805").map(|m| m.price.output), Some(75_000_000));
    assert_eq!(m.get("gpt-4.1-mini").map(|m| m.price.input), Some(400_000));
    assert_eq!(m.get("gpt-4.1").map(|m| m.price.input), Some(2_000_000));
    assert_eq!(m.get("claude-unknown-9"), None);
    assert_eq!(m.get("haiku"), None);
}

#[test]
fn configured_prices_override_and_extend_the_builtins() {
    let json = r#"{
        "claude-haiku-4-5": {"input": 2.0, "output": 10.0, "contextWindow": 200000},
        "claude-opus-5-5": {"input": 5.0, "output": 25.0, "cacheWrite": 6.25, "cacheRead": 0.5, "contextWindow": 1000000, "maxOutput": 128000}
    }"#;
    let m = Models::builtin().with_overrides(&serde_json::from_str(json).unwrap());
    assert_eq!(
        m.get("claude-haiku-4-5-20251001").map(|m| (m.price.input, m.price.output)),
        Some((2_000_000, 10_000_000))
    );
    let opus = m.get("claude-opus-5-5").unwrap();
    assert_eq!((opus.price.cache_read, opus.context_window, opus.max_output), (500_000, 1_000_000, 128_000));
    assert_eq!(m.get("claude-haiku-4-5").unwrap().max_output, 200_000, "max output defaults to the context window");
    let p = m.get("claude-haiku-4-5").unwrap().price;
    assert_eq!((p.cache_write, p.cache_write_long), (2_500_000, 4_000_000), "unset writes cost 1.25x and 2x input");
    assert_eq!(
        m.get("claude-haiku-4-5").unwrap().price.cache_read,
        2_000_000,
        "an override replaces the whole entry; an unset cache price defaults to the dearest rate, full input"
    );
}

/// The daemon lists the models it can price (`models/list`) from `iter`: an
/// added model shows up, and each listed entry is the one `get` prices by.
#[test]
fn every_priced_model_is_listed_with_its_price() {
    let json = r#"{"claude-opus-5-5": {"input": 5.0, "output": 25.0, "contextWindow": 1000000}}"#;
    let m = Models::builtin().with_overrides(&serde_json::from_str(json).unwrap());
    let listed: Vec<(&str, Price)> = m.iter().map(|(id, model)| (id, model.price)).collect();
    assert!(listed.iter().any(|(id, _)| *id == "claude-opus-5-5"), "{listed:?}");
    assert!(listed.iter().any(|(id, _)| *id == "claude-haiku-4-5"), "the builtins stay listed: {listed:?}");
    for (id, price) in &listed {
        assert_eq!(m.get(id).map(|model| model.price), Some(*price), "{id}");
    }
}

#[test]
fn a_reservation_bounds_input_by_bytes_and_the_context_window() {
    let m = Models::builtin();
    let sonnet = m.get("claude-sonnet-4-5").unwrap();
    assert_eq!(
        Reservation::for_call(sonnet, 1000, Some(100), 1, strive_budget::InputRate::Plain),
        Reservation { usd_micros: 3000 + 1500, tokens: 1100 }
    );
    assert_eq!(
        Reservation::for_call(sonnet, 5_000_000, Some(100), 1, strive_budget::InputRate::Plain),
        Reservation { usd_micros: 200_000 * 3 + 1500, tokens: 200_100 },
        "input can't exceed the context window"
    );
}

#[test]
fn a_request_without_an_output_cap_is_bounded_by_the_models_maximum() {
    let m = Models::builtin();
    let haiku = m.get("claude-haiku-4-5").unwrap();
    assert_eq!(
        Reservation::for_call(haiku, 10, None, 1, strive_budget::InputRate::Plain),
        Reservation { usd_micros: 10 + 64_000 * 5, tokens: 64_010 }
    );
    assert_eq!(
        Reservation::for_call(haiku, 10, Some(1_000_000), 1, strive_budget::InputRate::Plain),
        Reservation { usd_micros: 10 + 64_000 * 5, tokens: 64_010 },
        "a cap above the model's maximum can't be reached"
    );
}

#[test]
fn reservations_are_admitted_only_within_the_limit() {
    let mut l = Ledger::new(Limits { usd_micros: Some(10_000), tokens: None });
    l.reserve(1, Reservation { usd_micros: 6000, tokens: 10 }).unwrap();
    assert_eq!(
        l.reserve(2, Reservation { usd_micros: 5000, tokens: 10 }),
        Err(Refusal::Usd { limit: 10_000, committed: 6000, wanted: 5000, held: 0 })
    );
    l.reserve(3, Reservation { usd_micros: 4000, tokens: 10 }).unwrap();
    assert_eq!(l.committed_usd(), 10_000);
}

#[test]
fn refusals_explain_the_numbers() {
    assert_eq!(
        Refusal::Usd { limit: 1_000_000, committed: 990_000, wanted: 12_000, held: 0 }.to_string(),
        "this call could cost up to $0.0120, but only $0.0100 of the $1.0000 session budget is left"
    );
    assert_eq!(
        Refusal::Usd { limit: 1_000_000, committed: 990_000, wanted: 12_000, held: 900_000 }.to_string(),
        "this call could cost up to $0.0120, but only $0.0100 of the $1.0000 session budget is left, \
         with $0.9000 of it held by replays that haven't finished"
    );
    assert_eq!(
        Refusal::Tokens { limit: 1000, committed: 900, wanted: 200 }.to_string(),
        "this call could use up to 200 tokens, but only 100 of the session's 1000 are left"
    );
}

#[test]
fn settling_replaces_the_reservation_with_the_actual_cost() {
    let mut l = Ledger::new(Limits { usd_micros: Some(10_000), tokens: Some(1000) });
    l.reserve(1, Reservation { usd_micros: 9000, tokens: 900 }).unwrap();
    l.settle(1, 2000, 150);
    assert_eq!((l.spent_usd(), l.committed_usd(), l.spent_tokens()), (2000, 2000, 150));
    l.reserve(2, Reservation { usd_micros: 8000, tokens: 850 }).unwrap();
}

#[test]
fn token_limits_are_enforced_too() {
    let mut l = Ledger::new(Limits { usd_micros: None, tokens: Some(1000) });
    l.reserve(1, Reservation { usd_micros: 1, tokens: 600 }).unwrap();
    assert_eq!(
        l.reserve(2, Reservation { usd_micros: 1, tokens: 500 }),
        Err(Refusal::Tokens { limit: 1000, committed: 600, wanted: 500 })
    );
}

#[test]
fn lowering_the_limit_below_spend_refuses_further_calls() {
    let mut l = Ledger::new(Limits { usd_micros: Some(10_000), tokens: None });
    l.reserve(1, Reservation { usd_micros: 5000, tokens: 1 }).unwrap();
    l.settle(1, 5000, 1);
    l.set_limits(Limits { usd_micros: Some(4000), tokens: None });
    assert_eq!(
        l.reserve(2, Reservation { usd_micros: 1, tokens: 1 }),
        Err(Refusal::Usd { limit: 4000, committed: 5000, wanted: 1, held: 0 })
    );
}

fn started(call: u64, usd: u64, tokens: u64) -> Event {
    Event::ModelCallStarted {
        call,
        provider: "anthropic".into(),
        model: "claude-haiku-4-5".into(),
        request: Digest::from_bytes([0; 32]),
        reserved_usd_micros: usd,
        reserved_tokens: tokens,
    }
}

fn finished(call: u64, outcome: CallOutcome) -> Event {
    Event::ModelCallFinished { call, outcome, response: None, duration_ms: 10 }
}

#[test]
fn a_ledger_is_rebuilt_from_journal_events() {
    let events = vec![
        Event::BudgetSet { usd_micros: Some(100_000), tokens: None },
        started(1, 9000, 900),
        finished(1, CallOutcome::Complete { status: 200, usage: usage(100, 50), cost_usd_micros: 350 }),
        started(2, 9000, 900),
        finished(2, CallOutcome::Rejected { status: 429 }),
        started(3, 9000, 900),
        finished(3, CallOutcome::Broken { reason: "stream cut".into(), cost_usd_micros: 9000, tokens: 900 }),
        Event::BudgetSet { usd_micros: Some(50_000), tokens: Some(5000) },
    ];
    let l = Ledger::replay(&events);
    assert_eq!(l.limits(), Limits { usd_micros: Some(50_000), tokens: Some(5000) });
    assert_eq!((l.spent_usd(), l.spent_tokens(), l.committed_usd()), (350 + 9000, 150 + 900, 9350));
}

/// A call that started but never finished (the daemon died mid-call) is
/// charged its full reservation: its real cost is unknown.
#[test]
fn a_call_left_open_by_a_crash_is_charged_its_reservation() {
    let events = vec![Event::BudgetSet { usd_micros: Some(100_000), tokens: None }, started(1, 9000, 900)];
    let l = Ledger::replay(&events);
    assert_eq!((l.spent_usd(), l.spent_tokens(), l.committed_usd()), (9000, 900, 9000));
}

#[test]
fn open_calls_are_listed_in_call_order_with_their_reservations() {
    let events = vec![
        started(5, 500, 5),
        started(2, 200, 2),
        started(3, 300, 3),
        finished(3, CallOutcome::Rejected { status: 500 }),
    ];
    assert_eq!(
        open_calls(&events),
        vec![(2, Reservation { usd_micros: 200, tokens: 2 }), (5, Reservation { usd_micros: 500, tokens: 5 })]
    );
    assert_eq!(open_calls(&events[3..]), vec![]);
}

#[test]
fn only_exact_ids_and_dated_releases_share_a_price() {
    let m = Models::builtin();
    assert_eq!(m.get("gpt-5-pro"), None, "a different model with a shared prefix is not priced as gpt-5");
    assert_eq!(m.get("gpt-4.1-nano"), None);
    assert_eq!(m.get("claude-haiku-4-5-20251001").map(|m| m.price.input), Some(1_000_000));
    assert_eq!(m.get("gpt-4.1-2025-04-14").map(|m| m.price.input), Some(2_000_000));
    assert_eq!(m.get("gpt-4.1-mini-2025-04-14").map(|m| m.price.input), Some(400_000));
    assert_eq!(m.get("claude-haiku-4-5-latest"), None);
}

#[test]
fn a_reservation_covers_several_choices_and_the_cache_write_rate() {
    use strive_budget::InputRate;
    let m = Models::builtin();
    let sonnet = m.get("claude-sonnet-4-5").unwrap();
    let r = |bytes, out, choices, rate| Reservation::for_call(sonnet, bytes, out, choices, rate).usd_micros;
    assert_eq!(r(1000, Some(100), 1, InputRate::Plain), 3000 + 1500);
    assert_eq!(r(1000, Some(100), 3, InputRate::Plain), 3000 + 4500);
    assert_eq!(r(1000, Some(100), 1, InputRate::CacheWrite), 3750 + 1500);
    assert_eq!(r(1000, Some(100), 1, InputRate::CacheWriteLong), 6000 + 1500);
}

#[test]
fn one_hour_cache_writes_cost_twice_the_input_rate() {
    let u = Usage { cache_write_long: 1000, ..Usage::default() };
    assert_eq!(cost(&Models::builtin().get("claude-haiku-4-5").unwrap().price, &u), 2000);
}

/// A usage report no real call produces must not wrap the ledger around
/// to admit more calls.
#[test]
fn absurd_usage_saturates_instead_of_wrapping() {
    let mut l = Ledger::new(Limits { usd_micros: Some(10_000), tokens: None });
    l.reserve(1, Reservation { usd_micros: 1, tokens: 1 }).unwrap();
    l.settle(1, u64::MAX, u64::MAX);
    l.settle(2, 5, 5);
    assert_eq!(l.spent_usd(), u64::MAX);
    assert!(l.reserve(3, Reservation { usd_micros: 589, tokens: 1 }).is_err());
    let huge = Usage { input: u64::MAX, output: u64::MAX, ..Usage::default() };
    assert_eq!(huge.total(), u64::MAX);
}

#[test]
fn unset_cache_rates_default_to_the_dearest_rates() {
    let settings: std::collections::BTreeMap<String, strive_budget::PriceSetting> =
        serde_json::from_str(r#"{"some-model": {"input": 3.0, "output": 9.0, "contextWindow": 1000}}"#).unwrap();
    let m = Models::builtin().with_overrides(&settings);
    let p = m.get("some-model").unwrap().price;
    assert_eq!((p.cache_write, p.cache_write_long, p.cache_read), (3_750_000, 6_000_000, 3_000_000));
}

#[test]
fn a_call_is_open_from_reservation_until_settlement() {
    let mut l = Ledger::new(Limits::default());
    assert!(!l.is_open(1));
    l.reserve(1, Reservation { usd_micros: 5, tokens: 5 }).unwrap();
    assert!(l.is_open(1));
    assert!(!l.is_open(2));
    l.settle(1, 5, 5);
    assert!(!l.is_open(1));
}

#[test]
fn a_replay_hold_counts_against_calls_until_it_is_released_at_its_cost() {
    let mut l = Ledger::new(Limits { usd_micros: Some(10_000), tokens: None });
    l.hold(7, 8000).unwrap();
    assert_eq!(
        l.reserve(1, Reservation { usd_micros: 3000, tokens: 1 }),
        Err(Refusal::Usd { limit: 10_000, committed: 8000, wanted: 3000, held: 8000 })
    );
    assert_eq!(l.hold(8, 3000), Err(Refusal::Usd { limit: 10_000, committed: 8000, wanted: 3000, held: 8000 }));
    l.release(7, 1500, 400);
    assert_eq!((l.spent_usd(), l.committed_usd(), l.spent_tokens()), (1500, 1500, 400));
    l.reserve(1, Reservation { usd_micros: 3000, tokens: 1 }).unwrap();
}

/// A replay cut off by a crash is run again with a hold of its own; the
/// first hold, whose runs' cost is unknown, stays charged in full.
#[test]
fn a_replay_hold_a_crash_left_open_stays_committed_when_the_rerun_finishes() {
    let events = vec![
        Event::BudgetSet { usd_micros: Some(100_000), tokens: None },
        Event::ReplayStarted { proposal: 5, reserved_usd_micros: 20_000 },
        Event::ReplayStarted { proposal: 5, reserved_usd_micros: 20_000 },
        Event::ReplayFinished { proposal: 5, cost_usd_micros: 3000, tokens: 700, runs: Vec::new() },
    ];
    let l = Ledger::replay(&events);
    assert_eq!((l.spent_usd(), l.spent_tokens(), l.committed_usd()), (3000, 700, 23_000));
    let open = Ledger::replay(&events[..3]);
    assert_eq!((open.spent_usd(), open.committed_usd()), (0, 40_000));
}
