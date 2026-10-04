/**
 * What each game and simulation page keeps in its evidence drawer. Play stays on the page; the
 * drawer holds results that aren't already shown there, the caveats, and where the data lives.
 * Numbers are read from the scene's records, never typed in.
 */
import type { ReactNode } from "react";
import heldout from "../../../live-worlds/ocean/heldout.json";
import { percent } from "../api";
import { PROMPTS } from "../../../live-worlds/eyes/model";
import { SENTRY_CAVEATS, SentryData, SentryMethod, SentryResults } from "../screen-sentry-evidence";
import { SPINE_CAVEATS, SpineData, SpineMethod, SpineResults } from "../spine-evidence";
import { WHO_CAVEATS, WhoData, WhoMethod, WhoResults } from "../who-said-that-evidence";
import type { EvidenceTab } from "./evidence-drawer";

/** Pages that use the game format: play first, evidence in a drawer. */
export const GAME_PAGES = new Set(["ocean", "rumour-mill", "win-over", "snake", "games", "tetris", "eyes", "screen-sentry", "who-said-that", "spine"]);

const REPO = "https://github.com/nikhil-vytla/hatch/tree/main/jev-experiments";

const source = (path: string, label = path) => (
  <a href={`${REPO}/${path}`} target="_blank" rel="noreferrer">
    {label}
  </a>
);

const EVENTS = ["heatwave", "net", "storm", "bloom", "oil"] as const;

type Survival = { survival: number; survivalSd: number };

function ReefResults() {
  return (
    <>
      <p className="fmt-fine">{heldout.protocol}</p>
      <div className="fmt-table-wrap">
        <table className="fmt-table">
          <thead>
            <tr>
              <th scope="col">Decider</th>
              {EVENTS.map((e) => (
                <th scope="col" key={e}>
                  {e}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {heldout.table.map((row) => {
              const by: Partial<Record<string, Survival>> = row.byEvent;

              return (
                <tr key={row.decider}>
                  <th scope="row">{row.decider}</th>
                  {EVENTS.map((e) => {
                    const s = by[e];

                    return <td key={e}>{s ? `${percent(s.survival)} ± ${Math.round(s.survivalSd * 100)}` : "—"}</td>;
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="fmt-fine">
        Share of the event's fish that survived, mean ± standard deviation over {heldout.seeds} reefs the policy never
        trained on.
      </p>
    </>
  );
}

type Scene = { results?: ReactNode; method?: ReactNode; caveats: ReactNode[]; data: ReactNode };

const SCENES: Record<string, Scene> = {
  "screen-sentry": {
    results: <SentryResults />,
    method: <SentryMethod />,
    caveats: SENTRY_CAVEATS,
    data: <SentryData />,
  },
  "who-said-that": {
    results: <WhoResults />,
    method: <WhoMethod />,
    caveats: WHO_CAVEATS,
    data: <WhoData />,
  },
  spine: {
    results: <SpineResults />,
    method: <SpineMethod />,
    caveats: SPINE_CAVEATS,
    data: <SpineData />,
  },
  eyes: {
    method: (
      <>
        <p>
          Each lane B move is one prefill of an open vision-language model (Qwen3-VL, Apache-2.0, 4-bit, MLX-VLM on an
          Apple M4 Max) over a 320×320 screenshot and a fixed question, with thinking off. The logits of the four answer
          letters (A up, B right, C down, D left) at the answer position are softmaxed, as SGLang's /v1/decisions does;
          nothing is generated. The most probable direction becomes the move, turned into left, straight or right using
          the snake's heading; going back the way it came drives the head into its own neck.
        </p>
        <p>
          Lane A's greedy rule is code reading the true positions. Jev's games come from the arcade recording, text in,
          one choice per move. Jev is text-only: TypeSafe's model page says "No image, audio, or video input".
        </p>
        {Object.entries(PROMPTS).map(([k, q]) => (
          <pre key={k} className="fmt-prompt">
            {k}: {q}
          </pre>
        ))}
      </>
    ),
    caveats: [
      "Zero-shot, small, quantised models on a 10×10 board; a fine-tuned or larger model, or one served on a GPU, may do far better.",
      "One run per model and wording over 23 seeds; the clearer wording was tried once. Jev has 3 recorded games.",
      "Times are per move on one M4 Max, warm.",
    ],
    data: <p>{source("live-worlds/eyes")} holds the scorer, the recorder, the perception check and every recorded frame.</p>,
  },
  ocean: {
    results: <ReefResults />,
    method: (
      <p>
        Each small fish chooses its next action from what it can see. The default decider is a small network evolved on
        survival in this reef only, never on any model's answers. MobileBERT and Jev are alternatives; the race replays
        one recorded Jev run.
      </p>
    ),
    caveats: [
      "A short hand-written rule still beats the evolved policy on heatwaves, nets and oil spills.",
      "Held to 5 decisions a second, the policy keeps fewer fish alive in a heatwave than nobody deciding.",
      "The Jev comparison is one recorded run, not evidence that one model keeps fish alive better in general.",
    ],
    data: <p>{source("live-worlds/ocean")} holds the engine, the policy weights, the held-out table and the recorded Jev run.</p>,
  },
  "rumour-mill": {
    caveats: [
      "Bramble is a fictional town; it is not a model of real people.",
      "Residents who share a profile share one set of odds; the variety comes from each resident's own draw.",
      "The free model measures how close your text is to reference sentences, and a hand-set formula turns that into odds. It doesn't decide.",
      "Only the scam preset has a recorded Jev run.",
    ],
    data: <p>{source("live-worlds/rumour")} holds the town, the spread engine and the recorded Jev run.</p>,
  },
  "win-over": {
    caveats: [
      "Bramble mini learned from labels written by an open model, not from Jev; TypeSafe's terms forbid training on Jev's answers.",
      "The three-model comparison is seven recorded lines said to five residents: examples, not an accuracy test.",
      "Game balance hasn't been tested with real players.",
    ],
    data: (
      <p>
        {source("live-worlds/win-over")} holds the game and its recorded comparison; {source("live-worlds/free-model")} holds
        Bramble mini, its test sets and results.
      </p>
    ),
  },
  snake: {
    method: (
      <p>
        Both games replay recorded Jev moves beside a greedy rule. The agreement counts how often the greedy rule would
        have made Jev's move on the same state.
      </p>
    ),
    caveats: [
      "These are recordings; the boards don't call Jev.",
      "High agreement means Jev mostly made the greedy move. It doesn't show Jev planning further ahead.",
    ],
    data: <p>{source("local-models-and-games/arcade")} holds the game engines and the greedy rule.</p>,
  },
  games: {
    method: (
      <p>
        Each episode replays an agent's recorded moves. Steps answered from the cache, and the code baselines, made no
        request, so only steps where Jev was asked show a receipt.
      </p>
    ),
    caveats: ["Interrupted episodes are left out of playback and kept in the downloadable evidence."],
    data: <p>The downloadable evidence below has every episode, including unsuccessful attempts.</p>,
  },
  tetris: {
    caveats: [
      "Both play boards start on a code planner with an artificial delay; nothing on them is Jev until you switch a lane to live Jev on your key.",
      "The comparison tab replays Jev's recorded decisions.",
    ],
    data: <p>The downloadable evidence below has the recorded decisions behind the comparison.</p>,
  },
};

/** The drawer's tabs for a game page; `about` is the page's existing About material, or null when it has none. */
export function gameEvidence(id: string, about: ReactNode | null, download: ReactNode): EvidenceTab[] {
  const s = SCENES[id];
  const aboutTab: EvidenceTab[] = about === null ? [] : [{ id: "about", label: "About", content: about }];

  if (!s) return aboutTab;

  return [
    ...(s.results ? [{ id: "results", label: "Results", content: s.results }] : []),
    ...(s.method ? [{ id: "method", label: "Method", content: s.method }] : []),
    {
      id: "caveats",
      label: "Caveats",
      content: (
        <ul>
          {s.caveats.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      ),
    },
    {
      id: "data",
      label: "Data",
      content: (
        <>
          {s.data}
          {download}
        </>
      ),
    },
    ...aboutTab,
  ];
}
