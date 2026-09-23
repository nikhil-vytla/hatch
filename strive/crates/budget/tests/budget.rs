use strive_budget::{Ledger, Limits, Models, Price, Refusal, Reservation, cost, format_usd, open_calls};
use strive_proto::{CallOutcome, Digest, Event, Usage};

const HAIKU: Price = Price { input: 1_000_000, output: 5_000_000, cache_write: 1_250_000, cache_read: 100_000 };
const SONNET: Price = Price { input: 3_000_000, output: 15_000_000, cache_write: 3_750_000, cache_read: 300_000 };

fn usage(input: u64, output: u64) -> Usage {
    Usage { input, output, ..Usage::default() }
}

#[test]
fn cost_is_tokens_times_price_per_million() {
    assert_eq!(cost(&HAIKU, &usage(1000, 500)), 3500);
    assert_eq!(
        cost(&SONNET, &Usage { input: 10, output: 20, cache_write: 1000, cache_read: 100_000 }),
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
    assert_eq!(
        m.get("claude-haiku-4-5").unwrap().price.cache_read,
        0,
        "an override replaces the whole entry; unset cache prices are zero"
    );
}

#[test]
fn a_reservation_bounds_input_by_bytes_and_the_context_window() {
    let m = Models::builtin();
    let sonnet = m.get("claude-sonnet-4-5").unwrap();
    assert_eq!(
        Reservation::for_request(sonnet, 1000, Some(100)),
        Reservation { usd_micros: 3000 + 1500, tokens: 1100 }
    );
    assert_eq!(
        Reservation::for_request(sonnet, 5_000_000, Some(100)),
        Reservation { usd_micros: 200_000 * 3 + 1500, tokens: 200_100 },
        "input can't exceed the context window"
    );
}

#[test]
fn a_request_without_an_output_cap_is_bounded_by_the_models_maximum() {
    let m = Models::builtin();
    let haiku = m.get("claude-haiku-4-5").unwrap();
    assert_eq!(Reservation::for_request(haiku, 10, None), Reservation { usd_micros: 10 + 64_000 * 5, tokens: 64_010 });
    assert_eq!(
        Reservation::for_request(haiku, 10, Some(1_000_000)),
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
        Err(Refusal::Usd { limit: 10_000, committed: 6000, wanted: 5000 })
    );
    l.reserve(3, Reservation { usd_micros: 4000, tokens: 10 }).unwrap();
    assert_eq!(l.committed_usd(), 10_000);
}

#[test]
fn refusals_explain_the_numbers() {
    assert_eq!(
        Refusal::Usd { limit: 1_000_000, committed: 990_000, wanted: 12_000 }.to_string(),
        "this call could cost up to $0.0120, but only $0.0100 of the $1.0000 session budget is left"
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
        Err(Refusal::Usd { limit: 4000, committed: 5000, wanted: 1 })
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
