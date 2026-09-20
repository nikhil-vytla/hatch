import { useState } from "react";
import { motion } from "motion/react";
import { Download, Code2 } from "lucide-react";
import {
  Pane,
  Field,
  Button,
  RunButton,
  Pills,
  State,
  Bars,
  Notice,
  Stat,
  useRun,
  ErrorText,
} from "./shared";
import { run, choice, judge, pretty, download } from "./api";
export function Logos({ result }: { result: any }) {
  const rows = (result.rows ?? []).filter((r: any) => r.spec),
    [brief, setBrief] = useState(
      rows[0]?.brief ?? "A neighborhood seed library",
    ),
    [spec, setSpec] = useState(
      rows[0]?.spec ?? {
        symbol: "leaf",
        palette: "teal",
        structure: "single",
        weight: "light",
      },
    ),
    [last, setLast] = useState<any>(null);
  const { busy, error, execute } = useRun();
  const palette: Record<string, string> = {
      teal: "#587d70",
      coral: "#c97458",
      violet: "#8b79a5",
      ink: "#454641",
    },
    color = palette[spec.palette] ?? palette.teal;
  const shape =
    spec.symbol === "leaf" ? (
      <path d="M0 50C-67 5-43-55 40-58C64 12 25 58 0 50ZM0 50L27-34" />
    ) : spec.symbol === "star" ? (
      <path d="M0-58 16-17 58-15 25 12 35 53 0 30-35 53-25 12-58-15-16-17Z" />
    ) : spec.symbol === "wave" ? (
      <path d="M-60 20Q-30-40 0 0T60-20M-60 40Q-30-20 0 20T60 0" />
    ) : spec.symbol === "mountain" ? (
      <path d="M-65 45 0-55 65 45ZM-22-21 0 0 18-27" />
    ) : (
      <circle r="50" />
    );
  const mark = (variant: string) => (
    <svg
      viewBox="-100 -100 200 200"
      fill="none"
      stroke="currentColor"
      strokeWidth={
        spec.weight === "bold" ? 9 : spec.weight === "medium" ? 5 : 3
      }
    >
      {variant === "orbit" ? (
        <g>
          {[0, 90, 180, 270].map((a) => (
            <g key={a} transform={`rotate(${a}) translate(0,-37) scale(.45)`}>
              {shape}
            </g>
          ))}
        </g>
      ) : variant === "paired" ? (
        <g>
          <g transform="translate(-23,0) scale(.7)">{shape}</g>
          <g transform="translate(23,0) scale(.7)">{shape}</g>
        </g>
      ) : variant === "nested" ? (
        <g>
          {shape}
          <g transform="scale(.55)">{shape}</g>
        </g>
      ) : (
        shape
      )}
    </svg>
  );
  return (
    <div className="workbench">
      <div className="artifact-column">
        <div className="logo-stage" style={{ color }}>
          <motion.div
            key={JSON.stringify(spec)}
            initial={{ opacity: 0, rotate: -10, scale: 0.8 }}
            animate={{ opacity: 1, rotate: 0, scale: 1 }}
            transition={{ type: "spring", damping: 15 }}
          >
            {mark(spec.structure)}
          </motion.div>
          <h2>{brief}</h2>
          <span>ONE IDEA, A FAMILY OF MARKS</span>
        </div>
        <div className="logo-family">
          {["single", "paired", "nested", "orbit"].map((v) => (
            <button
              key={v}
              style={{ color }}
              className={v === spec.structure ? "active" : ""}
              onClick={() => setSpec({ ...spec, structure: v })}
            >
              {mark(v)}
              <span>{v}</span>
            </button>
          ))}
        </div>
      </div>
      <aside className="controls">
        <Pane title="Find the character">
          <Field label="Design brief">
            <textarea
              rows={4}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
            />
          </Field>
          <RunButton
            busy={busy}
            label="Explore a direction"
            onClick={() =>
              execute(async () => {
                const r = await run(brief, {
                  symbol: choice("Choose the most suitable symbol", [
                    "leaf",
                    "star",
                    "wave",
                    "mountain",
                    "circle",
                  ]),
                  palette: choice(
                    "Choose a color family",
                    Object.keys(palette),
                  ),
                  structure: choice("Choose the composition", [
                    "single",
                    "paired",
                    "nested",
                    "orbit",
                  ]),
                  weight: choice("Choose the stroke weight", [
                    "light",
                    "medium",
                    "bold",
                  ]),
                });
                setSpec(
                  Object.fromEntries(
                    Object.entries(r.answers).map(([k, a]: any) => [
                      k,
                      a.value,
                    ]),
                  ),
                );
                setLast(r);
              })
            }
          />
          <Field label="Color family">
            <select
              value={spec.palette}
              onChange={(e) => setSpec({ ...spec, palette: e.target.value })}
            >
              {Object.keys(palette).map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </Field>
          <Field label="Line weight">
            <select
              value={spec.weight}
              onChange={(e) => setSpec({ ...spec, weight: e.target.value })}
            >
              {["light", "medium", "bold"].map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </Field>
          <Button
            secondary
            onClick={() => {
              const svg = document.querySelector(".logo-stage svg")?.outerHTML;
              if (svg)
                download(
                  "jev-mark.svg",
                  svg.replace(
                    "<svg ",
                    `<svg xmlns="http://www.w3.org/2000/svg" style="color:${color}" `,
                  ),
                  "image/svg+xml",
                );
            }}
          >
            <Download size={14} /> Save SVG
          </Button>
          <ErrorText error={error} />
          <State value={{ spec, run: last }} />
          <p className="fine">
            The symbol vocabulary is deliberately visible. Jev selects a
            direction; drawing code defines the shapes.
          </p>
        </Pane>
      </aside>
    </div>
  );
}
export function Decisions({ result }: { result: any }) {
  const assessments =
      result.rows?.find((r: any) => r.assessments)?.assessments ?? [],
    [weights, setWeights] = useState<Record<string, number>>({
      usefulness: 3,
      novelty: 2,
      ease: 2,
      shareability: 1,
    });
  const ranked = assessments
    .map((a: any) => ({
      ...a,
      total:
        Object.entries(weights).reduce(
          (s, [k, w]) => s + w * (a.scores[k] ?? 0),
          0,
        ) /
        Math.max(
          1,
          Object.values(weights).reduce((a, b) => a + b, 0),
        ) /
        2,
    }))
    .sort((a: any, b: any) => b.total - a.total);
  return (
    <div className="workbench">
      <div className="artifact-column">
        <Pane title="Change the priorities. Follow the recommendation.">
          <div className="decision-ranking">
            {ranked.map((a: any, i: number) => (
              <motion.article
                layout
                transition={{ type: "spring", damping: 25 }}
                className={"decision-card " + (!i ? "winner" : "")}
                key={a.id}
              >
                <span className="rank">0{i + 1}</span>
                <div>
                  <h3>{a.name}</h3>
                  <p>{a.evidence}</p>
                  <Bars
                    values={Object.fromEntries(
                      Object.entries(a.scores).map(([k, v]) => [
                        k,
                        Number(v) / 2,
                      ]),
                    )}
                  />
                </div>
                <strong>{Math.round(a.total * 100)}</strong>
              </motion.article>
            ))}
          </div>
        </Pane>
      </div>
      <aside className="controls">
        <Pane title="Your definition of better">
          {Object.entries(weights).map(([k, v]) => (
            <Field label={`${pretty(k)} · ${v}`} key={k}>
              <input
                type="range"
                min="0"
                max="5"
                value={v}
                onChange={(e) =>
                  setWeights({ ...weights, [k]: Number(e.target.value) })
                }
              />
            </Field>
          ))}
          <p>
            Jev’s recorded criteria scores stay fixed. The sliders change how
            much each criterion matters to the final ranking.
          </p>
          <State value={{ weights, ranked }} />
        </Pane>
      </aside>
    </div>
  );
}
export function Vision({ result }: { result: any }) {
  const [row, setRow] = useState<any>(result.rows?.[0]),
    [caption, setCaption] = useState(row?.description ?? ""),
    [question, setQuestion] = useState(
      "What should I inspect next in this image?",
    );
  const { busy, error, execute } = useRun();
  return (
    <div className="workbench">
      <div className="artifact-column">
        <Pane title="What the vision model actually saw">
          <img
            className="vision-input"
            src={row?.image ?? "/vision-input.png"}
            alt="The actual input image used by the local vision model"
          />
          <div className="question-card">
            <span className="eyebrow">LOCAL MODEL’S CAPTION</span>
            <p>{row?.description}</p>
          </div>
          <Notice>
            The caption incorrectly describes electronic devices. This is a real
            failure of the first captioning stage. Jev only receives the text,
            so missing visual evidence limits its next decision.
          </Notice>
        </Pane>
      </div>
      <aside className="controls">
        <Pane title="Repair the evidence">
          <p>
            Compare the picture with the caption. Correct the description and
            see how the downstream decision changes.
          </p>
          <Field label="Description passed to Jev">
            <textarea
              rows={6}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
            />
          </Field>
          <Field label="Question">
            <textarea
              rows={3}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </Field>
          <RunButton
            busy={busy}
            label="Decide from this evidence"
            onClick={() =>
              execute(async () => {
                const r = await run(
                  { description: caption, question },
                  {
                    action: choice("Choose the appropriate next action", [
                      "navigate",
                      "describe",
                      "inspect",
                      "ask",
                    ]),
                    enough_evidence: judge(
                      "Is the description sufficient to answer the user accurately?",
                    ),
                  },
                );
                setRow({ ...row, ...r });
              })
            }
          />
          <ErrorText error={error} />
          <State value={row} />
        </Pane>
      </aside>
    </div>
  );
}
const adapterExamples: Record<string, string> = {
  Python:
    'class Ticket(BaseModel):\n    area: Literal["billing", "technical", "account", "other"]\n    refund: bool\n    missing_context: float = Field(ge=0, le=1)\n\nquestions = questions_for(Ticket)\nvalue = decode(Ticket, answers)',
  TypeScript:
    'const Ticket = z.object({\n  area: z.enum(["billing", "technical", "account", "other"]),\n  refund: z.boolean(),\n  missing_context: z.number().min(0).max(1),\n});\n\nconst decision = await decide(Ticket, text, transport);',
  Rust: "#[derive(Serialize, Deserialize, JsonSchema)]\nstruct Ticket {\n    area: Area,\n    refund: bool,\n    #[schemars(range(min = 0, max = 1))]\n    missing_context: f64,\n}\nlet questions = compile(&schema_for!(Ticket).to_value())?;",
  Go: 'type Ticket struct {\n  Area string `json:"area" jsonschema:"enum=billing,enum=technical,enum=account,enum=other"`\n  Refund bool `json:"refund"`\n  MissingContext float64 `json:"missing_context" jsonschema:"minimum=0,maximum=1"`\n}\nquestions, err := Compile(jsonschema.Reflect(&Ticket{}))',
};
export function Adapters({ result }: { result: any }) {
  const [language, setLanguage] = useState("TypeScript"),
    [input, setInput] = useState(
      result.input ?? "I was charged twice. Please return the extra payment.",
    ),
    [row, setRow] = useState<any>(result.rows?.[0]);
  const { busy, error, execute } = useRun();
  return (
    <div className="workbench">
      <div className="artifact-column">
        <Pane title="A type becomes a decision contract">
          <Pills
            values={Object.keys(adapterExamples)}
            value={language}
            onChange={setLanguage}
          />
          <pre className="code large-code">{adapterExamples[language]}</pre>
          <div className="schema-flow">
            <Code2 />
            <span>Type definition</span>
            <span>→</span>
            <span>Jev questions</span>
            <span>→</span>
            <span>Validated value</span>
          </div>
          <pre className="code output-code">
            {JSON.stringify(row?.value ?? row?.answers, null, 2)}
          </pre>
        </Pane>
      </div>
      <aside className="controls">
        <Pane title="One input, four languages">
          <Field label="Support request">
            <textarea
              rows={5}
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
          </Field>
          <RunButton
            busy={busy}
            onClick={() =>
              execute(async () => {
                const r = await run(input, result.questions);
                setRow({
                  answers: r.answers,
                  value: Object.fromEntries(
                    Object.entries(r.answers).map(([k, a]: any) => [
                      k,
                      k === "refund" ? a.value >= 0.5 : a.value,
                    ]),
                  ),
                });
              })
            }
          />
          <ErrorText error={error} />
          <Notice>
            The four recorded adapters decode the same response. Live input here
            shows the shared semantic contract; each language adapter is
            available in the research project.
          </Notice>
          <State value={{ questions: result.questions, record: row }} />
        </Pane>
      </aside>
    </div>
  );
}
