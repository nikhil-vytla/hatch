# Changes audit notes

## 2026-09-20

Started the dedicated audit of the original Change impact experiment. Scope is the current Changes component, its recorder, one published JSONL result, and offline reproduction. No app edits, paid model calls, or other experiment audits. Read the audit brief, current catalog, publication map, component, API/useRun helpers, recorder and the complete recorded response.

Initial evidence: three source facts, four conclusions and explicit dependency arrays travel through the same model state. The single stored venue-change run returns four noul scores. The live prompt additionally says to ignore spelling-only changes, which the recorded prompt omits. The record preserves response/provider metadata but does not preserve its submitted before/after/conclusion snapshots or questions.

Completed the callback probe and dedicated report. Assertions passed for the 4/4 supplied-graph match, two stale draft mismatches, three synthetic missing answers rendered as support, the no-op request, and the saved/live prompt difference. Kept real recorded coverage separate from synthetic boundary inputs. The proposed held-out evaluation is unrun.
