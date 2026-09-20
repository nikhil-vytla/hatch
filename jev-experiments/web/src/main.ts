import "./style.css";
import {
  experiments,
  categories,
  ideaGarden,
  type Experiment,
} from "./catalog";
import { defaults, recipe, artifact } from "./recipes";
import {
  esc,
  pretty,
  pct,
  glyph,
  visualization,
  bindVisual,
  probabilities,
  download,
  table,
} from "./visuals";

type RecordData = Record<string, any>;
const app = document.querySelector<HTMLDivElement>("#app")!;
let index: RecordData = { experiments: {}, budget: {} },
  activeCategory = "All experiments",
  query = "",
  generation = 0,
  dispose = () => {};
let request: AbortController | undefined, worker: Worker | undefined;
const cache = new Map<string, RecordData>();
const brand = `<a class="brand" href="#" aria-label="Jev laboratory home"><span class="brand-mark">${"<i></i>".repeat(9)}</span>jev <small>field notes / 001</small></a>`;
function shell(content: string) {
  app.innerHTML = `<header>${brand}<nav><a href="#" class="nav-research">Experiments</a><a href="#ideas">Next ideas ↗</a><span class="live-indicator"><i></i>AN OPEN LABORATORY</span></nav></header><main>${content}<footer class="footer"><span>Built with small judgments and a fair amount of curiosity.<br>Independent experiments. Not affiliated with TypeSafe.<br><a href="/research/README.md" download>Research report ↓</a> · <a href="/research/SOURCES.md" download>Sources ↓</a> · <a href="/research/IDEA_GARDEN.md" download>20 next experiments ↓</a> · <a href="/results/history.json" download>Run history ↓</a></span><span><a href="https://docs.typesafe.ai/introduction" target="_blank" rel="noreferrer">TypeSafe docs ↗</a> &nbsp; <a href="https://github.com/jaredpalmer/kev" target="_blank" rel="noreferrer">Kev ↗</a> &nbsp; <a href="https://github.com/aaazzam/jev" target="_blank" rel="noreferrer">aaazzam/jev ↗</a></span></footer></main>`;
}
function status(exp: Experiment) {
  const record = index.experiments[exp.data];
  return record
    ? {
        label: record.status === "partial" ? "Partial run" : "Recorded",
        pending: false,
      }
    : { label: exp.live ? "Live experiment" : "Awaiting run", pending: true };
}
function cards() {
  const matches = experiments.filter(
    (e) =>
      (activeCategory === "All experiments" || e.category === activeCategory) &&
      `${e.title} ${e.description} ${e.category}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const grid = document.querySelector("#experiment-grid")!;
  grid.innerHTML =
    matches
      .map((e) => {
        const s = status(e);
        return `<a class="card" href="#experiment/${e.id}"><div class="card-art">${glyph(e.glyph)}</div><div class="card-body"><div class="card-top"><span>${e.category} / ${String(experiments.indexOf(e) + 1).padStart(2, "0")}</span><span class="status ${s.pending ? "pending" : ""}"><i></i>${s.label}</span></div><h3>${esc(e.title)}</h3><p>${esc(e.description)}</p><div class="card-footer"><span>${e.live ? "Replay + live input" : "Measured experiment"}</span><b>↗</b></div></div></a>`;
      })
      .join("") ||
    '<p class="no-results">No experiments match this search.</p>';
  document.querySelector("#result-count")!.textContent =
    `${matches.length} experiments`;
}
function home() {
  const completed = experiments.filter((e) => index.experiments[e.data]).length,
    budget = index.budget ?? {},
    reported = (budget.models ?? []).reduce(
      (s: number, m: any) => s + (m.reported_usd ?? 0),
      0,
    );
  shell(
    `<section class="hero"><div><div class="eyebrow"><span class="dot"></span>A FIELD GUIDE TO ABUNDANT INTELLIGENCE</div><h1>A thousand<br>small decisions.</h1><p>What happens when judgment becomes fast, cheap, and everywhere? A working collection of experiments with Jev, local models, and a little imagination.</p><a class="text-link" href="#experiment/worlds">Enter the laboratory <span>↗</span></a></div><div class="hero-art">${heroArt()}<div class="art-label"><span>INPUT → MANY QUESTIONS → POSSIBILITIES</span><span>FIG. 001</span></div></div></section><section class="stats-strip" aria-label="Laboratory statistics"><div class="strip-item"><strong>${experiments.length}</strong><span>experiments to explore</span></div><div class="strip-item"><strong>${completed}</strong><span>with recorded evidence</span></div><div class="strip-item"><strong>${Number(budget.attempts ?? 0).toLocaleString()}</strong><span>recorded API attempts</span></div><div class="strip-item"><strong>$${reported.toFixed(2)}</strong><span>reported API charges*</span></div></section><section id="experiments"><div class="section-top"><h2>The experiments</h2><span class="mono" id="result-count"></span></div><div class="filters">${categories.map((c) => `<button class="filter ${c === activeCategory ? "active" : ""}" data-category="${c}">${c}</button>`).join("")}<label class="visually-hidden" for="search">Search experiments</label><input class="search" id="search" type="search" placeholder="Search the laboratory…" value="${esc(query)}"/></div><div class="grid" id="experiment-grid"></div><p class="fine">* Reported charges exclude attempts without cost metadata. Conservative budget accounting: $${Number(budget.accounted_usd ?? 0).toFixed(3)} of $${budget.limit_usd ?? 25}. Recorded runs include gateway failures. Gallery illustrations are diagrams, not measured outputs.</p></section><section class="garden" id="ideas"><div class="garden-intro"><h2>Still on the drawing board.</h2><p>The interesting part is what happens between models. These are directions to investigate next, not results we have already established.</p></div><div class="ideas">${ideaGarden.map(([title, body], i) => `<article class="idea"><span class="mono">${String(i + 1).padStart(2, "0")}</span><div><h3>${title}</h3><p>${body}</p></div></article>`).join("")}</div></section>`,
  );
  cards();
  document.querySelectorAll<HTMLButtonElement>("[data-category]").forEach(
    (b) =>
      (b.onclick = () => {
        activeCategory = b.dataset.category!;
        document
          .querySelectorAll("[data-category]")
          .forEach((x) =>
            x.classList.toggle(
              "active",
              (x as HTMLElement).dataset.category === activeCategory,
            ),
          );
        cards();
      }),
  );
  document.querySelector<HTMLInputElement>("#search")!.oninput = (e) => {
    query = (e.target as HTMLInputElement).value;
    cards();
  };
  if (location.hash === "#ideas")
    document.querySelector("#ideas")?.scrollIntoView({ behavior: "smooth" });
}
function heroArt() {
  return `<svg viewBox="0 0 500 300" role="img" aria-label="A diagram of one input becoming many independent decisions"><defs><pattern id="dots" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".7" fill="#bfc6b7"/></pattern></defs><rect width="500" height="300" fill="url(#dots)"/><g fill="none" stroke="#b5c1ac" stroke-width="1">${Array.from({ length: 7 }, (_, i) => `<path d="M91 149C164 149 167 ${45 + i * 31} 228 ${45 + i * 31}H297"/>`).join("")}</g><rect x="52" y="119" width="61" height="61" rx="7" fill="#344c40"/><path d="M71 139h23M71 147h17M71 155h20M71 163h12" stroke="#e3eadb" stroke-width="2"/>${Array.from({ length: 7 }, (_, i) => `<rect x="226" y="${34 + i * 31}" width="22" height="22" rx="3" fill="${i === 3 ? "#d67d5b" : "#b5c7ab"}"/>`).join("")}<g transform="translate(311 87)"><rect width="116" height="116" rx="4" fill="#d7ddca"/>${Array.from({ length: 36 }, (_, i) => `<rect x="${8 + (i % 6) * 17}" y="${8 + Math.floor(i / 6) * 17}" width="14" height="14" rx="1" fill="${[9, 14, 15, 16, 20, 21, 22, 27].includes(i) ? "#cf7959" : i % 7 === 0 ? "#728c73" : "#bccbaa"}"/>`).join("")}</g><text x="48" y="222" font-family="monospace" font-size="9" fill="#737e6c">ONE STATE</text><text x="190" y="281" font-family="monospace" font-size="9" fill="#737e6c">INDEPENDENT JUDGMENTS</text><text x="328" y="222" font-family="monospace" font-size="9" fill="#737e6c">SOMETHING NEW</text></svg>`;
}
function records(exp: Experiment, result: RecordData): any[] {
  if (exp.id === "beverage" || exp.id === "journeys")
    return [...(result.rows ?? []), ...(result.ambiguous ?? [])];
  if (exp.id === "worlds") return result.scenes ?? [];
  if (exp.id === "pixels") return result.pixels ?? [];
  if (exp.id === "games") return result.episodes ?? [];
  if (exp.id === "classify") return result.experiments?.banking77?.rows ?? [];
  if (
    exp.id === "replica" ||
    exp.id === "reward" ||
    exp.id === "teach" ||
    exp.id === "optimize" ||
    exp.id === "latency" ||
    exp.id === "robustness"
  )
    return [];
  return result.rows ?? [];
}
function rowName(row: any, i: number) {
  return (
    (
      row.brief ??
      row.text ??
      row.query ??
      row.goal ??
      row.prompt ??
      row.language ??
      (row.env
        ? `${row.env} / ${row.policy} / seed ${row.seed}`
        : (row.id ?? `Case ${i + 1}`))
    )
      .toString()
      .slice(0, 100) + (row.error ? " · failed" : "")
  );
}
function metricCards(exp: Experiment, result: RecordData, row: any) {
  let values: [string, string][] = [];
  const m = result.metrics;
  if (exp.id === "language" && result.summary)
    values = [
      [
        "IFEval first candidate",
        pct(result.summary.baseline_strict_all_attempted),
      ],
      ["Jev selected", pct(result.summary.jev_selected_strict_all_attempted)],
      ["Best of four oracle", pct(result.summary.best_of_four_oracle_strict)],
      [
        "Reference model",
        result.summary.reference_answered
          ? pct(result.summary.reference_strict_all_attempted)
          : "Unavailable",
      ],
    ];
  if (m)
    values = [
      ["All attempted", pct(m.accuracy_all_attempted)],
      ["Answered accuracy", pct(m.accuracy_answered)],
      ["Answered / attempted", `${m.answered}/${m.attempted}`],
      ["Gateway failures", String(m.failed)],
    ];
  if (exp.id === "ui")
    values = [
      ["Layout targets", pct(result.layout_accuracy)],
      ["Revision stability", pct(result.revision_stability)],
    ];
  if (exp.id === "replica" && result.after)
    values = [
      ["Choice before", pct(result.before.choice.accuracy)],
      ["Choice after", pct(result.after.choice.accuracy)],
      ["Training updates", String(result.training_steps)],
      [
        "Trainable weights",
        Number(result.trainable_parameters).toLocaleString(),
      ],
    ];
  if (exp.id === "reward" && result.curve)
    values = [
      ["Actual weight updates", String(result.curve.at(-1).step)],
      ["Oracle accuracy", pct(result.curve.at(-1).oracle_test_accuracy)],
      ["Training examples", String(result.train_size)],
      ["Test examples", String(result.test_size)],
    ];
  if (exp.id === "teach" && result.methods)
    values = [
      ["Unique teacher labels", String(result.unique_teacher_labels)],
      ["Independent test set", String(result.test_size)],
      ...Object.entries(result.methods).map(
        ([k, v]: any) => [k, pct(v.curve.at(-1)?.accuracy)] as [string, string],
      ),
    ];
  if (exp.id === "games" && row)
    values = [
      ["Policy", row.policy ?? "—"],
      ["Reached goal", row.success ? "Yes" : "No"],
      ["Steps", String(row.steps ?? 0)],
      ["Errors", String(row.errors ?? 0)],
    ];
  if (!values.length && row)
    values = [
      [
        "Call latency",
        row.latency_ms ? `${Math.round(row.latency_ms)} ms` : "—",
      ],
      ["Questions", String(Object.keys(row.answers ?? {}).length)],
      ["Run type", row.source === "live" ? "Live" : "Recorded"],
    ];
  return values.length
    ? `<div class="metric-grid">${values.map(([label, value]) => `<div class="metric"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`).join("")}</div>`
    : "";
}
async function detail(exp: Experiment, version: number) {
  shell(
    `<a class="back" href="#">← All experiments</a><div class="detail-heading"><div><div class="eyebrow">${exp.category} / EXPERIMENT ${String(experiments.indexOf(exp) + 1).padStart(2, "0")}</div><h1>${exp.title}</h1><p>${exp.description}</p></div><span class="badge" id="run-badge">Loading record</span></div><div id="detail-body"><div class="empty loading">Opening the notebook…</div></div>`,
  );
  let saved = cache.get(exp.data);
  if (!saved && index.experiments[exp.data]) {
    try {
      const response = await fetch(`/results/${exp.data}.json`);
      if (!response.ok) throw Error("Record unavailable");
      saved = await response.json();
      cache.set(exp.data, saved!);
    } catch (error) {
      saved = { result: { error: String(error) } };
    }
  }
  if (version !== generation) return;
  const result = saved?.result ?? {},
    rows = records(exp, result);
  let selected = Math.max(
      0,
      rows.findIndex((r) => !r.error),
    ),
    row = rows[selected];
  const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
  document.querySelector("#run-badge")!.textContent = saved
    ? `${saved.manifest?.status ?? "record"} · ${saved.manifest?.config?.quick ? "integration pilot" : "recorded run"}`
    : "Live experiment available";
  document.querySelector("#detail-body")!.innerHTML =
    `<div class="workspace"><section class="stage"><div class="stage-bar"><span id="stage-mode">${row ? "RECORDED OUTPUT" : "EXPERIMENT VIEW"}</span><span id="stage-count">${rows.length ? `${selected + 1} / ${rows.length}` : "JEV LAB"}</span></div><div class="stage-content ${exp.id === "worlds" ? "flush" : ""}" id="stage"></div><div class="benchmark-note" id="row-caption"></div></section><aside class="controls">${rows.length ? `<section class="panel"><label for="record-select">RECORDED INPUT</label><select id="record-select">${rows.map((r, i) => `<option value="${i}" ${i === selected ? "selected" : ""}>${esc(rowName(r, i))}</option>`).join("")}</select><p>${rows.filter((r) => r.error).length} failed records remain visible in this selector.</p></section>` : ""}${exp.live ? `<section class="panel"><h3>Try an idea</h3><label for="prompt">${exp.id === "vision" ? "TASK FOR THE IMAGE" : "YOUR INPUT"}</label><textarea id="prompt" maxlength="12000">${esc(row?.brief ?? row?.text ?? row?.query ?? row?.prompt ?? defaults[exp.live] ?? "")}</textarea>${exp.id === "vision" ? '<label for="vision-file" style="margin-top:14px">IMAGE · PROCESSED LOCALLY</label><input class="file-input" type="file" id="vision-file" accept="image/png,image/jpeg,image/webp"/>' : ""}${!isLocal ? '<details class="raw"><summary>Unlock live calls</summary><label for="access-token" style="margin-top:14px">PRIVATE LAB TOKEN</label><input id="access-token" type="password" autocomplete="off" placeholder="Kept only for this browser session"/></details>' : ""}<button class="primary" id="run-live">${exp.id === "language" ? "Load local writer + run" : exp.id === "vision" ? "Load local vision + run" : "Run with Jev"} <span>↗</span></button><button class="secondary" id="cancel-run" hidden style="margin-top:9px;width:100%">Cancel</button><div id="run-status" class="run-status" role="status" aria-live="polite"></div><p>${["language", "vision"].includes(exp.id) ? "The first run downloads a local model, potentially several hundred MB. The intermediate text is sent to Jev." : "Live results appear here and can be downloaded. They do not change the recorded benchmark."}</p></section>` : ""}<section class="panel"><h3>The question</h3><p>${exp.hypothesis}</p><h3 style="margin-top:24px">What we measure</h3><p>${exp.measure}</p>${result.note ? `<p>${esc(result.note)}</p>` : ""}</section></aside></div><section class="evidence"><div class="evidence-head"><h2>Evidence, not just a demo.</h2><button class="secondary" id="download-record">Download record ↓</button></div><div id="metrics"></div><div class="evidence-columns"><section class="panel"><h3>Decision evidence</h3><div id="probabilities"></div></section><section class="panel"><h3>Run notes</h3><div id="run-notes"></div></section></div><details class="raw"><summary>Inspect the complete recorded result</summary><pre id="raw-record"></pre></details></section>`;
  const render = async () => {
    dispose();
    document.querySelector("#stage")!.innerHTML = visualization(
      exp.id,
      row,
      result,
    );
    document.querySelector("#row-caption")!.textContent = rowName(
      row ?? { text: exp.measure },
      selected,
    );
    document.querySelector("#metrics")!.innerHTML = metricCards(
      exp,
      result,
      row,
    );
    document.querySelector("#probabilities")!.innerHTML = probabilities(row);
    document.querySelector("#run-notes")!.innerHTML =
      `<p class="fine">${esc(result.note ?? exp.measure)}</p>${result.latency_note ? `<p class="fine">${esc(result.latency_note)}</p>` : ""}${result.transport ? `<p class="fine">This run recorded ${result.transport.attempts ?? 0} transport attempts. Download the result for retries, failures, and cost metadata.</p>` : ""}${result.limitations ? `<ul class="fine">${result.limitations.map((x: string) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}${saved?.manifest ? `<p class="fine">Run ${esc(saved.manifest.id)}<br>${esc(saved.manifest.created)}<br>${saved.manifest.config?.quick ? "Small integration pilot. Do not treat it as the full planned benchmark." : "See the result for actual sample counts."}</p>` : '<p class="fine">No recorded benchmark is attached yet. Live inputs are independent exploratory runs.</p>'}${exp.id === "games" && result.summary ? table(result.summary, ["policy", "env", "episodes", "success_rate"]) : ""}${exp.id === "replica" && result.packed_separate_max_probability_difference !== undefined ? `<p class="fine">Largest packed versus separate probability difference: ${Number(result.packed_separate_max_probability_difference).toExponential(2)}.</p>` : ""}`;
    document.querySelector("#raw-record")!.textContent = JSON.stringify(
      row?.source === "live" ? row : (saved ?? result),
      null,
      2,
    ).slice(0, 180000);
    const cleanup = await bindVisual(exp.id, row, result);
    if (version !== generation) cleanup();
    else dispose = cleanup;
  };
  await render();
  if (version !== generation) return;
  const selector = document.querySelector<HTMLSelectElement>("#record-select");
  if (selector)
    selector.onchange = () => {
      selected = Number(selector.value);
      row = rows[selected];
      document.querySelector("#stage-count")!.textContent =
        `${selected + 1} / ${rows.length}`;
      document.querySelector("#stage-mode")!.textContent = "RECORDED OUTPUT";
      void render();
    };
  document.querySelector<HTMLButtonElement>("#download-record")!.onclick = () =>
    download(
      `jev-${exp.id}.json`,
      JSON.stringify(row?.source === "live" ? row : (saved ?? result), null, 2),
    );
  const runButton = document.querySelector<HTMLButtonElement>("#run-live");
  if (runButton) {
    const tokenInput =
      document.querySelector<HTMLInputElement>("#access-token");
    if (tokenInput)
      tokenInput.value = sessionStorage.getItem("jev-lab-token") ?? "";
    const status = document.querySelector<HTMLElement>("#run-status")!,
      cancel = document.querySelector<HTMLButtonElement>("#cancel-run")!;
    let running = false;
    cancel.onclick = () => {
      request?.abort();
      worker?.terminate();
      worker = undefined;
      running = false;
      runButton.disabled = false;
      cancel.hidden = true;
      status.textContent =
        "Cancelled. Any completed gateway request may still be charged.";
    };
    runButton.onclick = async () => {
      if (running) return;
      running = true;
      runButton.disabled = true;
      cancel.hidden = false;
      status.classList.remove("error");
      request = new AbortController();
      const own = request;
      const text = document
        .querySelector<HTMLTextAreaElement>("#prompt")!
        .value.trim();
      try {
        if (!text) throw Error("Add an input first.");
        const token = tokenInput?.value.trim() ?? "";
        if (!isLocal && !token)
          throw Error(
            "Open “Unlock live calls” and enter the private lab token. Recorded runs need no token.",
          );
        if (token) sessionStorage.setItem("jev-lab-token", token);
        status.textContent = "Preparing the experiment…";
        let extra: any = {};
        if (exp.id === "language" || exp.id === "vision") {
          if (!worker)
            worker = new Worker(new URL("./local.worker.ts", import.meta.url), {
              type: "module",
            });
          let image = "";
          if (exp.id === "vision") {
            const file =
              document.querySelector<HTMLInputElement>("#vision-file")!
                .files?.[0];
            if (!file) throw Error("Choose an image first.");
            if (file.size > 8 * 1024 * 1024)
              throw Error("Choose an image smaller than 8 MB.");
            image = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result));
              reader.onerror = reject;
              reader.readAsDataURL(file);
            });
          }
          extra = await localRun(
            exp.id,
            text,
            image,
            (message) => {
              if (own === request && !own.signal.aborted)
                status.textContent = message;
            },
            own.signal,
          );
          extra.image = image;
        }
        if (own.signal.aborted) return;
        status.textContent = "Jev is evaluating the typed questions…";
        const response = await fetch("/api/evaluate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(recipe(exp.live!, text, extra)),
          signal: own.signal,
        });
        const out = await response.json();
        if (!response.ok)
          throw Error(out.error ?? out.detail ?? `HTTP ${response.status}`);
        if (version !== generation || own.signal.aborted) return;
        row = artifact(exp.live!, text, out, extra);
        document.querySelector("#stage-mode")!.textContent = "LIVE OUTPUT";
        document.querySelector("#stage-count")!.textContent =
          `${Math.round(out.latency_ms)} MS`;
        await render();
        status.textContent = `Completed in ${Math.round(out.latency_ms)} ms at the gateway.${out.cost_usd == null ? " Cost metadata unavailable." : ` Reported cost $${Number(out.cost_usd).toFixed(6)}.`}`;
      } catch (error) {
        if (!own.signal.aborted && version === generation) {
          status.classList.add("error");
          status.textContent = String(
            error instanceof Error ? error.message : error,
          );
        }
      } finally {
        if (version === generation && own === request) {
          running = false;
          runButton.disabled = false;
          cancel.hidden = true;
        }
      }
    };
  }
}
function localRun(
  kind: string,
  prompt: string,
  image: string,
  progress: (s: string) => void,
  signal: AbortSignal,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const current = worker!;
    const abort = () => {
      current.terminate();
      if (worker === current) worker = undefined;
      reject(new DOMException("Cancelled", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    current.onmessage = (e) => {
      if (e.data.type === "progress") progress(e.data.message);
      else {
        signal.removeEventListener("abort", abort);
        if (e.data.type === "error") reject(Error(e.data.message));
        else resolve(e.data.result);
      }
    };
    current.onerror = (e) => {
      signal.removeEventListener("abort", abort);
      reject(Error(e.message));
    };
    current.postMessage({ kind, prompt, image });
  });
}
async function route() {
  generation++;
  dispose();
  dispose = () => {};
  request?.abort();
  worker?.terminate();
  worker = undefined;
  const version = generation,
    id = location.hash.replace("#experiment/", ""),
    exp = experiments.find((x) => x.id === id);
  if (exp) {
    window.scrollTo(0, 0);
    await detail(exp, version);
  } else home();
}
window.addEventListener("hashchange", () => void route());
try {
  const response = await fetch("/results/index.json");
  if (response.ok) index = await response.json();
} catch {
  /* Empty gallery still supports local live experiments. */
}
void route();
