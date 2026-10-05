# Roadmap: the modules the September release lab left running

The release lab's plans, decision tickets, reviews, delivery slices, design research and one-off release checks are finished. They moved to [`archive/release-lab-2026-09`](../archive/release-lab-2026-09/README.md) on 4 Oct 2026. What stays here is still read by the site, its tests or CI:

| Folder | What reads it |
| --- | --- |
| [`runtime/`](runtime/README.md) | The shared decision contract. The Score note imports `contract.ts`; `jev-gateway.yml` and the typed-runtime verifier run its tests. |
| [`routing/`](routing/README.md) | The routing toolkit (TypeScript, CLI, local MCP). The Routing note shows `policy.ts` and the comparison report; the typed-runtime verifier runs its tests. |
| [`mac/`](mac/README.md) | The local Mac runtime. Routing tests read `models.json`; the arena's Laya recorders load `jev_local.py`. |
| [`integration/`](integration/README.md) | Portable coding-client evidence. The build projects it into `public/routing-evidence/`; `jev-site.yml` runs its tests and `evidence_index.py`. |
| [`verification/`](verification/) | `publication.ts` writes `publication-index.json`, the integrity index `jev-site.yml` holds fixed. `live-route.ts` and its JSON records are the live routing evidence. |
| [`training/`](training/README.md) | The typed-decision study. The Score note links its README, protocol and provenance; the Mac installer copies its checkpoint. |
| [`tetris/`](tetris/README.md) | The six live Tetris games. Arena and live-world tests replay `games.jsonl`. |
| [`playable/`](playable/README.md) | Crowd and music prototypes with their tests. |
| `credits.tsx` | The site's builder credits. |
| [`MAP.md`](MAP.md) | The work map the About page and the retired-scenes list link to. |

The [typed-runtime workflow](../../.github/workflows/jev-typed-runtime.yml) watches `runtime/`, `routing/`, `mac/` and `tsconfig.json`, so those paths stay until the workflow changes with them.
