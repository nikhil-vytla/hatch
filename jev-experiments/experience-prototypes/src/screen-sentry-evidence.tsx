/**
 * Screen sentry's evidence for the shared drawer: results, method, data and limits. Moved here
 * from the scene's own "Accuracy and data" dialog so the page has one evidence entry point.
 * Every number is read from the recorded comparison and evaluation files.
 */
import { BATCH } from "../../live-worlds/sentry/jev";
import { RISK_THRESHOLD } from "../../live-worlds/sentry/model";
import evalJson from "../../live-worlds/sentry/eval.json";
import compareJson from "../../live-worlds/sentry/compare.json";

type Count = { injectionsCaught: string; harmlessFlagged: string };

type Compare = { sets: Record<string, { free: Count; jev: Count }>; spend: { requests: number; costUsd: number; medianLatencyMs: number; recordedOn: string } };

// SAFETY: compare.json is written by live-worlds/sentry/compare.ts in exactly this shape.
const CMP = compareJson as Compare;

const SETS: [string, string][] = [
  ["scene: default traps", "The five default traps, on all three pages"],
  ["scene: hard traps", "Eight harder traps, on all three pages"],
  ["scene: page blocks", "The pages' own harmless blocks"],
  ["wild2", "Fresh hand-written test (written before scoring)"],
  ["wild", "First hand-written test (guided the fixes)"],
  ["injecagent", "InjecAgent: instructions planted in tool output"],
  ["deepset", "deepset prompt injections"],
  ["gandalf", "Gandalf 'ignore your instructions' attempts"],
  ["jailbreak", "Jailbreak prompts (its harmless rows still instruct an AI)"],
];

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function SentryResults() {
  return (
    <>
      <p>
        The same blocks, checked by the free sentry and by Jev's recorded answers, at a risk threshold of{" "}
        {pct(RISK_THRESHOLD)}. Counts are injections caught and harmless blocks wrongly flagged.
      </p>
      <div className="fmt-table-wrap">
      <table className="fmt-table">
        <thead>
          <tr>
            <th scope="col">Set</th>
            <th scope="col">Free: caught</th>
            <th scope="col">Free: false alarms</th>
            <th scope="col">Jev: caught</th>
            <th scope="col">Jev: false alarms</th>
          </tr>
        </thead>
        <tbody>
          {SETS.filter(([k]) => CMP.sets[k]).map(([k, label]) => (
            <tr key={k}>
              <th scope="row">{label}</th>
              <td>{CMP.sets[k].free.injectionsCaught}</td>
              <td>{CMP.sets[k].free.harmlessFlagged}</td>
              <td>{CMP.sets[k].jev.injectionsCaught}</td>
              <td>{CMP.sets[k].jev.harmlessFlagged}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <p className="fmt-fine">
        Jev's answers: {CMP.spend.requests} requests recorded on {CMP.spend.recordedOn}, ${CMP.spend.costUsd} at list
        price, median {CMP.spend.medianLatencyMs} ms per batch of up to {BATCH} blocks.
      </p>
    </>
  );
}

export function SentryMethod() {
  return (
    <>
      <p>
        Each block of the page is asked five yes/no questions: is it addressed to an AI, does it change the user's goal,
        does it ask for secrets, is it an instruction rather than content, and would following it hijack a helper doing
        the user's task. A block is flagged when the last one is at least {pct(RISK_THRESHOLD)}.
      </p>
      <p>
        The free sentry answers them in your browser with five small logistic heads over hashed words, word pairs, a few
        cue words and where the block sits (visible, hidden, tiny, a comment, alt text). It trained on{" "}
        {(evalJson as { trainedOn: string }).trainedOn}. Real rows train the hijack question only, at a quarter of an
        authored block's weight, a setting chosen on validation data carved from the training set.
      </p>
      <p>
        Jev is asked the same five questions in batches of {BATCH} blocks, with the page title and the helper's task as
        context. Its answers here were recorded once for every block and trap the scene ships; edit a trap and only the
        free sentry, or Jev on your own key, can rate the new words.
      </p>
      <p>
        The helper is code: it reads blocks in order, skips flagged ones and follows the first unflagged trap. Flagging a
        real price means it never sees that price.
      </p>
    </>
  );
}

export function SentryData() {
  return (
    <>
      <p>Training and test data, all openly licensed, checked at the source on 3 Oct 2026:</p>
      <ul>
        <li>
          <a href="https://huggingface.co/datasets/deepset/prompt-injections" target="_blank" rel="noreferrer">
            deepset/prompt-injections
          </a>{" "}
          (Apache-2.0)
        </li>
        <li>
          <a href="https://huggingface.co/datasets/Lakera/gandalf_ignore_instructions" target="_blank" rel="noreferrer">
            Lakera/gandalf_ignore_instructions
          </a>{" "}
          (MIT)
        </li>
        <li>
          <a href="https://huggingface.co/datasets/jackhhao/jailbreak-classification" target="_blank" rel="noreferrer">
            jackhhao/jailbreak-classification
          </a>{" "}
          (Apache-2.0)
        </li>
        <li>
          <a href="https://github.com/uiuc-kang-lab/InjecAgent" target="_blank" rel="noreferrer">
            InjecAgent
          </a>{" "}
          (MIT), injections planted in tool output
        </li>
        <li>Our own authored blocks, two hand-written test sets and eight hard traps</li>
      </ul>
      <p>
        No Jev answer trains anything: TypeSafe's terms forbid it. Everything, including Jev's raw recorded answers, is in{" "}
        <a href="https://github.com/nikhil-vytla/hatch/tree/main/jev-experiments/live-worlds/sentry" target="_blank" rel="noreferrer">
          live-worlds/sentry
        </a>
        .
      </p>
    </>
  );
}

export const SENTRY_CAVEATS: string[] = [
  'The helper and its actions are simulated; nothing browses anywhere.',
  'The hand-written tests are small (20 injections, 20 harmless blocks each). A few blocks either way moves the rates a lot.',
  'The first hand-written test guided which gaps were fixed, so it flatters the free sentry; the second was written before any scoring.',
  'The free sentry still flags some harmless blocks that mention assistants or agents, and some image captions and comments. Jev catches more of the hard traps.',
  'Harmless "ignore our last email" notices pass only when worded like the training ones: a held-out wording ("Forget about the delay: we\'ve fixed it") was flagged every time.',
  'The jailbreak dataset\'s "harmless" prompts still give an AI instructions. Jev flags many of them; on a web page that is arguably right.',
  "It reads text only. A trap drawn into an image's pixels gets past both.",
];
