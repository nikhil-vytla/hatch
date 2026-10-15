# Worked example: Acme Inc.

This example uses the fictional company from the source article. Acme is a mid-sized SaaS business. A user asks: **"Make me the slide deck for our quarterly business review."**

## Rung 0: baseline (speed)

> Build a QBR deck from these summary metrics.

Faster than doing it by hand, but no more ambitious.

## Altitude

Climbing: the deck exists so leadership spots problems → so they decide what to do → so problems get caught before the quarter is lost.

- **Rung A1 (analyse):** "Here is every raw export we have: billing, product events, support tickets, CRM. What changed this quarter, why, and what should we do about it?"
- **Rung A2 (decide):** "Name the three decisions leadership most urgently needs to make. For each, write the strongest case for and the strongest case against."
- **Rung A3 (redesign):** "Design a process that catches these problems sooner than a quarterly deck does. Back-test it against our last eight quarters to see what it would have flagged and when. Then run it alongside the QBR for one quarter."
- **Outside judge:** the back-test against history and the parallel run.
- **Access:** raw exports or connectors for all four systems, plus somewhere to run a scheduled job.
- **Cost to user:** they have to give up control of the deck format and commit to a one-quarter parallel run.

## Depth

The deck shows churn is up. The user assumes the cause is onboarding.

- **Pro move not asked for:** a cohort survival analysis and a test of the onboarding hypothesis.
- **Rawest material:** event-level product logs and billing records, not the dashboard numbers.
- **Methods and tools:** load into DuckDB, fit a Cox proportional-hazards model on cohort features, and simulate customer populations to stress-test candidate signals.
- **Unreasonable target:** "Find a churn signal that shows up 60 days before cancellation."
- **Produce new knowledge:** find early-warning behaviours nobody tracks today. Validate them on a held-out quarter the model never saw while searching.
- **Outside judge:** the holdout quarter's predictive performance.

## Range

Nouns → verbs: the QBR becomes *get busy people to believe a cause-and-effect story and decide under uncertainty in 30 minutes*.

| Crew member | Method | Artefact |
|---|---|---|
| Analyst | Runs the survival model and the decomposition of changes | Charts with confidence intervals |
| Data journalist | Turns findings into a three-beat causal story | Narrative spine |
| Editor | Cuts anything that doesn't serve a decision | A 10-slide cut |
| Motion and audio designer | Animates the one chart that carries the argument | A 20-second explainer clip |
| **Short seller** (adversary) | Builds the strongest case that the story is wrong | A list of flattering metrics and how much they move the conclusion |
| **Forensic accountant** (adversary) | Ties every number back to the ledger | A reconciliation table |

## Combined rung (recommended)

> Using raw exports from billing, product events, support and CRM: (1) test whether rising churn is really an onboarding problem, with a cohort hazard model in DuckDB, and look for leading signals that a held-out quarter confirms; (2) name the three decisions leadership must make, with for/against cases, and red-team them as a short seller and a forensic accountant would; (3) propose a standing early-warning process, back-tested on the last eight quarters, to run alongside next quarter's QBR. Deliver the 10-slide deck as a by-product.

**Prerequisites:** a machine with Python and DuckDB, read access to the four systems, and the user agreeing to a one-quarter parallel run.
