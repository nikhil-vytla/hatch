import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Check,
  ArrowRight,
  Undo2,
  Link2,
  Download,
  Copy,
  Plus,
  Trash2,
} from "lucide-react";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  getSortedRowModel,
  type ColumnDef,
} from "@tanstack/react-table";
import { run, choice, judge, pretty, percent, download } from "./api";
import {
  Button,
  RunButton,
  Pane,
  Field,
  Pills,
  Notice,
  State,
  useRun,
  ErrorText,
} from "./shared";
export const pasteSources = {
  Conference:
    "Event: Small Worlds Conference\nOrganizer: Fieldwork Collective\nOrganizer address: 18 Pine Street, Portland\nVenue: Glasshouse Hall\nVenue address: 240 Oak Avenue, Seattle\nEvent date: October 12, 2026\nRegistration deadline: September 28, 2026\nContact email: hello@smallworlds.example\nStart time: 9:30 AM",
  Contact:
    "Person: Maya Chen\nRole: Design director\nCompany: Northstar Studio\nWork email: maya@northstar.example\nPersonal email: maya.chen@example.com\nOffice address: 440 Market Street, San Francisco\nCompany website: https://northstar.example",
  Memory:
    "Full name: Alex Morgan\nCurrent home address: 17 Cedar Lane, Oakland\nPrevious home address: 80 Lake Road, Berkeley (until June 2025)\nEmployer: Lantern Studio\nOffice address: 210 Mission Street, San Francisco\nPreferred shipping address: 17 Cedar Lane, Oakland\nPersonal email: alex@example.com\nWork email: alex@lantern.example",
};
export const pasteFields = {
  Conference: [
    "Event title",
    "Location",
    "Event date",
    "Start time",
    "Contact email",
  ],
  Contact: [
    "Full name",
    "Job title",
    "Company",
    "Work email",
    "Company website",
  ],
  Memory: [
    "Full name",
    "Shipping address",
    "Previous residence",
    "Company headquarters",
    "Personal email",
  ],
};
export function extractFacts(source: string) {
  return source
    .split("\n")
    .filter((s) => s.trim())
    .map((line, i) => ({
      id: "fact" + i,
      label: line.includes(":")
        ? line.slice(0, line.indexOf(":")).trim()
        : "Source " + (i + 1),
      value: line.includes(":")
        ? line.slice(line.indexOf(":") + 1).trim()
        : line.trim(),
      source: line,
    }));
}
export function pasteQuestions(
  fields: string[],
  facts: ReturnType<typeof extractFacts>,
  destination: string,
) {
  return Object.fromEntries(
    fields.map((field, i) => [
      "f" + i,
      choice(
        `For the ${destination} form, which fact belongs in the field "${field}"? Respect entity, purpose, and time. Choose none if missing or ambiguous.`,
        {
          ...Object.fromEntries(facts.map((f) => [f.id, f.source])),
          none: "No supported value, or ambiguous",
        },
      ),
    ]),
  );
}
export function Paste({ record }: { record: any }) {
  const [preset, setPreset] = useState<keyof typeof pasteSources>("Conference"),
    [source, setSource] = useState(pasteSources.Conference),
    [fields, setFields] = useState(pasteFields.Conference),
    [suggestions, setSuggestions] = useState<Record<string, string>>({}),
    [values, setValues] = useState<Record<string, string>>({}),
    [history, setHistory] = useState<Record<string, string>[]>([]),
    [active, setActive] = useState<string | null>(null),
    [last, setLast] = useState<any>(null),
    [mode, setMode] = useState("Whole form"),
    [focused, setFocused] = useState("f0");
  const { busy, error, execute } = useRun();
  const facts = useMemo(() => extractFacts(source), [source]);
  useEffect(() => {
    const r = record?.rows?.find((r: any) => r.preset === preset && !r.error);
    if (r) {
      setSuggestions(
        Object.fromEntries(
          Object.entries(r.answers).map(([k, a]: any) => [k, a.value]),
        ),
      );
      setLast({ ...r, source: "recorded" });
    }
  }, [record, preset]);
  const accept = (key?: string) => {
    setHistory((h) => [...h, values]);
    setValues((v) => ({
      ...v,
      ...Object.fromEntries(
        fields.flatMap((f, i) => {
          const id = "f" + i,
            s = facts.find((x) => x.id === suggestions[id]);
          return s && (!key || key === id) ? [[id, s.value]] : [];
        }),
      ),
    }));
  };
  return (
    <div className="workbench">
      <div className="artifact-column">
        <div className="split-title">
          <Pills
            values={["Smart paste", "Whole form", "Personal memory"]}
            value={mode}
            onChange={(v) => {
              setMode(v);
              if (v === "Personal memory") {
                setPreset("Memory");
                setSource(pasteSources.Memory);
                setFields(pasteFields.Memory);
                setSuggestions({});
                setValues({});
                setLast(null);
              }
            }}
          />
          <a className="text-link" href="/companion.zip" download>
            <Download size={14} /> Browser companion
          </a>
        </div>
        <div className="paste-workspace">
          <Pane
            title={
              preset === "Memory"
                ? "What your agent knows"
                : "Copied from the source"
            }
            sub={`${facts.length} facts`}
          >
            <div className="source-facts">
              {facts.map((f) => (
                <motion.button
                  layout
                  key={f.id}
                  className={"fact " + (active === f.id ? "highlight" : "")}
                  onClick={() => setActive(f.id)}
                >
                  <span>{f.label}</span>
                  <strong>{f.value}</strong>
                  <small>
                    {preset === "Memory" ? "Personal knowledge" : "Source page"}{" "}
                    · {f.id.replace("fact", "line ")}
                  </small>
                </motion.button>
              ))}
            </div>
          </Pane>
          <div className="paste-bridge">
            <ArrowRight />
          </div>
          <Pane
            title={
              preset === "Conference"
                ? "Create an event"
                : preset === "Contact"
                  ? "Add a contact"
                  : "Fill your details"
            }
            sub="Destination form"
          >
            <div className="destination">
              {fields.map((f, i) => {
                const key = "f" + i,
                  fact = facts.find((x) => x.id === suggestions[key]);
                return (
                  <div className="suggestion-field" key={key}>
                    <Field label={f}>
                      <input
                        value={values[key] ?? ""}
                        onFocus={() => {
                          setFocused(key);
                          setActive(fact?.id ?? null);
                        }}
                        onChange={(e) =>
                          setValues((v) => ({ ...v, [key]: e.target.value }))
                        }
                        placeholder={fact?.value ?? "Waiting for a suggestion"}
                      />
                    </Field>
                    <AnimatePresence>
                      {fact && !values[key] && (
                        <motion.div
                          initial={{ opacity: 0, y: -5 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0 }}
                          className="suggestion"
                        >
                          <button
                            onClick={() => {
                              setActive(fact.id);
                              accept(key);
                            }}
                          >
                            <Plus size={12} /> Use {fact.value}
                          </button>
                          <small onMouseEnter={() => setActive(fact.id)}>
                            {fact.label}
                          </small>
                        </motion.div>
                      )}
                    </AnimatePresence>
                    {suggestions[key] === "none" && (
                      <small className="missing">
                        No supported value. Add a detail to the source.
                      </small>
                    )}
                  </div>
                );
              })}
              <div className="actions">
                <Button
                  onClick={() =>
                    accept(mode === "Smart paste" ? focused : undefined)
                  }
                  disabled={!Object.keys(suggestions).length}
                >
                  <Check size={15} />{" "}
                  {mode === "Smart paste"
                    ? "Paste into focused field"
                    : "Fill suggestions"}
                </Button>
                <Button
                  secondary
                  disabled={!history.length}
                  onClick={() => {
                    setValues(history.at(-1)!);
                    setHistory((h) => h.slice(0, -1));
                  }}
                >
                  <Undo2 size={15} /> Undo
                </Button>
              </div>
            </div>
          </Pane>
        </div>
      </div>
      <aside className="controls">
        <Pane title="Copy once. Use it well.">
          <p className="fine">
            <a
              className="text-link"
              href="/research/COMPANION.md"
              target="_blank"
            >
              Companion installation guide ↗
            </a>
          </p>
          <p>
            Jev chooses source facts for each field. The source stays visible so
            you can inspect and correct every suggestion.
          </p>
          <Field label="Example">
            <select
              value={preset}
              onChange={(e) => {
                const p = e.target.value as keyof typeof pasteSources;
                setPreset(p);
                setSource(pasteSources[p]);
                setFields(pasteFields[p]);
                setSuggestions({});
                setValues({});
                setLast(null);
              }}
            >
              {Object.keys(pasteSources).map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </Field>
          <Field label="Edit the source">
            <textarea
              rows={10}
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                setSuggestions({});
                setLast(null);
              }}
            />
          </Field>
          <Field label="Destination fields, one per line">
            <textarea
              rows={5}
              value={fields.join("\n")}
              onChange={(e) => {
                setFields(e.target.value.split("\n"));
                setSuggestions({});
              }}
            />
          </Field>
          <RunButton
            busy={busy}
            label="Find what belongs"
            onClick={() =>
              execute(async () => {
                const r = await run(
                  { source, destination: preset },
                  pasteQuestions(fields, facts, preset),
                );
                setSuggestions(
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
          <ErrorText error={error} />
          {last && (
            <Notice>
              {last.source === "live"
                ? "Live Jev decisions"
                : "Recorded Jev decisions"}{" "}
              · {Math.round(last.latency_ms ?? 0)} ms
            </Notice>
          )}
          <State
            value={{ facts, fields, suggestions, filled: values, run: last }}
          />
        </Pane>
      </aside>
    </div>
  );
}
export const supportRows = [
  {
    id: "01",
    customer: "Maya",
    text: "Agent: I will refund your duplicate payment today. Customer: Thanks. No transaction ID is present.",
    promised: true,
    completed: false,
  },
  {
    id: "02",
    customer: "Leo",
    text: "A refund of $24 was processed. Transaction RF-8921. Customer confirmed receipt.",
    promised: true,
    completed: true,
  },
  {
    id: "03",
    customer: "Nora",
    text: "Customer asked how to change a delivery address. Agent updated the address.",
    promised: false,
    completed: false,
  },
  {
    id: "04",
    customer: "Theo",
    text: "Your refund has been approved and should be sent tomorrow. No payment confirmation yet.",
    promised: true,
    completed: false,
  },
  {
    id: "05",
    customer: "Ava",
    text: "The customer requested a refund. Agent declined because the item had been used.",
    promised: false,
    completed: false,
  },
  {
    id: "06",
    customer: "Sam",
    text: "We promised a refund last week. Today payment RF-3201 was sent and confirmed.",
    promised: true,
    completed: true,
  },
  {
    id: "07",
    customer: "Iris",
    text: "Agent: I can offer a store credit, not a cash refund. Customer accepted the credit.",
    promised: false,
    completed: false,
  },
  {
    id: "08",
    customer: "Jules",
    text: "Agent: I will reverse the accidental charge. The payment tool then failed with a timeout.",
    promised: true,
    completed: false,
  },
];
export function SemanticTable({ record }: { record: any }) {
  const [query, setQuery] = useState(
      "Was a refund promised but no successful refund is evidenced?",
    ),
    [rows, setRows] = useState<any[]>(supportRows),
    [selected, setSelected] = useState<string | null>(null),
    [only, setOnly] = useState(false),
    [last, setLast] = useState<any>(null);
  const { busy, error, execute } = useRun();
  useEffect(() => {
    if (record?.answers) {
      setRows(
        supportRows.map((r) => ({ ...r, score: record.answers[r.id]?.value })),
      );
      setLast(record);
    }
  }, [record]);
  const columns = useMemo<ColumnDef<any>[]>(
    () => [
      { accessorKey: "customer", header: "Customer" },
      {
        accessorKey: "text",
        header: "Conversation",
        cell: ({ row }) => (
          <button
            className="table-excerpt"
            onClick={() => setSelected(row.original.id)}
          >
            {row.original.text}
          </button>
        ),
      },
      {
        accessorKey: "score",
        header: "Needs a look",
        cell: ({ row }) =>
          row.original.score === undefined ? (
            <span className="muted">Not evaluated</span>
          ) : (
            <button
              className={
                "badge " + (row.original.score >= 0.5 ? "coral" : "sage")
              }
              onClick={() => setSelected(row.original.id)}
            >
              {row.original.score >= 0.5 ? "Yes" : "No"} ·{" "}
              {percent(row.original.score)}
            </button>
          ),
      },
    ],
    [],
  );
  const table = useReactTable({
    data: only ? rows.filter((r) => r.score >= 0.5) : rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  const active = rows.find((r) => r.id === selected);
  return (
    <div className="workbench">
      <div className="artifact-column">
        <Pane title="A question becomes a column" sub="8 authored examples">
          <div className="semantic-query">
            <span>ASK EACH ROW</span>
            <input
              aria-label="Question for each row"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setRows(supportRows);
                setLast(null);
              }}
            />
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={only}
              onChange={(e) => setOnly(e.target.checked)}
            />{" "}
            Only show matches
          </label>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                {table.getHeaderGroups().map((h) => (
                  <tr key={h.id}>
                    {h.headers.map((c) => (
                      <th key={c.id}>
                        {flexRender(c.column.columnDef.header, c.getContext())}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((r) => (
                  <motion.tr layout key={r.id}>
                    {r.getVisibleCells().map((c) => (
                      <td key={c.id}>
                        {flexRender(c.column.columnDef.cell, c.getContext())}
                      </td>
                    ))}
                  </motion.tr>
                ))}
              </tbody>
            </table>
          </div>
        </Pane>
        {active && (
          <Pane title={`${active.customer}'s conversation`}>
            <p className="quote">{active.text}</p>
            <p>
              Independent fixture facts: refund promised{" "}
              <strong>{String(active.promised)}</strong>; completed{" "}
              <strong>{String(active.completed)}</strong>.
            </p>
            <Field label="Your correction">
              <select
                value={active.correction ?? ""}
                onChange={(e) =>
                  setRows((rs) =>
                    rs.map((r) =>
                      r.id === active.id
                        ? { ...r, correction: e.target.value }
                        : r,
                    ),
                  )
                }
              >
                <option value="">Keep the model judgment</option>
                <option>Needs follow-up</option>
                <option>Already resolved</option>
              </select>
            </Field>
          </Pane>
        )}
      </div>
      <aside className="controls">
        <Pane title="Every answer is inspectable">
          <p>
            Read the actual conversation. Change the semantic question. Correct
            a result. These eight fixtures demonstrate the interaction; they are
            not a general accuracy benchmark.
          </p>
          <RunButton
            busy={busy}
            label="Evaluate the column"
            onClick={() =>
              execute(async () => {
                const r = await run(
                  {
                    conversations: Object.fromEntries(
                      rows.map((r) => [r.id, r.text]),
                    ),
                  },
                  Object.fromEntries(
                    rows.map((r) => [
                      r.id,
                      judge(
                        `For conversation ${r.id}: ${query} Use only that conversation as evidence.`,
                      ),
                    ]),
                  ),
                );
                setRows((rs) =>
                  rs.map((row) => ({ ...row, score: r.answers[row.id].value })),
                );
                setLast(r);
              })
            }
          />
          <ErrorText error={error} />
          {last && (
            <Notice>
              {Object.keys(last.answers).length} judgments from one request.
            </Notice>
          )}
          <Button
            secondary
            onClick={() =>
              download("semantic-table.json", { question: query, rows })
            }
          >
            <Download size={14} /> Export review
          </Button>
          <State value={{ question: query, rows, run: last }} />
        </Pane>
      </aside>
    </div>
  );
}
export const initialDesign = {
  accent: "#d97b5c",
  background: "#f8efe1",
  layout: "cards",
  title: "A few good places",
  rounded: true,
};
export const edits = [
  {
    id: "e1",
    field: "accent",
    before: "#d97b5c",
    after: "#607fa0",
    description: "Changed the accent color from terracotta to blue",
  },
  {
    id: "e2",
    field: "layout",
    before: "cards",
    after: "list",
    description: "Changed the apartment layout from cards to a compact list",
  },
  {
    id: "e3",
    field: "background",
    before: "#f8efe1",
    after: "#e5eee7",
    description: "Changed the preview background from warm cream to sage",
  },
  {
    id: "e4",
    field: "title",
    before: "A few good places",
    after: "Your next chapter",
    description: "Changed the title text to Your next chapter",
  },
  {
    id: "e5",
    field: "rounded",
    before: true,
    after: false,
    description: "Changed the corners from rounded to square",
  },
];
export function UndoExperiment({ record }: { record: any }) {
  const [query, setQuery] = useState(
      "Undo the color changes, but keep the new layout and title.",
    ),
    [chosen, setChosen] = useState<string[]>([]),
    [applied, setApplied] = useState(false),
    [last, setLast] = useState<any>(null);
  const { busy, error, execute } = useRun();
  const current = Object.fromEntries(edits.map((e) => [e.field, e.after]));
  const design = {
    ...current,
    ...(applied
      ? Object.fromEntries(
          edits
            .filter((e) => chosen.includes(e.id))
            .map((e) => [e.field, e.before]),
        )
      : {}),
  };
  useEffect(() => {
    if (record?.answers) {
      setChosen(
        edits
          .filter((e) => record.answers[e.id]?.value >= 0.5)
          .map((e) => e.id),
      );
      setLast(record);
    }
  }, [record]);
  return (
    <div className="workbench">
      <div className="artifact-column">
        <motion.div
          className="undo-canvas"
          animate={{ backgroundColor: String(design.background) }}
        >
          <span className="preview-label">LIVE EDITABLE PREVIEW</span>
          <motion.h2 layout>{String(design.title)}</motion.h2>
          <div className={"apartment-preview " + design.layout}>
            {["Sunlit studio", "Garden apartment", "Corner loft"].map(
              (name, i) => (
                <motion.div
                  layout
                  key={name}
                  animate={{ borderRadius: design.rounded ? 18 : 2 }}
                  className="apartment-tile"
                >
                  <div className={"apartment-image apartment-" + i} />
                  <div>
                    <strong>{name}</strong>
                    <span>{["$2,150", "$2,350", "$2,600"][i]} / month</span>
                    <motion.button
                      animate={{ backgroundColor: String(design.accent) }}
                    >
                      View apartment <ArrowRight size={13} />
                    </motion.button>
                  </div>
                </motion.div>
              ),
            )}
          </div>
        </motion.div>
        <Pane title="Five changes. One request.">
          <div className="edit-history">
            {edits.map((e) => (
              <button
                className={"edit " + (chosen.includes(e.id) ? "chosen" : "")}
                key={e.id}
                onClick={() => {
                  setChosen((c) =>
                    c.includes(e.id)
                      ? c.filter((x) => x !== e.id)
                      : [...c, e.id],
                  );
                  setApplied(false);
                }}
              >
                <span className="edit-dot">
                  {chosen.includes(e.id) ? (
                    <Undo2 size={12} />
                  ) : (
                    <Check size={12} />
                  )}
                </span>
                {e.description}
                <small>{chosen.includes(e.id) ? "Undo" : "Keep"}</small>
              </button>
            ))}
          </div>
        </Pane>
      </div>
      <aside className="controls">
        <Pane title="History, by meaning">
          <p>
            Jev selects the edits. Code restores their original values. You can
            adjust the selection before applying it.
          </p>
          <Field label="What would you like to undo?">
            <textarea
              rows={4}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </Field>
          <RunButton
            busy={busy}
            label="Find those changes"
            onClick={() =>
              execute(async () => {
                const r = await run(
                  { request: query, edits },
                  Object.fromEntries(
                    edits.map((e) => [
                      e.id,
                      judge(
                        `Should edit ${e.id} be undone to satisfy the user's request? Preserve unrelated edits.`,
                      ),
                    ]),
                  ),
                );
                setChosen(
                  edits
                    .filter((e) => r.answers[e.id].value >= 0.5)
                    .map((e) => e.id),
                );
                setLast(r);
                setApplied(false);
              })
            }
          />
          <Button
            disabled={!chosen.length}
            onClick={() => setApplied(!applied)}
          >
            {applied
              ? "Restore all changes"
              : `Undo ${chosen.length} selected changes`}
          </Button>
          <ErrorText error={error} />
          <State
            value={{
              request: query,
              selected: chosen,
              applied,
              design,
              run: last,
            }}
          />
        </Pane>
      </aside>
    </div>
  );
}
export const impactFacts = {
  venue: "Glasshouse Hall, Seattle",
  date: "October 12, 2026",
  capacity: "120 guests",
};
export const conclusions = [
  {
    id: "travel",
    text: "Tell guests to travel to Glasshouse Hall in Seattle.",
    depends: ["venue"],
  },
  {
    id: "calendar",
    text: "Calendar invitation: October 12, Glasshouse Hall, Seattle.",
    depends: ["venue", "date"],
  },
  {
    id: "catering",
    text: "Order food for up to 120 guests.",
    depends: ["capacity"],
  },
  {
    id: "reminder",
    text: "Send a reminder on October 5, one week before the event.",
    depends: ["date"],
  },
];
export function Changes({ record }: { record: any }) {
  const [field, setField] = useState("venue"),
    [value, setValue] = useState("Waterfront Pavilion, Portland"),
    [answers, setAnswers] = useState<any>(record?.answers ?? null),
    [last, setLast] = useState<any>(record);
  const { busy, error, execute } = useRun();
  useEffect(() => {
    setAnswers(record?.answers ?? null);
    setLast(record);
  }, [record]);
  return (
    <div className="workbench">
      <div className="artifact-column">
        <Pane title="The source changed">
          <div className="source-diff">
            <span>BEFORE</span>
            <del>{impactFacts[field as keyof typeof impactFacts]}</del>
            <ArrowRight size={18} />
            <span>AFTER</span>
            <ins>{value}</ins>
          </div>
        </Pane>
        <div className="impact-list">
          {conclusions.map((c, i) => (
            <motion.div
              layout
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.08 }}
              className={
                "impact-card " +
                (answers?.[c.id]?.value >= 0.5 ? "affected" : "")
              }
              key={c.id}
            >
              <span className="impact-index">0{i + 1}</span>
              <div>
                <p>{c.text}</p>
                <span className="badge">
                  {!answers
                    ? "Waiting for a judgment"
                    : answers[c.id]?.value >= 0.5
                      ? "Needs another look"
                      : "Still supported"}
                </span>
              </div>
              <Link2 size={17} />
            </motion.div>
          ))}
        </div>
      </div>
      <aside className="controls">
        <Pane title="Follow the consequences">
          <p>
            Change one fact and inspect which conclusions need review. The
            authored dependency list provides an independent check for these
            examples.
          </p>
          <Field label="Fact to change">
            <select
              value={field}
              onChange={(e) => {
                setField(e.target.value);
                setValue("");
                setAnswers(null);
              }}
            >
              {Object.keys(impactFacts).map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </Field>
          <Field label="New value">
            <input
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setAnswers(null);
              }}
            />
          </Field>
          <RunButton
            busy={busy}
            label="Trace the impact"
            onClick={() =>
              execute(async () => {
                const r = await run(
                  {
                    before: impactFacts,
                    after: { ...impactFacts, [field]: value },
                    conclusions,
                  },
                  Object.fromEntries(
                    conclusions.map((c) => [
                      c.id,
                      judge(
                        `Does conclusion ${c.id} need review because the facts changed? Ignore spelling-only changes.`,
                      ),
                    ]),
                  ),
                );
                setAnswers(r.answers);
                setLast(r);
              })
            }
          />
          <ErrorText error={error} />
          <State
            value={{
              before: impactFacts,
              after: { ...impactFacts, [field]: value },
              conclusions,
              run: last,
            }}
          />
        </Pane>
      </aside>
    </div>
  );
}
