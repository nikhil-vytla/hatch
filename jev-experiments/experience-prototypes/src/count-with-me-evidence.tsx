/**
 * Count with me's evidence for the shared drawer: results by count bin with 95% intervals, the
 * method and prompts, caveats, and the data with its licences. Numbers come from count.json, the
 * file the scene loads.
 */
import { useEffect, useState } from "react";
import type { CountData } from "../../live-worlds/count/build";
import { fetchJson, percent } from "./api";
import { formatCost } from "./receipt";

function useCount() {
  const [data, setData] = useState<CountData | null>(null);

  useEffect(() => {
    let alive = true;

    fetchJson<CountData>("/count/count.json").then(
      (d) => alive && setData(d),
      () => {},
    );

    return () => {
      alive = false;
    };
  }, []);

  return data;
}

const ci = (c: [number, number], f: (x: number) => string) => (Number.isNaN(c[0]) ? "" : ` (${f(c[0])}–${f(c[1])})`);
const one = (x: number) => x.toFixed(1);

export function CountResults() {
  const d = useCount();

  if (!d) return <p className="fmt-fine">Loading the results…</p>;

  return (
    <>
      <div className="fmt-table-wrap">
        <table className="fmt-table">
          <thead>
            <tr>
              <th scope="col">Decider</th>
              <th scope="col">Right count bin</th>
              <th scope="col">Within one bin</th>
              <th scope="col">Mean error (objects)</th>
              <th scope="col">"More than N?" right</th>
              <th scope="col">"Even?" right</th>
              <th scope="col">Median time</th>
            </tr>
          </thead>
          <tbody>
            {d.lanes.map((l) => (
              <tr key={l.id}>
                <th scope="row">{l.label}</th>
                <td>
                  {percent(l.exactBin.mean)}
                  {ci(l.exactBin.ci, percent)}
                </td>
                <td>{percent(l.withinOne.mean)}</td>
                <td>
                  {one(l.absError.mean)}
                  {ci(l.absError.ci, one)}
                </td>
                <td>{percent(l.ladder.mean)}</td>
                <td>
                  {percent(l.even.mean)}
                  {ci(l.even.ci, percent)}
                </td>
                <td>{l.medianMs === null ? "—" : `${Math.round(l.medianMs)} ms`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="fmt-fine">
        {d.items.length} images; 95% percentile bootstrap intervals over images (10,000 draws). The vision model's time is six prefills, one per question; Jev's is one
        request with six questions.
      </p>
      <div className="fmt-table-wrap">
        <table className="fmt-table">
          <thead>
            <tr>
              <th scope="col">True count</th>
              <th scope="col">Images</th>
              {d.lanes.map((l) => (
                <th scope="col" key={l.id}>
                  {l.label}: right bin · mean error
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {d.bins.map((b, i) => (
              <tr key={b}>
                <th scope="row">{b}</th>
                <td>{d.lanes[0].byBin[i].n}</td>
                {d.lanes.map((l) => {
                  const r = l.byBin[i];

                  return (
                    <td key={l.id}>
                      {percent(r.exactBin)}
                      {ci(r.exactBinCi, percent)} · {one(r.absError)}
                      {ci(r.absErrorCi, one)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="fmt-fine">About a dozen images per bin, so each bin's interval is wide. Mean error uses the middle of the chosen bin for the vision model and Jev.</p>
      <div className="fmt-table-wrap">
        <table className="fmt-table">
          <thead>
            <tr>
              <th scope="col">Crowding</th>
              {d.lanes.map((l) => (
                <th scope="col" key={l.id}>
                  {l.label}: right bin · mean error
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {d.lanes[0].crowding.map((c, i) => (
              <tr key={c.id}>
                <th scope="row">
                  {c.label} ({c.n})
                </th>
                {d.lanes.map((l) => (
                  <td key={l.id}>
                    {percent(l.crowding[i].exactBin.mean)} · {one(l.crowding[i].absError.mean)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="fmt-fine">Crowding is the share of an image's true boxes that overlap another box. Packed images also tend to hold more objects, so the two effects are tangled.</p>
    </>
  );
}

export function CountMethod() {
  const d = useCount();

  return (
    <>
      <p>
        Recent benchmarks of spatial competence (<a href="https://arxiv.org/abs/2604.09594">arXiv 2604.09594</a>) and of visual blind spots (Blind-Spots-Bench,{" "}
        <a href="https://arxiv.org/abs/2607.08317">arXiv 2607.08317</a>) find frontier models miscount crowds. This page checks the same thing on a small, open set where every
        answer is known.
      </p>
      <p>
        <b>Truth.</b> Each image is from the COCO 2017 validation set, and its count is the number of COCO instance outlines for one category. An image only qualifies if that
        category has no "crowd" region (one outline for many objects, so some were never counted) and every outline is at least {d?.minArea ?? 100} pixels. COCO never outlines
        20 or more of one category one by one, so the two largest bins are labelled composites: four real photos in a 2×2 grid, whose truth is the sum of the four.
      </p>
      <p>
        <b>Vision model.</b> Qwen3-VL-4B-Instruct (Apache-2.0, 4-bit, MLX-VLM on an Apple M4 Max, thinking off) sees the full-size image. Each question is one prefill; the
        logits of the answer labels (letters A–I for the count bins, Yes or No otherwise) at the answer position are softmaxed, as SGLang's decisions endpoint does. Nothing is
        generated.
      </p>
      <p>
        <b>Detector.</b> DETR ResNet-50 (Apache-2.0, via transformers.js) finds objects in the same image. Its count is its boxes of that category at {percent(d?.detectorThreshold ?? 0.7)} confidence
        or more. DETR was trained on COCO's training split; these images are from the validation split, which it never saw.
      </p>
      <p>
        <b>Jev on the boxes.</b> Jev is text-only, so it never sees the photo. Its request lists the detector's boxes at {percent(d?.factsThreshold ?? 0.3)} confidence or more, each
        with its confidence and position, and asks the same six questions: a choice of count bin, "more than N?" for N = {d?.thresholds.join(", ") ?? "2, 5, 10, 20"}, and "is the
        count even?". Jev decides which boxes to believe.{" "}
        {d?.jev && (
          <>
            {d.jev.requests} requests, {d.jev.inputTokens.toLocaleString()} input tokens, {formatCost(d.jev.costUsd)} at the list price ({d.jev.price}).
          </>
        )}
      </p>
      {d?.prompts.map((p) => (
        <pre key={p.key} className="fmt-prompt">
          {p.key}: {p.question}
        </pre>
      ))}
    </>
  );
}

export const COUNT_CAVEATS = [
  "About a dozen images per count bin and one run per decider, so the bin-level results have wide intervals.",
  "The two largest bins are 2×2 composites of COCO photos, not single crowded scenes. They test counting across a busy image, not one dense crowd.",
  "COCO's outlines are the truth. Annotators sometimes miss small or far objects, so a decider can be marked wrong for counting one COCO missed.",
  "The vision model and Jev answer in count bins, not exact numbers; their mean error uses the middle of the chosen bin, so it is approximate.",
  "Jev only knows what the detector reports. When the detector misses objects, Jev can't count them; when it doubles them, Jev has to judge from the confidences and positions.",
  "Qwen3-VL-4B is a small, quantised, zero-shot model; larger frontier models count better, though the papers above find they still miss crowds.",
  "Times are on one M4 Max, warm; Jev's are round trips to TypeSafe.",
];

export function CountDataNote() {
  const d = useCount();
  const nc = d?.items.filter((it) => it.credit.some((c) => c.noncommercial)).length;

  return (
    <>
      <p>
        <a href="https://github.com/nikhil-vytla/hatch/tree/main/jev-experiments/live-worlds/count" target="_blank" rel="noreferrer">
          live-worlds/count
        </a>{" "}
        holds the image list with every truth box, the selection script, the recorders and every recorded answer.
      </p>
      <p>
        Images: <a href="https://cocodataset.org">COCO 2017</a> validation set. Annotations CC BY 4.0 (the COCO Consortium). Each photo keeps its Flickr licence, credited
        under it on the page with a link to the original: Creative Commons BY, BY-SA, BY-NC or BY-NC-SA, or no known copyright restrictions. No-derivatives licences are left
        out, since the page shows resized photos and grids.{nc ? ` ${nc} of the ${d?.items.length} images include a non-commercial photo; this site is non-commercial.` : ""}
      </p>
    </>
  );
}
