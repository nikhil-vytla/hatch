import { compositionEvents } from "../../quality-and-simulation-review/composition-stream";
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  defineRegistry,
  Renderer,
  StateProvider,
  ActionProvider,
  VisibilityProvider,
  useBoundProp,
  useStateStore,
  useStateValue,
} from "@json-render/react";
import { Sparkles, Check, GitBranch, RotateCcw } from "lucide-react";
import { uiCatalog, uiInitial, exampleSpec } from "./ui-catalog";
import { getApiKey, download, readResponse } from "./api";
import {
  Pane,
  Field,
  Button,
  RunButton,
  Pills,
  Notice,
  State,
  useRun,
  ErrorText,
} from "./shared";
function Input({ props, bindings }: any) {
  const [value, set] = useBoundProp<string>(props.value, bindings?.value);
  return (
    <Field label={props.label}>
      <input
        value={value ?? ""}
        placeholder={props.placeholder}
        onChange={(e) => set(e.target.value)}
      />
    </Field>
  );
}
function Toggle({ props, bindings }: any) {
  const [value, set] = useBoundProp<boolean>(props.checked, bindings?.checked);
  return (
    <label className="toggle-row">
      <span>{props.label}</span>
      <button
        role="switch"
        aria-checked={value}
        aria-label={props.label}
        className={"toggle " + (value ? "on" : "")}
        onClick={() => set(!value)}
      >
        <motion.i layout />
      </button>
    </label>
  );
}
function Choice({ props, bindings }: any) {
  const [value, set] = useBoundProp<string>(props.value, bindings?.value);
  return (
    <Field label={props.label}>
      <select value={value ?? ""} onChange={(e) => set(e.target.value)}>
        {props.options.map((o: string) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    </Field>
  );
}
const { registry } = defineRegistry(uiCatalog, {
  actions: {
    save: async () => {},
    reset: async () => {},
    shortlist: async () => {},
  },
  components: {
    Stack: ({ props, children }) => (
      <motion.div
        layout
        className={`gen-stack ${props.direction} gap-${props.gap}`}
      >
        {children}
      </motion.div>
    ),
    Card: ({ props, children }) => (
      <motion.section
        layout
        initial={{ opacity: 0, y: 15, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={{ type: "spring", stiffness: 210, damping: 26 }}
        className="gen-card"
      >
        <h3>{props.title}</h3>
        <p>{props.subtitle}</p>
        <div className="gen-card-body">{children}</div>
      </motion.section>
    ),
    Heading: ({ props }) => <motion.h2 layout>{props.text}</motion.h2>,
    Text: ({ props }) => (
      <motion.p layout className="fine">
        {props.text}
      </motion.p>
    ),
    Input,
    Toggle,
    Choice,
    Metric: ({ props }) => (
      <motion.div layout className="gen-metric">
        <span>{props.label}</span>
        <strong>{props.value}</strong>
        <small>{props.detail}</small>
      </motion.div>
    ),
    Button: ({ props, emit }) => (
      <motion.button
        layout
        className={`button ${props.variant === "secondary" ? "secondary" : ""}`}
        onClick={() => emit("press")}
      >
        {props.label}
      </motion.button>
    ),
    Apartment: ({ props, emit }) => (
      <motion.article
        layout
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="gen-card"
      >
        <h3>{props.name}</h3>
        <p>{props.details}</p>
        <div className="gen-metric">
          <span>Monthly rent</span>
          <strong>{props.rent}</strong>
          <small>Before utilities</small>
        </div>
        <Button secondary onClick={() => emit("press")}>
          Shortlist {props.name}
        </Button>
      </motion.article>
    ),
    Progress: ({ props }) => (
      <div className="gen-progress">
        <span>{props.label}</span>
        <div style={{ width: props.value + "%" }} />
      </div>
    ),
  },
});
function StateObserver({ onState }: { onState: (s: any) => void }) {
  const value = useStateValue<any>("");
  useEffect(() => {
    if (value) onState(value);
  }, [value, onState]);
  return null;
}
export function GeneratedUI({ record }: { record: any }) {
  const [domain, setDomain] = useState("settings"),
    [prompt, setPrompt] = useState(
      "Create account settings with name, email, notifications, and a save button.",
    ),
    [spec, setSpec] = useState<any>(exampleSpec),
    [versions, setVersions] = useState<any[]>([
      {
        spec: exampleSpec,
        label: "Prepared starting interface",
        kind: "fixture",
      },
    ]),
    [active, setActive] = useState(0),
    [notice, setNotice] = useState(""),
    [steps, setSteps] = useState<any[]>([]),
    [source, setSource] = useState("Prepared interface"),
    [epoch, setEpoch] = useState(0),
    [replaying, setReplaying] = useState(false);
  const requestVersion = useRef(0);
  const [shortlist, setShortlist] = useState<string[]>([]);
  const replayTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const { busy, error, execute } = useRun();
  const state = useRef<any>(uiInitial),
    controller = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      requestVersion.current++; controller.current?.abort();
      if (replayTimer.current) clearInterval(replayTimer.current);
    },
    [],
  );
  useEffect(() => {
    const r = record?.rows?.find(
      (r: any) => r.domain === domain && r.spec && r.stopReason === "finish",
    );
    if (r) {
      setSpec(r.spec);
      setVersions([{ spec: r.spec, label: r.prompt, kind: "recorded" }]);
      setActive(0);
      setSource("Recorded Jev composition");
      setSteps(r.steps);
      setEpoch((x) => x + 1);
    }
  }, [record, domain]);
  function replay() {
    const r = record?.rows?.find(
      (r: any) => r.domain === domain && r.stopReason === "finish",
    );
    if (!r) return;
    if (replayTimer.current) clearInterval(replayTimer.current);
    const keys = Object.keys(r.spec.elements);
    let count = 1;
    setReplaying(true);
    setSteps([]);
    setSource("Replaying recorded build");
    setEpoch((e) => e + 1);
    const tick = () => {
      const included = new Set(keys.slice(0, count));
      setSpec({
        ...r.spec,
        elements: Object.fromEntries(
          keys.slice(0, count).map((k) => [
            k,
            {
              ...r.spec.elements[k],
              children: (r.spec.elements[k].children ?? []).filter(
                (c: string) => included.has(c),
              ),
            },
          ]),
        ),
      });
      setSteps(r.steps.slice(0, count));
      if (count++ >= keys.length) {
        clearInterval(replayTimer.current!);
        setReplaying(false);
        setSource("Recorded Jev composition");
      }
    };
    tick();
    replayTimer.current = setInterval(tick, 550);
  }
  async function generate(edit: boolean) {
    await execute(async () => {
      const version=++requestVersion.current;
      const requestController = new AbortController(); controller.current = requestController;
      setVersions(v=>v.map((item,i)=>i===active?{...item,spec:{...item.spec,state:structuredClone(state.current)}}:item));
      setSteps([]);
      setNotice("");
      try {
      const response = await fetch("/api/compose", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getApiKey()}`,
        },
        body: JSON.stringify({
          prompt,
          domain,
          state: edit ? state.current : uiInitial,
          ...(edit ? { spec } : {}),
        }),
        signal: requestController.signal,
      });
      if (!response.ok) {
        const b = await readResponse(response);
        throw new Error(b.error);
      }
      if(version!==requestVersion.current)return;
      let final:any=null, complete=false;
      for await(const event of compositionEvents(response.body!,requestController.signal)) {
          if(version!==requestVersion.current)return;
          if(event.type === "complete")complete=true;
          if (event.type === "error") {
            setSource("Interrupted composition");
            throw new Error(event.error);
          }
          if (event.spec) {
            setSpec(event.spec);
            final = event;
            setSource(
              event.type === "complete"
                ? event.stopReason === "finish"
                  ? "Live Jev composition"
                  : "Partial composition"
                : "Jev is composing",
            );
          }
          if (event.step) setSteps((s) => [...s, event.step]);
          if (event.type === "complete" && event.stopReason !== "finish")
            setNotice(
              "Partial composition: " +
                event.stopReason +
                ". The last valid version is preserved.",
            );
      }
      if(version!==requestVersion.current)return;
      if (!complete) { setSource("Partial composition"); setNotice("The stream ended before completion. The visible partial interface is preserved; it is not a completed run."); }
      if (final?.spec) {
        setVersions((v) => [
          ...v,
          {
            spec: final.spec,
            label: prompt,
            kind: final.stopReason === "finish" ? "live" : "partial",
          },
        ]);
        setActive(versions.length);
        setEpoch((e) => e + 1);
      }
      } catch(error) { if(requestController.signal.aborted || version!==requestVersion.current)return; setSource("Interrupted composition"); throw error; }
    });
  }
  return (
    <div className="workbench">
      <div className="artifact-column">
        <div className="browser-frame">
          <div className="browser-top">
            <span className="traffic">
              <i />
              <i />
              <i />
            </span>
            <span>your-next-interface.local</span>
            <span className="badge">{source}</span>
          </div>
          <div
            className={"generated-preview " + (busy ? "composing" : "")}
            aria-busy={busy || replaying}
            inert={busy || replaying}
          >
            <StateProvider key={epoch} initialState={spec.state ?? uiInitial}>
              <StateObserver
                onState={(s) => {
                  state.current = s;
                }}
              />
              <VisibilityProvider>
                <ActionProvider
                  handlers={{
                    save: () =>
                      setNotice(
                        "Saved in this preview. Try editing the interface while keeping your values.",
                      ),
                    reset: () => setEpoch((e) => e + 1),
                    shortlist: async (p: any) => {
                      const name=String(p.name??"Apartment"); setShortlist(items=>items.includes(name)?items:[...items,name]);
                      setNotice(`${name} added to your shortlist.`);
                    },
                  }}
                >
                  <Renderer spec={spec} registry={registry} />
                </ActionProvider>
              </VisibilityProvider>
            </StateProvider>
            {busy && (
              <div className="composing-indicator">
                <Sparkles size={15} /> Arranging the pieces
              </div>
            )}
          </div>
        </div>
        {notice && <Notice>{notice}</Notice>}
        {shortlist.length>0&&<Pane title="Your shortlist">{shortlist.map(name=><Button key={name} secondary onClick={()=>setShortlist(items=>items.filter(item=>item!==name))}>{name} · Remove</Button>)}</Pane>}
        <div className="version-strip">
          {versions.map((v, i) => (
            <button
              className={active === i ? "active" : ""}
              key={i}
              disabled={busy || replaying}
              onClick={() => {
                if(i===active)return;
                setVersions(items=>items.map((item,n)=>n===active?{...item,spec:{...item.spec,state:structuredClone(state.current)}}:item));
                setSpec(v.spec);
                setActive(i);
                setEpoch((e) => e + 1);
                setSource(
                  v.kind === "fixture"
                    ? "Prepared interface"
                    : `${v.kind} Jev composition`,
                );
              }}
            >
              <GitBranch size={13} />
              <strong>Version {i + 1}</strong>
              <span>{v.label}</span>
            </button>
          ))}
        </div>
      </div>
      <aside className="controls">
        <Pane title="An interface you can use">
          <p>
            Jev composes a tree from typed components. The renderer handles real
            fields, actions, and animated layout changes.
          </p>
          <Pills
            values={["settings", "apartments", "event"]}
            value={domain}
            onChange={(d) => {
              requestVersion.current++; controller.current?.abort(); setShortlist([]); setNotice("");
              if (replayTimer.current) clearInterval(replayTimer.current);
              setReplaying(false);
              setDomain(d);
              setSpec(exampleSpec);
              setSource("Prepared interface");
              setVersions([
                {
                  spec: exampleSpec,
                  label: "Prepared starting interface",
                  kind: "fixture",
                },
              ]);
              setActive(0);
              setPrompt(
                d === "apartments"
                  ? "Compare all three apartments. Show rent, commute, budget, and a shortlist button for each."
                  : d === "event"
                    ? "Create an event planning form with name, location, guests, dietary preference, and save."
                    : "Create account settings with name, email, notifications, and save.",
              );
              setEpoch((e) => e + 1);
            }}
          />
          <Field label="Describe the interface or a revision">
            <textarea
              rows={5}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </Field>
          <Button
            secondary
            disabled={
              busy ||
              replaying ||
              !record?.rows?.some(
                (r: any) => r.domain === domain && r.stopReason === "finish",
              )
            }
            onClick={replay}
          >
            {replaying ? "Replaying the decisions…" : "Replay recorded build"}
          </Button>
          <RunButton
            busy={busy || replaying}
            label="Compose a new interface"
            onClick={() => generate(false)}
          />
          <Button
            secondary
            disabled={busy || replaying}
            onClick={() => generate(true)}
          >
            Revise this version
          </Button>
          {busy && (
            <Button secondary onClick={() => {requestVersion.current++;controller.current?.abort();setSource("Interrupted composition");setNotice("Stopped. The partial preview is preserved.");}}>
              Stop, keep the preview
            </Button>
          )}
          <div className="preset-links">
            {[
              "Move the email field above the name.",
              "Remove the notifications switch.",
              "Keep the content, make it a horizontal layout.",
            ].map((p) => (
              <button key={p} onClick={() => setPrompt(p)}>
                {p}
              </button>
            ))}
          </div>
          <ErrorText error={error} />
          <State
            title="Inspect components and Jev decisions"
            value={{ spec, steps }}
          />
          <p className="fine">
            Powered by json-render. Prepared candidate content limits what this
            prototype can express. Form actions are local demonstrations.
          </p>
        </Pane>
      </aside>
    </div>
  );
}
