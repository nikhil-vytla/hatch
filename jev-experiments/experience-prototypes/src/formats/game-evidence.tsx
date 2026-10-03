/**
 * What each game and simulation page keeps in its evidence drawer. Play stays on the page; the
 * drawer holds results that aren't already shown there, the caveats, and where the data lives.
 * Numbers are read from the scene's records, never typed in.
 */
import type { ReactNode } from "react";
import heldout from "../../../live-worlds/ocean/heldout.json";
import { percent } from "../api";
import type { EvidenceTab } from "./evidence-drawer";

/** Pages that use the game format: play first, evidence in a drawer. */
export const GAME_PAGES = new Set(["ocean", "rumour-mill", "win-over", "snake", "games", "tetris"]);

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

/** The drawer's tabs for a game page; `about` is the page's existing About material. */
export function gameEvidence(id: string, about: ReactNode, download: ReactNode): EvidenceTab[] {
  const s = SCENES[id];

  if (!s) return [{ id: "about", label: "About", content: about }];

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
    { id: "about", label: "About", content: about },
  ];
}
