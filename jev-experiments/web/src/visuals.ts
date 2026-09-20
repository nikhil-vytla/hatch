import { documents, menu } from "./recipes";
import { predict } from "./local-classifier";
export const esc = (x: unknown) =>
  String(x ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const pretty = (x: unknown) => esc(String(x ?? "").replaceAll("_", " "));
export const pct = (x: unknown) =>
  typeof x === "number" ? `${(100 * x).toFixed(1)}%` : "—";
export function bars(probabilities: Record<string, number>, selected?: string) {
  return `<div class="bars">${Object.entries(probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(
      ([k, p]) =>
        `<div><div class="bar-label"><span>${pretty(k)}</span><span class="mono">${pct(p)}</span></div><div class="bar-track"><div class="bar-fill ${k === selected ? "accent" : ""}" style="width:${Math.max(0, Math.min(100, p * 100))}%"></div></div></div>`,
    )
    .join("")}</div>`;
}
export function probabilities(row: any) {
  const answers =
    row?.answers ??
    (row?.probabilities
      ? {
          decision: { probabilities: row.probabilities, value: row.prediction },
        }
      : {});
  return (
    Object.entries(answers)
      .slice(0, 8)
      .map(
        ([name, a]: any) =>
          `<div class="probability-group"><h4>${pretty(name)} · ${pretty(a.value)}</h4>${a.probabilities ? bars(a.probabilities, a.value) : bars({ yes: Number(a.value), no: 1 - Number(a.value) })}</div>`,
      )
      .join("") ||
    '<p class="fine">No answer distribution is attached to this record.</p>'
  );
}
export function chart(
  series: { label: string; points: [number, number][] }[],
  yLabel = "Accuracy",
  maxY = 1,
) {
  const pts = series
    .flatMap((s) => s.points)
    .filter((p) => p.every(Number.isFinite));
  if (!pts.length) return '<p class="fine">No measured points yet.</p>';
  const colors = ["#476d59", "#cf7959", "#776495", "#48899c"];
  const maxX = Math.max(1, ...pts.map((p) => p[0])),
    width = 560,
    height = 270;
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(yLabel)} over measured steps"><text x="45" y="16">${esc(yLabel)}</text>${[0, 0.25, 0.5, 0.75, 1].map((y) => `<line x1="45" x2="542" y1="${230 - y * 190}" y2="${230 - y * 190}"/><text x="8" y="${234 - y * 190}">${(y * maxY).toFixed(maxY > 5 ? 0 : 2)}</text>`).join("")}${[0, 0.25, 0.5, 0.75, 1].map((x) => `<text x="${45 + x * 497}" y="252" text-anchor="middle">${Math.round(x * maxX)}</text>`).join("")}${series
    .map(
      (s, i) =>
        `<polyline class="series" style="stroke:${colors[i % colors.length]}" points="${s.points
          .filter((p) => p.every(Number.isFinite))
          .map(([x, y]) => `${45 + (x / maxX) * 497},${230 - (y / maxY) * 190}`)
          .join(" ")}"/>`,
    )
    .join(
      "",
    )}</svg><div class="chart-legend">${series.map((s, i) => `<span><i style="background:${colors[i % colors.length]}"></i>${esc(s.label)}</span>`).join("")}</div>`;
}
export function table(rows: any[], keys?: string[]) {
  if (!rows?.length) return '<p class="fine">No completed records.</p>';
  keys =
    keys ??
    Object.keys(rows[0])
      .filter((k) => typeof rows[0][k] !== "object")
      .slice(0, 6);
  return `<div class="data-table-wrap"><table class="data-table"><thead><tr>${keys.map((k) => `<th>${pretty(k)}</th>`).join("")}</tr></thead><tbody>${rows
    .slice(0, 40)
    .map(
      (r) =>
        `<tr>${keys!.map((k) => `<td>${typeof r[k] === "number" ? Number(r[k].toFixed(3)) : typeof r[k] === "object" ? esc(JSON.stringify(r[k])) : esc(r[k] ?? "—")}</td>`).join("")}</tr>`,
    )
    .join("")}</tbody></table></div>`;
}
export function glyph(kind: string, large = false) {
  const ink = "#7c927e",
    accent = "#d98162",
    light = "#c7d1bf";
  let shapes = "";
  if (kind === "pixels" || kind === "game")
    shapes = Array.from(
      { length: 64 },
      (_, i) =>
        `<rect x="${100 + (i % 8) * 15}" y="${10 + Math.floor(i / 8) * 15}" width="13" height="13" rx="1" fill="${(i * 17 + (i % 7)) % 13 < 6 ? ink : i % 9 === 0 ? accent : light}"/>`,
    ).join("");
  else if (kind === "world" || kind === "eye")
    shapes = `<circle cx="160" cy="70" r="59" fill="#d9dfcc"/><circle cx="181" cy="43" r="19" fill="#e6bc83"/><path d="M80 108Q116 38 157 97Q195 53 241 108Z" fill="${ink}"/><path d="M69 119Q123 75 183 112Q214 76 250 119" fill="${light}"/><circle cx="108" cy="38" r="3" fill="${accent}"/><circle cx="227" cy="55" r="2" fill="${accent}"/>`;
  else if (kind === "logo")
    shapes = `<g fill="none" stroke="${ink}" stroke-width="12"><circle cx="142" cy="71" r="40"/><circle cx="184" cy="71" r="40"/></g><circle cx="163" cy="71" r="12" fill="${accent}"/>`;
  else if (kind === "music")
    shapes = Array.from(
      { length: 8 },
      (_, i) =>
        `<rect x="${65 + i * 24}" y="${[72, 53, 62, 33, 43, 62, 83, 72][i]}" width="20" height="10" rx="3" fill="${i === 7 ? accent : ink}"/><line x1="${65 + i * 24}" x2="${65 + i * 24}" y1="15" y2="125" stroke="#d5dbce" stroke-width=".5"/>`,
    ).join("");
  else if (kind === "drink")
    shapes = `<path d="M125 42h73l-9 76h-55Z" fill="${light}" stroke="${ink}" stroke-width="3"/><path d="M198 55h12q19 30-16 31" fill="none" stroke="${ink}" stroke-width="5"/><path d="M147 31q-10-12 0-22M168 31q-10-12 0-22" fill="none" stroke="${accent}" stroke-width="3"/>`;
  else if (kind === "ui" || kind === "text" || kind === "code")
    shapes = `<rect x="70" y="20" width="180" height="104" rx="4" fill="#f9faf5" stroke="${ink}"/><path d="M70 41h180" stroke="${ink}"/><circle cx="81" cy="31" r="2" fill="${accent}"/>${Array.from({ length: 3 }, (_, i) => `<rect x="${81 + i * 56}" y="54" width="46" height="55" rx="2" fill="${i === 1 ? light : "#e8ede0"}"/><path d="M${87 + i * 56} 91h33M${87 + i * 56} 99h21" stroke="${ink}"/>`).join("")}`;
  else if (kind === "curve" || kind === "bars" || kind === "dots")
    shapes = `<path d="M70 20v104h188" fill="none" stroke="${light}"/>${kind === "bars" ? Array.from({ length: 6 }, (_, i) => `<rect x="${82 + i * 27}" y="${105 - i * 12}" width="17" height="${18 + i * 12}" rx="2" fill="${i === 5 ? accent : ink}"/>`).join("") : `<path d="M80 107C120 109 120 81 151 87S190 44 244 28" fill="none" stroke="${ink}" stroke-width="4"/><path d="M80 111C120 90 160 112 183 83S220 92 244 58" fill="none" stroke="${accent}" stroke-width="3"/>`}`;
  else
    shapes = `<rect x="64" y="51" width="53" height="40" rx="4" fill="${light}"/><path d="M117 71h33M164 71h36M225 71h32" stroke="${ink}" stroke-width="2"/><circle cx="162" cy="71" r="24" fill="${ink}"/><rect x="210" y="20" width="48" height="32" rx="4" fill="${light}"/><rect x="210" y="94" width="48" height="32" rx="4" fill="${accent}"/><path d="M185 65l25-25M185 78l25 32" stroke="${ink}" stroke-width="2"/>`;
  return `<svg viewBox="0 0 320 145" ${large ? "" : 'aria-hidden="true"'}>${shapes}</svg>`;
}
function logoSVG(spec: any) {
  const color =
    (
      {
        teal: "#3d796f",
        coral: "#cb684e",
        violet: "#776495",
        ink: "#303c38",
      } as any
    )[spec.palette] ?? "#3d796f";
  const width = ({ light: 3, medium: 6, bold: 11 } as any)[spec.weight] ?? 6;
  const path =
    (
      {
        circle: "M50 12a38 38 0 1 0 0 76a38 38 0 1 0 0-76",
        leaf: "M15 82Q10 15 86 14Q90 83 15 82ZM17 80L73 27",
        star: "M50 8L60 37L91 38L66 57L74 89L50 70L25 89L33 57L9 38L40 37Z",
        wave: "M9 36Q29 12 50 36T91 36M9 56Q29 32 50 56T91 56M9 76Q29 52 50 76T91 76",
        mountain: "M9 84L43 20L64 57L75 38L95 84Z",
      } as any
    )[spec.symbol] ?? "";
  const unit = (transform: string) =>
    `<path d="${path}" transform="${transform}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const shapes =
    spec.structure === "paired"
      ? unit("translate(9 47) scale(.85)") + unit("translate(95 47) scale(.85)")
      : spec.structure === "nested"
        ? unit("translate(20 20) scale(1.6)") +
          unit("translate(62 62) scale(.76)")
        : spec.structure === "orbit"
          ? unit("translate(40 40) scale(1.2)") +
            `<circle cx="100" cy="100" r="88" fill="none" stroke="${color}" stroke-width="2"/><circle cx="172" cy="48" r="9" fill="${color}"/>`
          : unit("translate(20 20) scale(1.6)");
  return `<svg viewBox="0 0 200 200" role="img" aria-label="${esc(spec.symbol)} logo">${shapes}</svg>`;
}
function mockUI(row: any) {
  const fields: string[] = row.fields?.length
    ? row.fields
    : ["name", "description"];
  const values: Record<string, string[]> = {
    name: ["Studio", "Collective", "Atelier"],
    price: ["$12", "$24", "$48"],
    owner: ["Alex", "Sam", "Riley"],
    status: ["In progress", "Ready", "Planned"],
    date: ["June 12", "July 18", "August 22"],
    deadline: ["Friday", "Next week", "Monday"],
    features: ["Core tools", "Shared projects", "Everything"],
    description: ["A place to begin", "Room for a team", "Made to grow"],
    email: ["hello@example.com", "team@example.com", "hi@example.com"],
  };
  const val = (f: string, i: number) => values[f]?.[i] ?? ["20", "40", "60"][i];
  const cards = Array.from(
    { length: 3 },
    (_, i) =>
      `<article class="mock-card">${fields.includes("image") ? '<div class="mock-image"></div>' : ""}${fields
        .filter((f) => f !== "image")
        .map(
          (f) =>
            `<div class="mock-field"><span>${pretty(f)}</span><b ${f === row.emphasis ? 'style="color:#b95d3f"' : ""}>${esc(val(f, i))}</b></div>`,
        )
        .join("")}</article>`,
  ).join("");
  let content =
    row.layout === "table"
      ? `<div class="data-table-wrap"><table class="mock-table"><thead><tr>${fields.map((f) => `<th>${pretty(f)}</th>`).join("")}</tr></thead><tbody>${Array.from({ length: 3 }, (_, i) => `<tr>${fields.map((f) => `<td>${esc(val(f, i))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
      : row.layout === "form"
        ? `<form class="mock-form" id="mock-form">${fields
            .filter((f) => f !== "image")
            .map(
              (f) =>
                `<label>${pretty(f)}<input aria-label="${esc(f)}" ${f === "email" ? 'type="email"' : ""} placeholder="Your ${esc(f)}" required/></label>`,
            )
            .join(
              "",
            )}<button class="primary">Continue</button><p id="mock-feedback" class="fine"></p></form>`
        : `<div class="${row.layout === "timeline" ? "timeline" : "mock-grid"}">${cards}</div>`;
  return `<div class="generated-ui" style="padding:${row.density === "spacious" ? 18 : row.density === "compact" ? 0 : 8}px"><h3>${pretty(row.layout)} / preview</h3>${content}<p class="fine">Sample content. Layout and field choices come from the recorded judgment.</p></div>`;
}
function drink(row: any, journey = false) {
  const name = row.prediction ?? row.answers?.drink?.value,
    facts = (menu as any)[name];
  if (journey && row.answers?.clarify?.value >= 0.5)
    return `<div class="journey"><span class="step done">1</span><span class="connector"></span><span class="step">?</span></div><h3>One more detail</h3><p class="fine">The request needs clarification before we can suggest a drink. Describe the temperature, caffeine, milk, and sweetness you want.</p><form id="clarify-drink" class="mock-form"><label for="drink-detail">Your preferences</label><input id="drink-detail" placeholder="Cold, no caffeine, no dairy, a little sweet" required/><button class="primary">Update request</button></form><p class="fine">The updated request goes through Jev again. This demo does not place orders.</p>`;
  return `${journey ? '<div class="journey"><span class="step done">1</span><span class="connector"></span><span class="step done">2</span><span class="connector"></span><span class="step" id="confirm-step">3</span></div>' : ""}<div class="drink">${glyph("drink")}</div><h3 class="drink-name">${pretty(name)}</h3><div class="pill-row">${
    facts
      ? Object.entries(facts)
          .map(
            ([k, v]) =>
              `<span class="pill">${typeof v === "boolean" ? (v ? "with " : "no ") : ""}${pretty(typeof v === "boolean" ? k : v)}</span>`,
          )
          .join("")
      : ""
  }</div><p class="fine" style="text-align:center">${row.answers?.clarify?.value >= 0.5 ? "Jev asks for clarification before proceeding." : "A suggested match from the fictional menu."}</p>${journey ? '<button class="primary" id="confirm-drink">Confirm demo choice</button><p class="fine" id="drink-confirmation">This flow does not place an order.</p>' : ""}`;
}
export function visualization(id: string, row: any, result: any): string {
  if (id === "adapters")
    return `<div class="adapter-flow"><span>Typed schema</span><span>→</span><span>Questions</span><span>→</span><span>Validated values + evidence</span></div><div class="code-tabs">${["Python", "TypeScript", "Rust", "Go"].map((s, i) => `<button class="${i === 0 ? "active" : ""}" data-code="${s}">${s}</button>`).join("")}</div><pre id="adapter-code"></pre><p class="fine">Required finite enums, booleans, and probabilities. Unsupported free text fails before a request is sent.</p>${result.rows ? table(result.rows, ["language", "value", "evidence_preserved"]) : ""}`;
  if (id === "replica" && result?.curve)
    return `<div class="flow"><div class="flow-box">Shared document</div><span class="flow-arrow">→</span><div class="flow-box">Isolated questions<br><small>reused positions</small></div><span class="flow-arrow">→</span><div class="flow-box">Pointer decisions</div></div>${chart([{ label: "Training loss", points: result.curve.map((r: any) => [r.step, r.loss]) }], "Loss", Math.max(1.5, ...result.curve.map((r: any) => r.loss)))}${result.after ? table(Object.keys(result.after).map((k) => ({ type: k, before: pct(result.before[k].accuracy), after: pct(result.after[k].accuracy) }))) : ""}`;
  if (id === "reward" && result?.curve)
    return (
      chart([
        {
          label: "Oracle test accuracy",
          points: result.curve.map((r: any) => [
            r.step,
            r.oracle_test_accuracy,
          ]),
        },
        {
          label: "Mean Jev reward",
          points: result.curve.map((r: any) => [r.step, r.mean_teacher_reward]),
        },
      ]) + localClassifierForm()
    );
  if (id === "teach" && result?.methods)
    return (
      chart(
        Object.entries(result.methods).map(([k, v]: any) => ({
          label: k,
          points: v.curve
            .filter((r: any) => r.accuracy !== null)
            .map((r: any) => [r.attempted_labels, r.accuracy]),
        })),
      ) + localClassifierForm()
    );
  if (id === "classify" && result?.experiments)
    return Object.entries(result.experiments)
      .map(
        ([k, v]: any) =>
          `<h3 class="subheading">${esc(k)}</h3>${bars({ "Jev · all attempted": v.jev.accuracy_all_attempted, "Jev · answered": v.jev.accuracy_answered ?? 0, "TF-IDF + logistic": v.tfidf_logistic.accuracy_all_attempted })}<p class="fine">${v.jev.answered}/${v.jev.attempted} answered. Paired 95% interval: ${v.paired_difference.interval_95.map((x: number) => pct(x)).join(" to ")}.</p><br>`,
      )
      .join("");
  if (id === "latency" && result?.groups)
    return (
      chart(
        [1, 8, 32, 128].map((n) => ({
          label: `${n} questions`,
          points: result.groups
            .filter((g: any) => g.questions === n && g.p50_ms != null)
            .map((g: any) => [g.state_words, g.p50_ms]),
        })),
        "Median latency, ms",
        Math.max(1, ...result.groups.map((g: any) => g.p50_ms ?? 0)),
      ) +
      table(
        result.groups.map((g: any) => ({
          ...g,
          failed: g.attempted - g.answered,
        })),
        ["state_words", "questions", "p50_ms", "p95_ms", "answered", "failed"],
      )
    );
  if (id === "robustness" && result?.variants)
    return bars(
      Object.fromEntries(
        Object.entries(result.variants).map(([k, v]: any) => [
          k,
          v.accuracy_all_attempted ?? 0,
        ]),
      ),
    );
  if (id === "optimize" && result) {
    const methods = result.methods ?? {};
    return (
      table(
        Array.isArray(methods)
          ? methods
          : Object.entries(methods).map(([k, v]: any) => ({
              method: k,
              validation: pct(v.validation_accuracy),
              held_out: pct(v.test?.accuracy_all_attempted),
              answered: v.test ? `${v.test.answered}/${v.test.attempted}` : "—",
              evaluation_cases: v.metric_calls ?? 0,
            })),
      ) +
      `<p class="fine">Frozen prompts and detailed search traces appear in the downloadable record.</p>`
    );
  }
  if (!row || row.error)
    return `<div class="empty"><strong>${row?.error ? "This call did not complete." : "Ready for an experiment."}</strong><span>${esc(row?.error ?? "Choose a recorded run when available, or try a live input. No result is being simulated.")}</span></div>`;
  if (id === "worlds" && row.scene)
    return '<div class="scene-host" id="scene-host"></div>';
  if (id === "pixels" && row.answers)
    return `<div class="pixel-grid">${Array.from({ length: 64 }, (_, i) => {
      const key = `p${i % 8}_${Math.floor(i / 8)}`,
        a = row.answers[key];
      return `<button aria-label="Pixel ${(i % 8) + 1}, ${Math.floor(i / 8) + 1}: ${esc(a?.value)}" data-pixel="${key}" style="background:${({ ink: "#192c3b", teal: "#438b81", coral: "#de8265", cream: "#f3e9c5" } as any)[a?.value] ?? "#ddd"}"></button>`;
    }).join(
      "",
    )}</div><div class="pixel-evidence" id="pixel-evidence"><p class="fine">Select a pixel to inspect its color probabilities.</p></div>`;
  if (id === "logos" && row.spec)
    return `<div class="logo-board">${logoSVG(row.spec)}</div><p class="logo-caption">${pretty(row.spec.symbol)} · ${pretty(row.spec.structure)} · ${pretty(row.spec.weight)}</p>`;
  if (id === "ui" && row.layout) return mockUI(row);
  if ((id === "beverage" || id === "journeys") && row.prediction)
    return drink(row, id === "journeys");
  if (id === "music" && row.notes) {
    const total = row.notes.reduce((s: number, n: any) => s + n.beats, 0);
    let at = 0;
    return `<div class="piano" role="img" aria-label="Eight-note piano roll">${row.notes
      .map((n: any) => {
        const left = (at / total) * 100;
        at += n.beats;
        return `<div class="note-block" style="left:${left}%;width:${(n.beats / total) * 100 - 0.6}%;bottom:${((n.midi - 58) / 16) * 100}%" title="MIDI ${n.midi}, ${n.beats} beats"></div>`;
      })
      .join(
        "",
      )}</div><div class="play-row"><button class="secondary" id="play-music">Play melody ▷</button><button class="secondary" id="download-midi">Save MIDI ↓</button><span class="mono">${row.bpm} BPM</span></div><p id="audio-status" class="fine">Jev chooses musical symbols; a local synthesizer makes the sound.</p>`;
  }
  if (id === "decisions" && row.assessments)
    return `<div id="decision-ranking"></div><div style="margin-top:24px">${["usefulness", "novelty", "ease", "shareability"].map((k) => `<label class="weight-row"><span>${k}</span><input type="range" min="0" max="5" value="1" data-weight="${k}" aria-label="${k} weight"/><span id="weight-${k}">1</span></label>`).join("")}</div><p class="fine">Weights change code-calculated utility immediately. The underlying Jev assessments stay fixed.</p>`;
  if (id === "routing" || id === "verify")
    return `<div class="flow"><div class="flow-box">${id === "routing" ? "User request" : "Task + trace"}</div><span class="flow-arrow">→</span><div class="flow-box">Jev</div><span class="flow-arrow">→</span><div class="flow-box">${id === "routing" ? "Handler" : "Verdict"}</div></div><div class="route-result">${pretty(row.prediction)}</div>${row.probabilities ? bars(row.probabilities, row.prediction) : ""}`;
  if (id === "search" || id === "context")
    return `<div class="flow"><div class="flow-box">${row.input_characters} characters</div><span class="flow-arrow">→</span><div class="flow-box">${row.kept_characters} retained</div></div>${documents.map((d) => `<div class="document ${(row.kept ?? []).some((x: any) => x.id === d.id) ? "" : "excluded"}"><strong>${esc(d.title)} · ${(row.kept ?? []).some((x: any) => x.id === d.id) ? "kept" : "filtered"}</strong><p>${esc(d.text)}</p></div>`).join("")}`;
  if (id === "micro")
    return `<div class="flow"><div class="flow-box">Route</div><span class="flow-arrow">→</span><div class="flow-box">${pretty(row.route)}</div><span class="flow-arrow">→</span><div class="flow-box">Verify</div></div><div class="document"><strong>${esc(row.goal)}</strong><p>${esc(row.answer)}</p></div>${row.verification ? probabilities({ answers: row.verification }) : ""}`;
  if (id === "games")
    return (
      '<div id="game-board"></div><div class="game-controls"><span>Step</span><input id="game-step" type="range" min="0" max="' +
      Math.max(0, (row.trace?.length ?? 1) - 1) +
      '" value="0" aria-label="Replay step"/><span id="game-number">1</span></div>'
    );
  if (id === "vision")
    return `${row.image ? `<img class="vision-image" src="${esc(row.image)}" alt="Local input image"/>` : ""}<div class="document"><strong>Local vision description</strong><p>${esc(row.description)}</p></div><div class="flow"><div class="flow-box">Pixels</div><span class="flow-arrow">→</span><div class="flow-box">Local caption</div><span class="flow-arrow">→</span><div class="flow-box">${pretty(row.answers?.action?.value)}</div></div>`;
  if (id === "language")
    return (
      (row.candidates ?? [])
        .map(
          (t: string, i: number) =>
            `<details class="candidate ${i === row.selected ? "selected" : ""}" ${i === row.selected ? "open" : ""}><summary class="mono">Candidate ${i + 1}${i === row.selected ? " · selected by Jev" : ""}${row.checks ? ` · IFEval ${row.checks[i]?.strict ? "pass" : "fail"}` : ""}</summary>${esc(t)}</details>`,
        )
        .join("") +
        (row.reference?.text
          ? `<details class="candidate"><summary class="mono">Reference · ${esc(row.reference.model ?? result.reference_model ?? "writer")}${row.reference_check ? ` · IFEval ${row.reference_check.strict ? "pass" : "fail"}` : ""}</summary>${esc(row.reference.text)}</details>`
          : "") || table(result?.rows ?? [])
    );
  if (id === "judge")
    return `<div class="route-result">${esc(row.prediction)} <span class="fine">/ expected ${esc(row.target)}</span></div>${probabilities(row)}<p class="fine">JudgeBench source: ${esc(row.source)}. Candidate text is available from the pinned upstream dataset.</p>`;
  return table([row]);
}
function localClassifierForm() {
  return '<form class="mock-form" id="local-classifier"><label for="local-input">Try the trained model, entirely in this browser</label><input id="local-input" value="I want a hot drink with caffeine, with dairy milk, not sweet." required/><button class="primary">Classify locally</button><div id="local-prediction" style="margin-top:18px"></div><p class="fine">This model always chooses from the fictional menu. Its probabilities are not a calibrated correctness guarantee.</p></form>';
}
const snippets: Record<string, string> = {
  Python: `class Ticket(BaseModel):\n    area: Literal["billing", "technical", "account", "other"] = Field(description="Which support area applies?")\n    refund: bool = Field(description="Is a refund requested?")\n    missing_context: float = Field(ge=0, le=1,\n        description="Is essential context missing?")\n\nquestions = questions_for(Ticket)\nresult = await client.evaluate(text, questions)\nvalue = decode(Ticket, result["answers"])`,
  TypeScript: `const Ticket = z.object({\n  area: z.enum(["billing", "technical", "account", "other"])\n    .describe("Which support area applies?"),\n  refund: z.boolean().describe("Is a refund requested?"),\n  missing_context: z.number().min(0).max(1)\n    .describe("Is essential context missing?"),\n});\nconst result = await decide(Ticket, text, transport);\n// result.value is validated; result.answers retains evidence.`,
  Rust: `#[derive(Serialize, Deserialize, JsonSchema)]\nstruct Ticket {\n    /// Which support area applies?\n    area: Area,\n    /// Is a refund requested?\n    refund: bool,\n    /// Is essential context missing?\n    #[schemars(range(min = 0, max = 1))]\n    missing_context: f64,\n}\nlet questions = compile(&schema_for!(Ticket).to_value())?;\nlet decision: Decision<Ticket> = decode(&schema, answers)?;`,
  Go: `type Ticket struct {\n  Area string \x60json:"area" jsonschema:"enum=billing,enum=technical,enum=account,enum=other,description=Which support area applies?"\x60\n  Refund bool \x60json:"refund" jsonschema:"description=Is a refund requested?"\x60\n  MissingContext float64 \x60json:"missing_context" jsonschema:"minimum=0,maximum=1,description=Is essential context missing?"\x60\n}\nquestions, err := Compile(jsonschema.Reflect(&Ticket{}))\nresult, err := Decode[Ticket](schema, answers)`,
};
export function download(
  name: string,
  value: string | Uint8Array,
  type = "application/json",
) {
  const blob = new Blob([value as BlobPart], { type }),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function midi(row: any) {
  const vlq = (n: number) => {
    let a = [n & 127];
    while ((n >>= 7)) a.unshift((n & 127) | 128);
    return a;
  };
  const track: number[] = [
    0,
    255,
    81,
    3,
    ...[16, 8, 0].map((s) => (Math.round(60000000 / row.bpm) >> s) & 255),
  ];
  row.notes.forEach((n: any) =>
    track.push(
      0,
      144,
      n.midi,
      85,
      ...vlq(Math.round(n.beats * 96)),
      128,
      n.midi,
      0,
    ),
  );
  track.push(0, 255, 47, 0);
  return new Uint8Array([
    77,
    84,
    104,
    100,
    0,
    0,
    0,
    6,
    0,
    0,
    0,
    1,
    0,
    96,
    77,
    84,
    114,
    107,
    ...[24, 16, 8, 0].map((s) => (track.length >> s) & 255),
    ...track,
  ]);
}
export async function bindVisual(
  id: string,
  row: any,
  result: any,
): Promise<() => void> {
  let cleanup = () => {};
  const localForm =
    document.querySelector<HTMLFormElement>("#local-classifier");
  if (localForm) {
    const model =
      id === "reward" ? result.model : result.methods?.random?.model;
    localForm.onsubmit = (e) => {
      e.preventDefault();
      const target = document.querySelector("#local-prediction")!;
      target.innerHTML = model
        ? bars(
            predict(
              model,
              document.querySelector<HTMLInputElement>("#local-input")!.value,
            ),
          )
        : "No trained model is available for this run.";
    };
  }
  if (id === "adapters") {
    const set = (name: string) => {
      document.querySelector("#adapter-code")!.textContent = snippets[name];
      document
        .querySelectorAll<HTMLButtonElement>("[data-code]")
        .forEach((b) => b.classList.toggle("active", b.dataset.code === name));
    };
    document
      .querySelectorAll<HTMLButtonElement>("[data-code]")
      .forEach((b) => (b.onclick = () => set(b.dataset.code!)));
    set("Python");
  }
  if (!row || row.error) return cleanup;
  if (id === "worlds" && row.scene) {
    const host = document.querySelector<HTMLElement>("#scene-host");
    if (!host) return cleanup;
    const { default: p5 } = await import("p5");
    if (!host.isConnected) return cleanup;
    const scene = row.scene,
      palette = row.palette;
    const sketch = new p5((p) => {
      p.setup = () => {
        p.createCanvas(620, 395);
        p.randomSeed(42);
        p.frameRate(30);
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) p.noLoop();
      };
      p.draw = () => {
        p.background(palette[0]);
        const t = p.frameCount * 0.015,
          count =
            ({ sparse: 20, balanced: 40, dense: 75 } as any)[scene.density] ??
            40;
        p.noStroke();
        p.fill(palette[1]);
        if (scene.terrain === "hills" || scene.terrain === "waves") {
          for (let layer = 0; layer < 3; layer++) {
            p.fill(palette[layer + 1] + "80");
            p.beginShape();
            p.vertex(0, 395);
            for (let x = 0; x <= 640; x += 10)
              p.vertex(
                x,
                260 +
                  layer * 33 +
                  Math.sin(
                    x * 0.012 +
                      layer +
                      t * (scene.terrain === "waves" ? 0.4 : 0),
                  ) *
                    32,
              );
            p.vertex(640, 395);
            p.endShape(p.CLOSE);
          }
        }
        if (scene.terrain === "buildings") {
          for (let x = 0; x < 620; x += 45)
            p.rect(x, 190 + ((x * 7) % 110), 35, 220);
        }
        for (let i = 0; i < count; i++) {
          let x = (i * 97 + 31) % 620,
            y = (i * 73 + 19) % 320;
          const phase = t + i;
          if (scene.motion === "drift") {
            x = (x + t * ((i % 4) + 3)) % 620;
            y += Math.sin(phase * 0.7) * 13;
          }
          if (scene.motion === "orbit") {
            x = 310 + Math.cos(phase * 0.3) * (60 + i * 3);
            y = 197 + Math.sin(phase * 0.3) * (35 + i * 1.5);
          }
          if (scene.motion === "bounce")
            y = 25 + Math.abs(Math.sin(phase * 0.5)) * 300;
          let size = 8 + (i % 5) * 3;
          if (scene.motion === "pulse") size *= 1 + Math.sin(phase) * 0.3;
          if (scene.motion === "grow")
            size *= 0.7 + 0.3 * Math.sin(phase * 0.25);
          p.push();
          p.translate(x, y);
          p.rotate(Math.sin(phase * 0.2) * 0.3);
          p.fill(palette[2 + (i % 2)]);
          const shape = scene["shape" + (i % 4)];
          if (shape === "triangle")
            p.triangle(0, -size, -size, size, size, size);
          else if (shape === "line") {
            p.stroke(palette[2 + (i % 2)]);
            p.strokeWeight(2);
            p.line(-size, 0, size, 0);
          } else if (shape === "leaf") p.ellipse(0, 0, size, size * 2);
          else if (shape === "star") {
            p.beginShape();
            for (let k = 0; k < 10; k++) {
              const a = (k * Math.PI) / 5,
                r = k % 2 ? size * 0.4 : size;
              p.vertex(Math.cos(a) * r, Math.sin(a) * r);
            }
            p.endShape(p.CLOSE);
          } else p.circle(0, 0, size);
          p.pop();
        }
      };
    }, host);
    cleanup = () => sketch.remove();
  }
  document.querySelectorAll<HTMLButtonElement>("[data-pixel]").forEach(
    (b) =>
      (b.onclick = () => {
        const a = row.answers[b.dataset.pixel!];
        document.querySelector("#pixel-evidence")!.innerHTML =
          `<h3 class="subheading">${esc(b.getAttribute("aria-label"))}</h3>${bars(a.probabilities ?? {}, a.value)}`;
      }),
  );
  const form = document.querySelector<HTMLFormElement>("#mock-form");
  if (form)
    form.onsubmit = (e) => {
      e.preventDefault();
      document.querySelector("#mock-feedback")!.textContent =
        "Demo complete. Your entries stayed in this browser.";
    };
  const confirm = document.querySelector<HTMLButtonElement>("#confirm-drink");
  const clarify = document.querySelector<HTMLFormElement>("#clarify-drink");
  if (clarify)
    clarify.onsubmit = (e) => {
      e.preventDefault();
      const prompt = document.querySelector<HTMLTextAreaElement>("#prompt")!;
      prompt.value = `${row.text ?? row.brief ?? ""}\nClarification: ${document.querySelector<HTMLInputElement>("#drink-detail")!.value}`;
      document.querySelector<HTMLButtonElement>("#run-live")?.click();
    };
  if (confirm)
    confirm.onclick = () => {
      document.querySelector("#confirm-step")?.classList.add("done");
      document.querySelector("#drink-confirmation")!.textContent =
        "Choice confirmed in this demo. No purchase was made.";
      confirm.disabled = true;
      confirm.textContent = "Confirmed";
    };
  if (id === "decisions" && row.assessments) {
    const rank = () => {
      const inputs = [
          ...document.querySelectorAll<HTMLInputElement>("[data-weight]"),
        ],
        sum = inputs.reduce((s, e) => s + Number(e.value), 0);
      inputs.forEach(
        (e) =>
          (document.querySelector("#weight-" + e.dataset.weight)!.textContent =
            e.value),
      );
      const ranking = row.assessments
        .map((a: any) => ({
          ...a,
          utility: inputs.reduce(
            (s, e) =>
              s +
              ((sum ? Number(e.value) / sum : 0.25) *
                a.scores[e.dataset.weight!]) /
                2,
            0,
          ),
        }))
        .sort((a: any, b: any) => b.utility - a.utility);
      document.querySelector("#decision-ranking")!.innerHTML = ranking
        .map(
          (a: any, i: number) =>
            `<div class="ranked"><b>${i + 1}</b><strong>${esc(a.name)}</strong><span>${pct(a.utility)}</span></div>`,
        )
        .join("");
    };
    document
      .querySelectorAll<HTMLInputElement>("[data-weight]")
      .forEach((e) => (e.oninput = rank));
    rank();
  }
  if (id === "music" && row.notes) {
    let audio: AudioContext | undefined;
    const btn = document.querySelector<HTMLButtonElement>("#play-music")!;
    btn.onclick = async () => {
      if (audio) {
        await audio.close();
        audio = undefined;
        btn.textContent = "Play melody ▷";
        return;
      }
      audio = new AudioContext();
      await audio.resume();
      let start = audio.currentTime + 0.04;
      const playing = audio;
      row.notes.forEach((n: any, index: number) => {
        const osc = audio!.createOscillator(),
          gain = audio!.createGain(),
          duration = (n.beats * 60) / row.bpm;
        osc.type =
          row.voice === "soft_square" ? "square" : (row.voice ?? "sine");
        osc.frequency.value = 440 * 2 ** ((n.midi - 69) / 12);
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.07, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + duration * 0.94);
        osc.connect(gain).connect(audio!.destination);
        osc.start(start);
        osc.stop(start + duration);
        if (index === row.notes.length - 1)
          osc.onended = () => {
            if (audio === playing) {
              void playing.close();
              audio = undefined;
              btn.textContent = "Play melody ▷";
            }
          };
        start += duration;
      });
      btn.textContent = "Stop playback □";
      document.querySelector("#audio-status")!.textContent =
        "Playing locally through Web Audio.";
    };
    document.querySelector<HTMLButtonElement>("#download-midi")!.onclick = () =>
      download("jev-eight-notes.mid", midi(row), "audio/midi");
    cleanup = () => {
      if (audio) void audio.close();
    };
  }
  if (id === "games" && row.trace) {
    const slider = document.querySelector<HTMLInputElement>("#game-step")!;
    const show = () => {
      const frame = row.trace[Number(slider.value)],
        grid = (frame.state ?? result.observations?.[frame.state_id])?.visible_grid;
      document.querySelector("#game-number")!.textContent =
        `${Number(slider.value) + 1}/${row.trace.length}`;
      document.querySelector("#game-board")!.innerHTML = grid
        ? `<div class="game-grid" style="grid-template-columns:repeat(${grid[0].length},1fr)">${grid.flatMap((line: string[], y: number) => line.map((cell, x) => `<div class="cell ${y === grid.length - 1 && x === Math.floor(line.length / 2) ? "agent" : cell.includes("door") ? "door" : cell.includes("key") ? "key" : esc(cell)}" title="${esc(cell)}">${y === grid.length - 1 && x === Math.floor(line.length / 2) ? "↑" : cell.includes("key") ? "⚿" : cell === "goal" ? "◎" : ""}</div>`)).join("")}</div><p class="fine" style="text-align:center">${pretty(frame.action)} · ${frame.cache_hit ? "cached decision" : `${Number(frame.latency_ms ?? 0).toFixed(0)} ms`}</p>`
        : `<p class="error-text">${esc(frame.error ?? "No observation")}</p>`;
    };
    slider.oninput = show;
    show();
  }
  return cleanup;
}
