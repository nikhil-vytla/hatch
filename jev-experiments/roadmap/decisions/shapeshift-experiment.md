# One text box that becomes what you mean

- Owner: playable/design engineering, with routing/integration for the arena lane
- Stage: next wave; sits beside [adaptive interfaces](../../roadmap-additions-2026-09-21/decisions/adaptive-interfaces.md) and the first-release "Sort as you type" speed piece
- Status: proposed experiment; source reviewed, protocol and implementation open
- Source: [anishfn/shapeshift](https://github.com/anishfn/shapeshift) by Anish (MIT, [live demo](https://shapeshiftui.vercel.app)), reviewed 22 September 2026
- Dependencies: arena contestant interface and decision log; the real-time transport lessons from the Tetris lane (short budgets, drop superseded answers, back off, fall back locally); a keyword baseline; authored inputs with independent expected cards

## What Shapeshift does

Typing into one input morphs it into the right card: event, reminder, checklist, timer, colour, bill split, conversion, poll and about 19 types in all. One Jev call answers 14 typed questions at once (which card, plus signals such as "video call?" or "urgent?"), and deterministic parsers compute dates, amounts and units. Jev decides, code computes. A small state machine keeps the UI calm: a new card replaces the current one only when it wins twice in a row or is very sure, and signal badges use hysteresis. It works offline with a keyword classifier and falls back to it when Jev is unreachable or rate-limited.

## Decision

Build a Jev experiments version around the question it raises best: **how much of an interface can one fast typed decision shape, keystroke by keystroke, without flicker or waiting?** The visitor types; the box becomes a card; a side view shows the 14 questions, each answer's probabilities, and the calm-UI state machine deciding whether to commit, preview or offer two chips. Recorded answers for authored phrases work without a key; a key makes Jev live.

Run it as an arena lane too: the same keystroke stream through Jev, the keyword classifier, a Jimothy-style tiny model and Laya, each driving its own copy of the box, so flicker, time to the right card and wrong commits can be compared side by side.

## Proposed bounded protocol

1. Author 200 phrases with an expected card and expected signals, written before any model sees them, including ambiguous and adversarial cases ("dinner or lunch?", mixed currencies, long pastes). Keep 50 held out.
2. Replay each phrase as a keystroke stream at a fixed typing speed. Record every request, answer and state-machine transition with timestamps.
3. Compare Jev (batched 14 questions), the keyword classifier, a tiny local model and Laya. Report final-card accuracy, time to first correct card, number of visible card changes per phrase, wrong commits, and request count under rate limits.
4. Measure the calm-UI thresholds on development phrases only; freeze them before the held-out set.

## Outcomes

Primary: final-card accuracy and wrong commits on held-out phrases, and visible changes per phrase. Secondary: time to the right card, requests per phrase, cost where known, and behaviour when Jev is rate-limited. A result where the keyword classifier wins on simple cards and Jev wins on ambiguous ones is a useful finding, not a failure. This proposal adds no first-release scope.
