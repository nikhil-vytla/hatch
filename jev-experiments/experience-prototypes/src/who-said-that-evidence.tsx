/**
 * Who said that?'s evidence for the shared drawer: how it decides, results, limits, and the data
 * and models with their licences. Moved here from the scene's own fold so the page has one
 * evidence entry point. Results come from results.json; scenario titles, source windows and
 * licences are read from the same published files the scene loads.
 */
import { useEffect, useState } from "react";
import results from "../../live-worlds/who-said-that/results.json";
import type { score, Truth } from "../../live-worlds/who-said-that/score";
import { fetchJson, percent } from "./api";
import { formatCost } from "./receipt";

type Scenario = { id: string; title: string };
type TruthDoc = { licence: string; source: { meeting: string; start: number; end: number; stream: string }[] };
type Lane = { counts: Truth["counts"]; truth: Truth["counts"]; online: ReturnType<typeof score>; revised: ReturnType<typeof score> };

// SAFETY: results.json is written by live-worlds/who-said-that/evaluate.ts as scenario → lane → scores.
const res = results as Record<string, Record<"free" | "jev", Lane>>;

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** The published scenario list, and each scenario's answer key once `withTruth` is set. */
function useScenarios(withTruth: boolean) {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [truths, setTruths] = useState<Record<string, TruthDoc>>({});

  useEffect(() => {
    let alive = true;

    fetchJson<Scenario[]>("/who-said-that/scenarios.json").then(
      async (list) => {
        if (!alive) return;

        setScenarios(list);

        if (!withTruth) return;

        const docs = await Promise.all(list.map((s) => fetchJson<TruthDoc>(`/who-said-that/${s.id}.truth.json`).catch(() => null)));

        if (alive) setTruths(Object.fromEntries(list.flatMap((s, i) => (docs[i] ? [[s.id, docs[i]]] : []))));
      },
      () => {},
    );

    return () => {
      alive = false;
    };
  }, [withTruth]);

  return { scenarios, truths };
}

export function WhoMethod() {
  return (
    <>
      <p>
        <b>Step one, signals (code and small models).</b> Speech is found where the level rises 6 dB above the recording's quiet
        floor, cut into stretches of at most 5 s. Each stretch is transcribed by whisper-tiny.en, fingerprinted by Wespeaker's
        CAM++ voice model and embedded for meaning by all-MiniLM-L6-v2. With a phone on each table, a frame only counts for a
        phone when it is more than 3 dB louder than the other table's leak and the room's noise would make it. The leak is measured
        from the recording, so a table's own words still count under louder talk at the other table.
      </p>
      <p>
        <b>Step two, three text questions per line</b>, none of which depends on how anything has been grouped, so a recorded
        answer stays valid whatever you toggle: does it continue the last line (yes/no)? which of the last six lines does it reply
        to, if any (choice)? does it start a new topic (yes/no)? The free rules answer from word cues, timing and meaning
        similarity; Jev answers from the words alone.
      </p>
      <p>
        <b>Step three, three typed decisions per line</b>: which speaker (one so far, or someone new), which conversation (one so
        far, or a new one), and a new topic or not. Each option's score is the sum of the signal pushes shown in the “why” panel,
        then a softmax. Code keeps the voice prints, levels, phones, topics and counts. A speaker counts once they have two
        lines, a conversation at three, a topic at two. Hindsight re-labels earlier lines against the final voice prints and
        conversation topics. With a phone on each table, the phone decides the conversation, and it can rule a speaker out (they
        sit at the other table) but never in, since everyone at a table is on its phone.
      </p>
      <p>
        The weights were set by hand on seven development windows (other stretches of the same meetings), then frozen before these
        three scenarios were scored. The changes that were tried and rejected are listed in the folder README. Nothing was trained, and no Jev answer was used to set anything: Jev's answers are only shown and
        scored.
      </p>
    </>
  );
}

export function WhoResults() {
  const { scenarios } = useScenarios(false);

  return (
    <>
      <p className="fmt-fine">All signals on.</p>
      <div className="fmt-table-wrap">
        <table className="fmt-table">
          <thead>
            <tr>
              <th scope="col">Scenario</th>
              <th scope="col">Text answers</th>
              <th scope="col">Speakers · conv. · topics (corpus)</th>
              <th scope="col">Speaker</th>
              <th scope="col">Conversation</th>
              <th scope="col">Topic</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(res).flatMap(([id, r]) =>
              (["free", "jev"] as const).map((l) =>
                r[l] ? (
                  <tr key={`${id}-${l}`}>
                    <td>{scenarios.find((s) => s.id === id)?.title ?? id}</td>
                    <td>{l === "free" ? "Free rules" : "Jev, recorded"}</td>
                    <td>
                      {r[l].counts.speakers} · {r[l].counts.conversations} · {r[l].counts.topics} ({r[l].truth.speakers} · {r[l].truth.conversations} · {r[l].truth.topics})
                    </td>
                    <td>
                      {percent(r[l].online.speaker.share)} <small>/ {percent(r[l].revised.speaker.share)}</small>
                    </td>
                    <td>
                      {percent(r[l].online.conversation.share)} <small>/ {percent(r[l].revised.conversation.share)}</small>
                    </td>
                    <td>{percent(r[l].online.topic.share)}</td>
                  </tr>
                ) : null,
              ),
            )}
          </tbody>
        </table>
      </div>
      <p className="fmt-fine">
        Share of the corpus's words whose label matches, after matching labels one to one; as decided / with hindsight. Words never
        heard as speech count as wrong. Jev's recorded answers cost {formatCost(0.00549)} for 200 requests at list price (93 of them
        re-asked the same questions about re-recorded two-tables lines).
      </p>
      <p className="fmt-fine">
        Before the accuracy work, two tables scored speaker 46% and conversation 83%, with 2 of 5 speakers found and 64 of 382
        words never heard (now 10). The free rules in the design meeting scored conversation 88% and topic 58%. They invented a
        second conversation, whose split happened to fall on a topic change, so topic is now 54%.
      </p>
    </>
  );
}

export const WHO_CAVEATS: string[] = [
  "whisper-tiny mishears overlapping and far-off speech, and every text answer inherits that.",
  "Topics are undercounted, and the limit is the meaning signal: on the development windows, only about 70% of lines are closer to their own topic than to another, even when the true topics are given.",
  "A stretch of up to 5 s often holds two or three speakers in fast talk, and all of it gets one label.",
  "With two tables, the leak is measured as one level for the room. In this mix it is exactly one level (−12 dB); a real room's leak varies, so expect more lost or stray words. Stretches heard under louder talk at the other table have its words mixed into their text.",
  "Overlapping speech within one table is not detected: the one suitable open model, pyannote's segmentation, is gated.",
  "On these scenarios Jev's text answers help most in the single meeting, where it counts all four speakers; on two tables, voice and phone decide nearly everything, so it changes little.",
  "Asked once about a whole transcript, Jev's conversation and topic counts are poor; the counts here come from code.",
];

/** The data and models, with each scenario's source windows, licence and downloads. */
export function WhoData() {
  const { scenarios, truths } = useScenarios(true);

  return (
    <>
      <p>
        Audio, words, speakers and topics: the{" "}
        <a href="https://groups.inf.ed.ac.uk/ami/corpus/" target="_blank" rel="noreferrer">
          AMI Meeting Corpus
        </a>{" "}
        (University of Edinburgh and partners),{" "}
        <a href="https://groups.inf.ed.ac.uk/ami/corpus/license.shtml" target="_blank" rel="noreferrer">
          CC BY 4.0
        </a>
        .
      </p>
      <ul>
        {scenarios.map((s) => {
          const t = truths[s.id];

          return (
            <li key={s.id}>
              <b>{s.title}</b>
              {t && (
                <>
                  : {t.source.map((x) => `${x.meeting} ${mmss(x.start)}–${mmss(x.end)} (${x.stream})`).join(" + ")}. {t.licence}
                </>
              )}{" "}
              <a href={`/who-said-that/${s.id}.signals.json`} download>
                Signals
              </a>{" "}
              ·{" "}
              <a href={`/who-said-that/${s.id}.truth.json`} download>
                Answer key
              </a>
              {res[s.id]?.jev && (
                <>
                  {" "}
                  ·{" "}
                  <a href={`/who-said-that/${s.id}.jev.json`} download>
                    Jev's recorded answers
                  </a>
                </>
              )}
            </li>
          );
        })}
      </ul>
      <p>
        Models: whisper-tiny.en (MIT), all-MiniLM-L6-v2 (Apache-2.0), Wespeaker CAM++ trained on VoxCeleb (Apache-2.0), all run
        on your device. Jev is TypeSafe's decision model.
      </p>
    </>
  );
}
