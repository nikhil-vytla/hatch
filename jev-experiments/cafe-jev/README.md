# Cafe Jev

Cafe Jev replaces the fixed drink lookup with a small fictional cafe. A customer arrives with a request, Jev interprets their preferences, and code checks the available recipes. Visitors can answer a useful question, pick a drink, adjust milk, temperature, sweetness, size, espresso shots or vanilla, revise preferences, undo a decision and receive a simulated receipt. Nothing is purchased or sent to a real cafe.

The illustrated counter uses [Motion](https://motion.dev/docs/react) to show ingredient, size and temperature changes. Iced drinks have ice and condensation; hot drinks have steam. The interface supports dark mode, narrow screens, keyboard controls and reduced motion. Recorded Jev, live Jev and manual choices have separate provenance. An inspector preserves the public conversation, model probabilities, rejected suggestions and replayable decisions.

## What code owns

[engine.ts](engine.ts) defines the only ingredient, price, recipe and inventory catalog used by this experiment. Five drink families produce 304 legal recipes. Default stock permits 228; soy is sold out, and oat milk is also sold out for customer seeds divisible by five. Cocoa is caffeine-free in this fictional catalog. These are authored facts, not nutritional claims about real products.

Seven preference fields distinguish required, preferred, unknown and conflicting values. Creaminess is separate from dairy; caffeine quantity is separate from coffee flavor. Code enumerates recipes, filters hard requirements, scores soft preferences, calculates exact cent prices and checks stock again before confirmation. Only explicit customer actions can relax a requirement. Unsupported budget values block confirmation until the customer selects a supported exact maximum.

Jev selects typed preference values, supporting transcript turns, a question and a drink family. Its family suggestion must have a legal recipe after extraction. An invalid suggestion remains in the trace; the interface asks the visitor to choose a legal alternative. A model's source turn is evidence for inspection, not proof that it understood that language correctly.

Customer goals belong to a separate deterministic simulator. They never enter a provider request. After confirmation, the simulator checks the actual recipe against its private goal, reports whether that goal was possible with the current stock, and lets the visitor reveal the goal. These three authored customers are demonstrations, not a 120-customer evaluation.

Every pending request carries a session and revision ticket. Draft edits, manual selections, preference answers, undo, replay and customer changes abort the request and invalidate late responses. A scripted opening must be interpreted before confirmation, including when the visitor changes modes. The visitor's live key uses the existing in-memory BYOK API.

## Recorded evidence

[cafe.jsonl](cafe.jsonl) contains genuine responses from `typesafe-ai/jev` through the existing [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) recording path. The declared set in [cases.ts](cases.ts) has 102 requests: all 81 partial states of the four core preferences and 21 cases covering customers, negation, ambiguity, soft preferences, contradictions, revisions, unsupported budgets and stock conflicts. The new customizable catalog has three impossible partial states; it should not be confused with the old eight-drink menu's 16 impossible partial states.

All 102 declared cases completed. Jev matched every annotated preference value and strength in 89 cases, including 77 of the 81 direct finite-state cases. Its extracted preferences produced the exact expected feasible set in 93 cases. It proposed an impossible drink family eight times; none of the suggestions admitted by the code violated an authored hard requirement in this fixture.

| Measure | Observed result |
| --- | --- |
| Exact preference extraction | 89/102 |
| Exact finite-state extraction | 77/81 |
| Exact feasible recipe set | 93/102 |
| Useful raw clarification questions | 65/80 questions asked |
| Raw no-match detection | 2 true positives, 5 misses, 1 false positive |
| Raw family suggestions violating requirements | 8/75 suggestions |
| Admitted recipe suggestions violating requirements | 0/65 suggestions |
| Completed physical requests | 82 |
| Failed batches retained separately | 24 |
| Provider attempts, including retries and failed batches | 146 |
| Completed request latency, median / p95 | 358 ms / 2,844 ms |

The errors explain why the guards matter. Jev sometimes treated dairy-free as non-creamy, inferred coffee flavor from caffeine, or chose lemonade for an unsweetened request. It missed several no-match situations. The default Mina suggestion meets her private goal, Eli initially needs clarification, and Ro's dairy-free creamy goal cannot be met while oat and soy are sold out. These opening-turn outcomes are not a multi-turn completion rate.

The recorder initially grouped three independent public cases per physical request, then switched to one to cope with provider overload. Recording and live mode share the same typed choices, source-turn extraction and preference semantics. The recorder names each case and prefixes its question ids; live mode names its single public transcript directly. `requestBatches` preserves the original grouping and reconstructs the exact public payload from the committed prompt builder. Batch latency is reported once per physical request, never once per answer.

These are authored development fixtures with one direct wording per finite state and one option order. Expected labels were written before the calls but have not received independent human annotation. Some strict annotation differences concern requirement strength, such as "a little sweetness is good," rather than an unusable drink. Provider errors and retries remain separate from model correctness. There is no held-out customer study, no calibration claim and no claim that a guard can correct a misunderstood request.

## Verification and reproduction

From the repository root:

```sh
bun test jev-experiments/cafe-jev/engine.test.ts jev-experiments/cafe-jev/evidence.test.ts
bun run jev-experiments/cafe-jev/record.ts
bun run jev-experiments/cafe-jev/summarize.ts
```

The recording script uses the existing local credential loader. It checkpoints each completed batch, retains provider failures and resumes only missing cases. Long `Retry-After` values receive a bounded wait with at most three outer retries per batch. A later invocation retries remaining gaps. Run the summarizer only after the recorder finishes; it derives scores from preserved answers and never substitutes corrected model output.

The engine tests enumerate every legal recipe and all 81 partial states against an independent four-attribute oracle. They check invalid modifiers, sold-out stock, price limits, soft preferences, question usefulness, conflict resolution, manual authority, source-turn validation, deterministic customer scoring and request ticket invalidation. Evidence tests verify every declared case is present once, scores reproduce, provider failures stay separate and public payloads contain no private goals or expected answers. The app also passes TypeScript checking.

Playwright verified desktop ordering, size/price updates, provenance changes, undo, confirmation, hidden-goal gating, no-match substitutions and a delayed live response arriving after a manual edit. The race used an intercepted local response and a placeholder key, with no real network inference. A 390 px mobile viewport had no horizontal overflow. See the [desktop capture](output/playwright/cafe-desktop.png) and [dark mobile capture](output/playwright/cafe-mobile-dark.png).

The app entry point is `experience-prototypes/src/cafe-jev.tsx`, with styles in `cafe-jev.css`. The existing beverage route renders `Beverage({ result })`; the publication manifest maps its `cafe` data key to this folder's JSONL file. The original adaptive questionnaire remains a separate experiment.
