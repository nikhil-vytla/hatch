import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowRight,
  Check,
  ChevronRight,
  Coffee,
  RotateCcw,
  Sparkles,
  Undo2,
  X,
  Info,
  LoaderCircle,
  ReceiptText,
  SlidersHorizontal,
} from "lucide-react";
import { getApiKey, run } from "./api";
import {
  CONTRACT_VERSION,
  MENU_REVISION,
  CUSTOMERS,
  MENU,
  INGREDIENTS,
  FIELDS,
  VALUES,
  FIELD_LABELS,
  QUESTIONS,
  RECIPE_CATALOG,
  emptyPreferences,
  inventoryFor,
  candidates,
  constraintErrors,
  drinkName,
  facts,
  money,
  price,
  ingredients,
  usefulQuestions,
  relaxations,
  setPreference,
  publicState,
  modelQuestions,
  interpret,
  isCurrent,
  scoreCustomer,
  type Customer,
  type Family,
  type Field,
  type Inventory,
  type ModelResponse,
  type Preference,
  type Preferences,
  type PublicInput,
  type Recipe,
  type RequestTicket,
  type Turn,
} from "../../cafe-jev/engine";
import "./cafe-jev.css";

type Source = "recorded" | "live" | "manual";
type Scene = {
  transcript: Turn[];
  preferences: Preferences;
  explicit: Partial<Record<Field, Preference>>;
  inventory: Inventory;
  recipe: Recipe | null;
  source: Source;
  question: Field | null;
  response: ModelResponse | null;
  errors: string[];
  confirmed: boolean;
  customer: Customer | null;
};
type Decision = { label: string; scene: Scene };
const sourceNames: Record<Source, string> = {
  recorded: "Recorded Jev",
  live: "Live Jev",
  manual: "Your choice",
};
function fresh(customer: Customer | null = CUSTOMERS[0]): Scene {
  return {
    transcript: customer
      ? [{ id: 1, text: customer.opening, kind: "customer" }]
      : [],
    preferences: emptyPreferences(),
    explicit: {},
    inventory: inventoryFor(customer?.seed ?? 11),
    recipe: null,
    source: "manual",
    question: null,
    response: null,
    errors: [],
    confirmed: false,
    customer,
  };
}
function fromRecord(row: any): Scene {
  const input = row.input as PublicInput;
  const decision = interpret(row.response, input);
  return {
    ...fresh(CUSTOMERS.find((c) => c.id === row.customerId) ?? null),
    ...input,
    preferences: decision.preferences,
    recipe: decision.suggested,
    source: "recorded",
    question: decision.question,
    response: row.response,
    errors: decision.errors,
    confirmed: false,
  };
}

function Cup({
  recipe,
  small = false,
  pouring = false,
}: {
  recipe: Recipe;
  small?: boolean;
  pouring?: boolean;
}) {
  const id = useId().replaceAll(":", ""),
    reduce = useReducedMotion();
  const cold = recipe.temperature === "cold",
    milk = recipe.milk !== "none";
  const color = MENU[recipe.family].color;
  const cream = recipe.milk === "oat" ? "#e7d2ab" : "#fff0cf";
  return (
    <motion.svg
      className={`cafe-cup ${small ? "mini" : ""}`}
      viewBox="0 0 200 220"
      role="img"
      aria-label={`${drinkName(recipe)}, ${recipe.size}, ${recipe.sweetness} sweetness, ${recipe.shots} espresso shots`}
      animate={{ scale: recipe.size === "large" ? 1.05 : 0.92 }}
      transition={{ duration: reduce ? 0 : 0.35 }}
    >
      <defs>
        <clipPath id={`cup-${id}`}>
          <path
            d={
              cold
                ? "M52 63 L65 185 Q100 202 135 185 L148 63 Z"
                : "M45 76 L55 169 Q100 190 145 169 L155 76 Z"
            }
          />
        </clipPath>
        <linearGradient id={`glass-${id}`}>
          <stop stopColor="#fff" stopOpacity=".65" />
          <stop offset=".3" stopColor="#fff" stopOpacity=".04" />
          <stop offset="1" stopColor="#fff" stopOpacity=".32" />
        </linearGradient>
      </defs>
      <ellipse cx="101" cy="202" rx="61" ry="9" fill="#4b302819" />
      {!cold && (
        <>
          <ellipse cx="100" cy="191" rx="65" ry="8" fill="#e5d3b8" />
          <path
            d="M148 91 C194 85 185 147 148 143"
            fill="none"
            stroke="#f8ecd6"
            strokeWidth="14"
          />
          {[78, 101, 124].map((x, i) => (
            <motion.path
              key={x}
              d={`M${x} 58 q-12 -12 0 -24 q12 -12 0 -21`}
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              opacity=".3"
              animate={
                reduce ? {} : { y: [3, -6, 3], opacity: [0.15, 0.4, 0.15] }
              }
              transition={{ duration: 3, repeat: Infinity, delay: i * 0.5 }}
            />
          ))}
        </>
      )}
      {cold && (
        <path
          d="M121 92 L139 28 L158 20"
          fill="none"
          stroke="#725747"
          strokeWidth="6"
          strokeLinecap="round"
        />
      )}
      <g clipPath={`url(#cup-${id})`}>
        <rect x="40" y="60" width="120" height="140" fill={color} />
        {milk && (
          <motion.rect
            x="40"
            width="120"
            y={recipe.family === "cocoa" ? 112 : 104}
            height="100"
            fill={cream}
            animate={{ opacity: recipe.family === "cocoa" ? 0.3 : 0.88 }}
            transition={{ duration: reduce ? 0 : 0.5 }}
          />
        )}
        {recipe.shots === 2 && (
          <rect
            x="40"
            y="64"
            width="120"
            height="21"
            fill="#3e251d"
            opacity=".7"
          />
        )}
        {recipe.syrup === "vanilla" && (
          <path
            d="M62 70 Q113 105 74 149 T123 198"
            fill="none"
            stroke="#d5a35e"
            strokeWidth="8"
            opacity=".65"
          />
        )}
        <motion.g
          key={recipe.sweetness}
          initial={reduce ? {} : { y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: reduce ? 0 : 0.6 }}
        >
          {Array.from(
            {
              length:
                recipe.sweetness === "regular"
                  ? 7
                  : recipe.sweetness === "light"
                    ? 3
                    : 0,
            },
            (_, i) => (
              <circle
                key={i}
                cx={72 + ((i * 17) % 58)}
                cy={166 + (i % 3) * 8}
                r="2"
                fill="#eec76e"
                fillOpacity=".7"
              />
            ),
          )}
        </motion.g>
        {cold &&
          [
            [62, 73, -14],
            [94, 81, 8],
            [121, 69, 20],
            [83, 112, 16],
            [114, 117, -10],
          ].map(([x, y, rot], i) => (
            <motion.rect
              key={i}
              x={x}
              y={y}
              width="23"
              height="23"
              rx="5"
              transform={`rotate(${rot} ${x + 12} ${y + 12})`}
              fill="#fff"
              fillOpacity=".45"
              stroke="#fff"
              strokeOpacity=".55"
              animate={reduce ? {} : { y: [y, y + 3, y] }}
              transition={{ duration: 4, delay: i * 0.4, repeat: Infinity }}
            />
          ))}
        {!cold && (
          <ellipse
            cx="100"
            cy="78"
            rx="58"
            ry="11"
            fill={milk ? cream : color}
          />
        )}
        <rect
          x="40"
          y="58"
          width="120"
          height="145"
          fill={`url(#glass-${id})`}
        />
        {!small && (
          <g>
            <rect
              x="69"
              y="133"
              width="62"
              height="30"
              rx="4"
              fill="#fff9e8"
              fillOpacity=".92"
            />
            <text
              x="100"
              y="152"
              textAnchor="middle"
              fill="#5c644c"
              fontSize="12"
              fontFamily="Georgia, serif"
              fontWeight="bold"
            >
              café jev
            </text>
          </g>
        )}
      </g>
      <path
        d={
          cold
            ? "M52 63 L65 185 Q100 202 135 185 L148 63 Z"
            : "M45 76 L55 169 Q100 190 145 169 L155 76 Z"
        }
        fill="none"
        stroke={cold ? "#fff8e3" : "#e8d3b4"}
        strokeWidth="3"
      />
      <ellipse
        cx="100"
        cy={cold ? 64 : 76}
        rx={cold ? 48 : 55}
        ry="8"
        fill="none"
        stroke="#fff4dc"
        strokeWidth="3"
      />
      {cold &&
        !small &&
        [
          [49, 111],
          [145, 143],
          [62, 180],
        ].map(([x, y], i) => (
          <ellipse key={i} cx={x} cy={y} rx="2" ry="4" fill="#e6f1ec" />
        ))}
      {pouring && (
        <motion.path
          d="M100 0 L100 74"
          fill="none"
          stroke={color}
          strokeWidth="6"
          strokeLinecap="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: reduce ? 0 : 0.4 }}
        />
      )}
    </motion.svg>
  );
}

function Person({ customer }: { customer: Customer | null }) {
  return (
    <svg viewBox="0 0 100 110" aria-hidden="true">
      <path
        d="M15 109 Q16 65 50 65 Q84 65 86 109"
        fill={customer?.color ?? "#809280"}
      />
      <ellipse cx="50" cy="42" rx="24" ry="28" fill="#e2b28e" />
      <path
        d="M26 45 Q12 6 47 9 Q81 3 78 46 L67 24 Q44 35 26 28Z"
        fill="#49392f"
      />
      <path
        d="M38 45 h3 M59 45 h3"
        stroke="#4c3b2b"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M43 58 Q50 63 57 58"
        fill="none"
        stroke="#955e49"
        strokeWidth="2"
      />
      <path
        d="M32 78 Q50 89 68 78"
        fill="none"
        stroke="#ffffff55"
        strokeWidth="2"
      />
    </svg>
  );
}

export function Beverage({ result }: { result: any }) {
  const reducedMotion = useReducedMotion();
  const [scene, setScene] = useState<Scene>(() => fresh());
  const [mode, setMode] = useState<Source>("recorded");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false),
    [preparing, setPreparing] = useState(false),
    [error, setError] = useState("");
  const [history, setHistory] = useState<Scene[]>([]),
    [decisions, setDecisions] = useState<Decision[]>([]);
  const [preferenceEditor, setPreferenceEditor] = useState(false),
    [revealed, setRevealed] = useState(false);
  const current = useRef<RequestTicket>({ session: 1, revision: 0 });
  const request = useRef<AbortController | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    initialized = useRef(false);
  const rows: any[] = Array.isArray(result?.rows)
    ? result.rows.filter(
        (r: any) => r.response && r.contractVersion === CONTRACT_VERSION,
      )
    : [];
  function invalidate() {
    current.current = {
      ...current.current,
      revision: current.current.revision + 1,
    };
    request.current?.abort();
    request.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setBusy(false);
    setPreparing(false);
  }
  function commit(next: Scene, label: string, remember = true) {
    invalidate();
    setError("");
    setRevealed(false);
    if (remember) setHistory((h) => [...h, scene]);
    setScene(next);
    setDecisions((d) => [...d, { label, scene: next }]);
  }
  function replay(row: any, preserveMode = false) {
    invalidate();
    current.current = { session: current.current.session + 1, revision: 0 };
    const next = fromRecord(row);
    setScene(next);
    setHistory([]);
    setDraft("");
    setError("");
    setRevealed(false);
    if (!preserveMode) setMode("recorded");
    setDecisions([{ label: `Recorded request · ${row.id}`, scene: next }]);
  }
  useEffect(() => {
    if (!initialized.current && rows.length) {
      initialized.current = true;
      replay(rows.find((r) => r.customerId === "mina") ?? rows[0]);
    }
  }, [result]);
  useEffect(
    () => {
      setBusy(false);
      setPreparing(false);
      return () => invalidate();
    },
    [],
  );

  const feasible = candidates(scene.preferences, scene.inventory);
  const validQuestions = usefulQuestions(scene.preferences, feasible);
  const question =
    scene.question && validQuestions.includes(scene.question)
      ? scene.question
      : (validQuestions[0] ?? null);
  const questionFromModel =
    scene.question === question && scene.source !== "manual";
  const blockers = scene.recipe
    ? [
        ...constraintErrors(scene.recipe, scene.preferences, scene.inventory),
        ...(scene.customer && !scene.response
          ? ["Interpret the customer's opening request first"]
          : []),
      ]
    : ["Choose a drink first"];
  const recipe = scene.recipe;
  const unknown = FIELDS.filter(
    (f) => scene.preferences[f].status === "unknown",
  );
  const score =
    scene.confirmed && recipe && scene.customer
      ? scoreCustomer(scene.customer, recipe, scene.inventory)
      : null;
  const supports = (family: Family) =>
    feasible.filter((r) => r.family === family);
  const turnFor = (text: string): Turn => ({
    id: scene.transcript.length + 1,
    text,
    kind: "choice",
  });

  function answer(
    field: Field,
    value: string,
    status: "required" | "preferred" = "required",
  ) {
    if (scene.transcript.length >= 12) {
      setError(
        "This visit has reached 12 turns. Start a new customer to continue.",
      );
      return;
    }
    const turn = turnFor(
      `${FIELD_LABELS[field]}: ${status === "preferred" ? "I prefer" : "I require"} ${VALUES[field][value]}.`,
    );
    const preferences = setPreference(
      scene.preferences,
      field,
      value,
      turn,
      status,
    );
    const available = candidates(preferences, scene.inventory);
    const nextRecipe =
      scene.recipe &&
      !constraintErrors(scene.recipe, preferences, scene.inventory).length
        ? scene.recipe
        : null;
    commit(
      {
        ...scene,
        preferences,
        explicit: { ...scene.explicit, [field]: preferences[field] },
        transcript: [...scene.transcript, turn],
        recipe: nextRecipe,
        source: "manual",
        question: usefulQuestions(preferences, available)[0] ?? null,
        confirmed: false,
      },
      `${FIELD_LABELS[field]} · ${VALUES[field][value]}`,
    );
  }
  function selectRecipe(next: Recipe, label: string) {
    if (constraintErrors(next, scene.preferences, scene.inventory).length)
      return;
    commit(
      { ...scene, recipe: next, source: "manual", confirmed: false },
      label,
    );
  }
  function clearPreference(field: Field) {
    if (scene.transcript.length >= 12) {
      setError(
        "This visit has reached 12 turns. Start a new customer to continue.",
      );
      return;
    }
    const turn = turnFor(
      `I no longer have a requirement or preference about ${FIELD_LABELS[field].toLowerCase()}.`,
    );
    const preference: Preference = {
      status: "unknown",
      value: null,
      sourceTurn: turn.id,
      evidence: turn.text,
    };
    const preferences = { ...scene.preferences, [field]: preference };
    commit(
      {
        ...scene,
        preferences,
        explicit: { ...scene.explicit, [field]: preference },
        transcript: [...scene.transcript, turn],
        source: "manual",
        recipe: null,
        confirmed: false,
      },
      `Relaxed ${FIELD_LABELS[field]}`,
    );
  }
  async function askJev() {
    if (!getApiKey()) {
      setError(
        "Connect your Vercel AI Gateway key using the key control above, then try again.",
      );
      return;
    }
    if (scene.transcript.length >= 12 && draft.trim()) {
      setError(
        "This visit has reached 12 turns. Start a new customer to continue.",
      );
      return;
    }
    invalidate();
    const ticket = { ...current.current };
    const aborter = new AbortController();
    request.current = aborter;
    const transcript: Turn[] = draft.trim()
      ? [
          ...scene.transcript,
          {
            id: scene.transcript.length + 1,
            text: draft.trim(),
            kind: "customer",
          },
        ]
      : scene.transcript;
    if (!transcript.length) {
      setError("Tell the barista what you have in mind first.");
      return;
    }
    const input = {
      transcript,
      inventory: scene.inventory,
      explicit: scene.explicit,
    };
    setBusy(true);
    setError("");
    try {
      const response = await run(
        publicState(input),
        modelQuestions(),
        aborter.signal,
      );
      if (aborter.signal.aborted || !isCurrent(ticket, current.current)) return;
      const interpreted = interpret(response, input);
      commit(
        {
          ...scene,
          ...input,
          preferences: interpreted.preferences,
          recipe: interpreted.suggested,
          question: interpreted.question,
          source: "live",
          response,
          errors: interpreted.errors,
          confirmed: false,
        },
        `Live Jev · turn ${transcript.length}`,
      );
      setDraft("");
    } catch (e) {
      if (isCurrent(ticket, current.current) && !aborter.signal.aborted)
        setError(
          e instanceof Error
            ? e.message
            : "Jev could not finish this request. Your draft is preserved.",
        );
    } finally {
      if (isCurrent(ticket, current.current)) {
        setBusy(false);
        request.current = null;
      }
    }
  }
  function changeCustomer(id: string) {
    const customer = CUSTOMERS.find((c) => c.id === id) ?? null;
    const recorded = rows.find((r) => r.customerId === id);
    if (recorded) {
      replay(recorded, true);
      return;
    }
    invalidate();
    current.current = { session: current.current.session + 1, revision: 0 };
    const next = fresh(customer);
    setScene(next);
    setHistory([]);
    setDecisions([{ label: "Customer arrived", scene: next }]);
    setDraft("");
    setError("");
    setRevealed(false);
  }
  function undo() {
    const last = history.at(-1);
    if (!last) return;
    invalidate();
    setScene(last);
    setHistory((h) => h.slice(0, -1));
    setDecisions((d) => [
      ...d,
      { label: "Undid the last choice", scene: last },
    ]);
    setDraft("");
    setError("");
  }
  function confirm() {
    if (!recipe || blockers.length || draft.trim()) return;
    invalidate();
    const ticket = { ...current.current };
    setPreparing(true);
    timer.current = setTimeout(
      () => {
        if (!isCurrent(ticket, current.current)) return;
        commit({ ...scene, confirmed: true }, "Confirmed simulated order");
      },
      reducedMotion ? 0 : 1100,
    );
  }
  const displayRecipe =
    recipe ?? feasible[0] ?? RECIPE_CATALOG.find((r) => r.family === "tea")!;
  const totalRecorded = result?.coverage?.completed ?? rows.length;
  return (
    <div className="cafe-jev">
      <div className="cafe-toolbar">
        <div className="cafe-wordmark">
          <Coffee size={19} />
          <span>café jev</span>
          <i>OPEN FOR EXPERIMENTS</i>
        </div>
        <div className="cafe-mode" role="group" aria-label="How to order">
          {(["recorded", "live", "manual"] as const).map((m) => (
            <button
              key={m}
              className={mode === m ? "active" : ""}
              aria-pressed={mode === m}
              onClick={() => {
                invalidate();
                setMode(m);
                setError("");
              }}
            >
              {m === "recorded"
                ? "Replay"
                : m === "live"
                  ? "Live Jev"
                  : "Order yourself"}
            </button>
          ))}
        </div>
      </div>
      <div className="cafe-layout">
        <div className="cafe-main">
          <section className="cafe-scene" aria-label="Cafe counter">
            <div className="cafe-scene-top">
              <span>GOOD DRINKS. A LITTLE CURIOSITY.</span>
              <span className="cafe-source">
                <span className={`cafe-dot ${scene.source}`} />
                {sourceNames[scene.source]}
              </span>
            </div>
            <div className="cafe-wall-art" aria-hidden="true">
              <span>
                TAKE
                <br />
                YOUR
                <br />
                <i>time.</i>
              </span>
            </div>
            <div className="cafe-window" aria-hidden="true">
              <div />
              <i />
              <b />
            </div>
            <div className="cafe-plant" aria-hidden="true">
              <i />
              <i />
              <i />
              <b />
            </div>
            <AnimatePresence mode="wait">
              <motion.div
                key={`${scene.customer?.id ?? "you"}-${scene.confirmed}`}
                className="cafe-customer"
                initial={{ opacity: 0, x: reducedMotion ? 0 : -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reducedMotion ? 0 : 0.3 }}
              >
                <div className="cafe-bubble">
                  <span>
                    {scene.customer?.name ?? "Your visit"}{" "}
                    {scene.confirmed ? "at the counter" : "says"}
                  </span>
                  <p>
                    {scene.confirmed
                      ? score?.success
                        ? "That's just what I had in mind. Thank you!"
                        : score
                          ? "Let's see how that fits what I wanted."
                          : "One drink, made your way."
                      : (scene.transcript.at(-1)?.text ??
                        "I'll take a look at the menu.")}
                  </p>
                </div>
                <Person customer={scene.customer} />
              </motion.div>
            </AnimatePresence>
            <div className="cafe-counter">
              <span className="cafe-counter-line" />
              <div className="cafe-napkin" />
              <motion.div
                className={`cafe-hero-cup ${!recipe ? "preview" : ""}`}
                layout
                transition={{ duration: reducedMotion ? 0 : 0.3 }}
              >
                <Cup recipe={displayRecipe} pouring={preparing} />
              </motion.div>
              <div className="cafe-drink-label">
                <span>
                  {preparing
                    ? "MAKING YOUR DRINK"
                    : scene.confirmed
                      ? "READY FOR PICKUP"
                      : recipe
                        ? "ON YOUR TRAY"
                        : "A LITTLE INSPIRATION"}
                </span>
                <h3>
                  {recipe ? drinkName(recipe) : "Find your kind of good."}
                </h3>
                {recipe && (
                  <p>
                    {money(price(recipe))} · {recipe.size} ·{" "}
                    {facts(recipe).caffeine} mg caffeine
                  </p>
                )}
              </div>
            </div>
          </section>

          <div className="cafe-visit-bar">
            <label>
              Today's customer
              <select
                aria-label="Customer"
                value={scene.customer?.id ?? "you"}
                onChange={(e) => changeCustomer(e.target.value)}
              >
                {CUSTOMERS.map((c) => (
                  <option value={c.id} key={c.id}>
                    {c.name}
                    {c.id === "ro" ? " · oat milk sold out" : ""}
                  </option>
                ))}
                <option value="you">You · a fresh order</option>
              </select>
            </label>
            <div>
              <button
                className="cafe-icon-button"
                onClick={undo}
                disabled={!history.length}
                title="Undo last choice"
              >
                <Undo2 size={16} />
                Undo
              </button>
              <button
                className="cafe-icon-button"
                onClick={() => changeCustomer(scene.customer?.id ?? "you")}
                title="Restart this visit"
              >
                <RotateCcw size={15} />
                Restart
              </button>
            </div>
          </div>

          {mode === "recorded" && (
            <div className="cafe-replay-control">
              <label>
                <span>Recorded customer request</span>
                <select
                  aria-label="Recorded request"
                  value={
                    rows.find((r) => r.response === scene.response)?.id ?? ""
                  }
                  onChange={(e) => {
                    const row = rows.find((r) => r.id === e.target.value);
                    if (row) replay(row);
                  }}
                >
                  <option value="" disabled>
                    Choose a recorded request
                  </option>
                  {rows
                    .filter((r) => r.category !== "finite-partial-state")
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.id.replaceAll("_", " ").replaceAll("-", " ")}
                      </option>
                    ))}
                </select>
              </label>
              <span>{totalRecorded} genuine Jev cases. No key needed.</span>
            </div>
          )}

          <section className="cafe-menu" aria-label="Drink menu">
            <div className="cafe-section-heading">
              <div>
                <span className="cafe-eyebrow">THE MENU</span>
                <h3>What sounds good?</h3>
              </div>
              <span>{feasible.length} recipes fit</span>
            </div>
            <div className="cafe-menu-grid">
              {(Object.keys(MENU) as Family[]).map((family) => {
                const base = MENU[family],
                  available = supports(family),
                  suggested = available[0];
                const drawing =
                  suggested ??
                  RECIPE_CATALOG.filter((r) => r.family === family).sort(
                    (a, b) =>
                      constraintErrors(a, scene.preferences, scene.inventory)
                        .length -
                        constraintErrors(b, scene.preferences, scene.inventory)
                          .length || price(a) - price(b),
                  )[0];
                const selected = recipe?.family === family;
                const unavailableReason = !available.length
                  ? (constraintErrors(
                      drawing,
                      scene.preferences,
                      scene.inventory,
                    )[0] ?? "No recipe meets these preferences")
                  : null;
                return (
                  <motion.button
                    layout
                    key={family}
                    transition={{ duration: reducedMotion ? 0 : 0.3 }}
                    className={`cafe-menu-card ${selected ? "selected" : ""} ${!available.length ? "unavailable" : ""}`}
                    aria-pressed={selected}
                    aria-disabled={!available.length}
                    onClick={() =>
                      suggested
                        ? selectRecipe(suggested, `Chose ${base.name}`)
                        : setError(unavailableReason ?? "No matching recipe")
                    }
                  >
                    <div
                      className="cafe-menu-illustration"
                      style={{ "--drink-color": base.color } as CSSProperties}
                    >
                      <Cup recipe={drawing} small />
                      {selected && (
                        <span className="cafe-selected-check">
                          <Check size={12} />
                        </span>
                      )}
                    </div>
                    <strong>{base.name}</strong>
                    <p>{base.description}</p>
                    <span>
                      {suggested
                        ? `from ${money(price(suggested))}`
                        : "Doesn't fit yet"}
                    </span>
                    <small>
                      {unavailableReason ??
                        `${drawing.temperature} · ${facts(drawing).caffeine} mg · ${drawing.sweetness === "none" ? "unsweetened" : `${drawing.sweetness} sweetness`}`}
                    </small>
                  </motion.button>
                );
              })}
            </div>
          </section>

          <section
            className="cafe-conversation"
            aria-label="Conversation with the barista"
          >
            <div className="cafe-barista">
              <span>
                <Sparkles size={17} />
              </span>
              <div>
                <h3>
                  {!feasible.length
                    ? "Let's find a way to make it work."
                    : question
                      ? QUESTIONS[question]
                      : recipe
                        ? "This one looks like a good fit."
                        : "Take your pick. I'll make it yours."}
                </h3>
                <p>
                  {question
                    ? questionFromModel
                      ? `${sourceNames[scene.source]} chose this question.`
                      : "The menu can narrow down with one more choice."
                    : !feasible.length
                      ? "No recipe meets all the current requirements and stock."
                      : "Pick a drink above, then adjust the details."}
                </p>
              </div>
            </div>
            {question && (
              <div className="cafe-answer-chips">
                {Object.entries(VALUES[question])
                  .filter(([v]) => v !== "unsupported")
                  .map(([value, label]) => (
                    <button key={value} onClick={() => answer(question, value)}>
                      {label}
                      <ArrowRight size={12} />
                    </button>
                  ))}
              </div>
            )}
            {!feasible.length && (
              <div className="cafe-substitutions">
                {relaxations(scene.preferences, scene.inventory).map(
                  ({ field, count }) => (
                    <button key={field} onClick={() => clearPreference(field)}>
                      Relax {FIELD_LABELS[field].toLowerCase()}{" "}
                      <span>{count} recipes</span>
                    </button>
                  ),
                )}
                {!relaxations(scene.preferences, scene.inventory).length &&
                  !question && (
                    <p>
                      Change more than one requirement using the preference
                      controls below.
                    </p>
                  )}
              </div>
            )}
            {mode === "live" && (
              <div className="cafe-say">
                <label htmlFor="cafe-request">
                  Tell the barista a little more
                </label>
                <textarea
                  id="cafe-request"
                  rows={2}
                  value={draft}
                  maxLength={1800}
                  placeholder="Actually, make it iced. And keep it under four dollars."
                  onChange={(e) => {
                    invalidate();
                    setDraft(e.target.value);
                    setError("");
                  }}
                />
                <div>
                  <span>
                    {draft.trim()
                      ? "Your edited request hasn't been interpreted yet."
                      : "Jev sees the public conversation and menu."}
                  </span>
                  <button
                    className="cafe-primary"
                    onClick={askJev}
                    disabled={busy}
                  >
                    {busy ? (
                      <LoaderCircle size={15} className="spin" />
                    ) : (
                      <Sparkles size={15} />
                    )}{" "}
                    {busy
                      ? "Asking the barista…"
                      : scene.response
                        ? "Ask Jev again"
                        : "Ask Jev"}
                  </button>
                </div>
              </div>
            )}
            <button
              className="cafe-preference-toggle"
              aria-expanded={preferenceEditor}
              onClick={() => setPreferenceEditor(!preferenceEditor)}
            >
              <SlidersHorizontal size={14} />
              {preferenceEditor
                ? "Close preference controls"
                : "Set or revise your preferences"}
              <ChevronRight size={13} />
            </button>
            {preferenceEditor && (
              <div className="cafe-preferences">
                {FIELDS.map((field) => (
                  <label key={field}>
                    <span>{FIELD_LABELS[field]}</span>
                    <select
                      aria-label={FIELD_LABELS[field]}
                      value={scene.preferences[field].value ?? ""}
                      onChange={(e) =>
                        e.target.value
                          ? answer(field, e.target.value)
                          : clearPreference(field)
                      }
                    >
                      <option value="">
                        {scene.preferences[field].status === "conflicting"
                          ? "Resolve: no preference"
                          : "No preference"}
                      </option>
                      {Object.entries(VALUES[field])
                        .filter(([v]) => v !== "unsupported")
                        .map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                    </select>
                  </label>
                ))}
              </div>
            )}
          </section>
        </div>

        <aside className="cafe-order">
          <div className="cafe-order-heading">
            <span className="cafe-eyebrow">YOUR LITTLE PICK-ME-UP</span>
            <h2>{scene.confirmed ? "Made for you." : "Make it yours."}</h2>
            <p>
              {scene.confirmed
                ? "A receipt for this fictional visit."
                : "Choose a base. We'll keep the recipe possible."}
            </p>
          </div>
          {recipe ? (
            <>
              <div className="cafe-order-name">
                <span>
                  <Coffee size={18} />
                </span>
                <div>
                  <h3>{drinkName(recipe)}</h3>
                  <p>
                    {sourceNames[scene.source]} · {facts(recipe).caffeine} mg
                    caffeine
                  </p>
                </div>
              </div>
              {!scene.confirmed && (
                <div className="cafe-customize">
                  {(
                    [
                      [
                        "temperature",
                        "Serve it",
                        MENU[recipe.family].temperatures,
                      ],
                      ["milk", "Milk", MENU[recipe.family].milks],
                      ["sweetness", "Sweetness", MENU[recipe.family].sweetness],
                      ["size", "Size", ["small", "large"]],
                      ["shots", "Espresso shots", MENU[recipe.family].shots],
                      [
                        "syrup",
                        "Flavor",
                        MENU[recipe.family].syrup
                          ? ["none", "vanilla"]
                          : ["none"],
                      ],
                    ] as [keyof Recipe, string, (string | number)[]][]
                  ).map(([key, label, values]) => (
                    <fieldset key={key}>
                      <legend>{label}</legend>
                      <div>
                        {values.map((value) => {
                          const next = { ...recipe, [key]: value } as Recipe;
                          // Removing sweetness also removes the sweetened syrup. This is a
                          // visible recipe revision, never an extra hidden price change.
                          if (key === "sweetness" && value === "none")
                            next.syrup = "none";
                          const errors = constraintErrors(
                            next,
                            scene.preferences,
                            scene.inventory,
                          );
                          const text =
                            key === "milk" && value === "none"
                              ? "No milk"
                              : key === "shots"
                                ? `${value}`
                                : key === "syrup" && value === "none"
                                  ? "Original"
                                  : String(value);
                          return (
                            <button
                              key={value}
                              disabled={errors.length > 0}
                              aria-pressed={recipe[key] === value}
                              className={recipe[key] === value ? "active" : ""}
                              title={
                                errors.join(". ") ||
                                `${text}, ${money(price(next))}`
                              }
                              onClick={() =>
                                selectRecipe(
                                  next,
                                  `Changed ${label.toLowerCase()} to ${text}`,
                                )
                              }
                            >
                              {text}
                              {key === "milk" &&
                                value !== "none" &&
                                !scene.inventory[value as keyof Inventory] && (
                                  <small>sold out</small>
                                )}
                            </button>
                          );
                        })}
                      </div>
                    </fieldset>
                  ))}
                  <p className="cafe-customize-note">
                    Dimmed choices conflict with your requirements or today's
                    stock. Change a requirement below the conversation to use
                    them.
                  </p>
                </div>
              )}
              <div
                className={`cafe-receipt ${scene.confirmed ? "confirmed" : ""}`}
              >
                <div className="cafe-receipt-brand">
                  café jev <ReceiptText size={16} />
                </div>
                <p>
                  {scene.confirmed
                    ? "THANKS FOR STOPPING BY"
                    : "YOUR ORDER SO FAR"}
                </p>
                <dl>
                  <div>
                    <dt>{MENU[recipe.family].name}</dt>
                    <dd>{money(MENU[recipe.family].cents)}</dd>
                  </div>
                  {recipe.milk !== "none" && (
                    <div>
                      <dt>{INGREDIENTS[recipe.milk].name}</dt>
                      <dd>+{money(INGREDIENTS[recipe.milk].cents)}</dd>
                    </div>
                  )}
                  {recipe.size === "large" && (
                    <div>
                      <dt>Large cup</dt>
                      <dd>+$1.00</dd>
                    </div>
                  )}
                  {recipe.shots > 1 && (
                    <div>
                      <dt>Extra espresso shot</dt>
                      <dd>+$0.75</dd>
                    </div>
                  )}
                  {recipe.syrup === "vanilla" && (
                    <div>
                      <dt>Vanilla syrup</dt>
                      <dd>+$0.50</dd>
                    </div>
                  )}
                </dl>
                <div className="cafe-total">
                  <span>Total</span>
                  <strong>{money(price(recipe))}</strong>
                </div>
                <small>
                  {recipe.temperature} · {recipe.size} ·{" "}
                  {recipe.sweetness === "none"
                    ? "unsweetened"
                    : `${recipe.sweetness} sweetness`}
                </small>
              </div>
              {!scene.confirmed ? (
                <button
                  className="cafe-primary cafe-confirm"
                  disabled={
                    blockers.length > 0 || !!draft.trim() || busy || preparing
                  }
                  onClick={confirm}
                >
                  {preparing ? (
                    <LoaderCircle size={17} className="spin" />
                  ) : (
                    <Check size={17} />
                  )}{" "}
                  {preparing ? "Making your drink…" : "Make this drink"}
                </button>
              ) : (
                <div className="cafe-order-complete" role="status">
                  <Check size={18} />
                  <span>
                    {score
                      ? score.success
                        ? "The customer is happy with this order."
                        : score.goalFeasible
                          ? "The recipe is legal. The customer's goal wasn't met."
                          : "The customer's goal wasn't possible with today's stock."
                      : "Your simulated order is ready."}
                  </span>
                </div>
              )}
            </>
          ) : (
            <div className="cafe-empty-order">
              <div>
                <Coffee size={36} />
                <span>+ YOUR IDEAL DRINK</span>
              </div>
              <h3>A good drink starts here.</h3>
              <p>
                {!feasible.length
                  ? "Resolve the requirements or choose a substitution to open up the menu."
                  : "Pick a menu card to start your order, or let Jev interpret what you have in mind."}
              </p>
            </div>
          )}
          <p className="cafe-fiction">
            A fictional cafe. No purchase, payment or real order. Ingredient and
            caffeine facts belong to this menu only.
          </p>
          {score && (
            <div className="cafe-goal">
              <button
                onClick={() => setRevealed(!revealed)}
                aria-expanded={revealed}
              >
                {revealed ? "Hide" : "Reveal"} the customer's private goal{" "}
                <ChevronRight size={14} />
              </button>
              {revealed && (
                <div>
                  <p>This goal stayed outside Jev's request.</p>
                  {Object.entries(score.hiddenGoal).map(([f, v]) => (
                    <span
                      key={f}
                      className={score.missed.includes(f) ? "missed" : ""}
                    >
                      {FIELD_LABELS[f as Field]} · {VALUES[f as Field][v!]}
                    </span>
                  ))}
                  <small>
                    {score.acceptableRecipes} legal recipes could meet this
                    goal.
                  </small>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>

      {error && (
        <div className="cafe-alert" role="alert">
          <Info size={17} />
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            <X size={15} />
          </button>
        </div>
      )}
      {scene.customer && !scene.response && (
        <div className="cafe-alert" role="status">
          <Info size={17} />
          <span>
            The customer's opening request needs interpretation before
            confirmation. Ask Live Jev, replay a recorded visit, or choose You
            for a fresh manual order.
          </span>
        </div>
      )}
      {draft.trim() && mode !== "live" && (
        <div className="cafe-alert" role="status">
          <Info size={17} />
          <span>
            An edited request is waiting. Return to Live Jev to interpret it, or
            discard that edit before confirming.
          </span>
          <button
            onClick={() => {
              invalidate();
              setDraft("");
            }}
          >
            Discard edit
          </button>
        </div>
      )}
      <div className="cafe-understanding">
        <div>
          <span className="cafe-eyebrow">WHAT WE HEARD</span>
          <span>
            {scene.source === "manual"
              ? "Explicit menu choices"
              : "Jev's interpretation"}
          </span>
        </div>
        <div className="cafe-understanding-chips">
          {FIELDS.filter((f) => scene.preferences[f].status !== "unknown").map(
            (field) => {
              const p = scene.preferences[field];
              return (
                <span
                  key={field}
                  className={p.status === "conflicting" ? "conflict" : ""}
                  title={p.evidence ?? ""}
                >
                  <b>{FIELD_LABELS[field]}</b>{" "}
                  {p.status === "conflicting"
                    ? "needs clarification"
                    : VALUES[field][p.value!]}
                  <i>{p.status}</i>
                </span>
              );
            },
          )}
          {unknown.length > 0 && (
            <small>
              Still open:{" "}
              {unknown.map((f) => FIELD_LABELS[f].toLowerCase()).join(", ")}.
            </small>
          )}
        </div>
      </div>
      {scene.errors.length > 0 && (
        <div className="cafe-guard-note">
          <Info size={16} />
          <p>
            Jev made {scene.errors.length === 1 ? "a decision" : "decisions"}{" "}
            the menu couldn't support. The original output is preserved below.
            Choose from the legal menu to continue.
          </p>
        </div>
      )}
      <details className="cafe-inspector">
        <summary>
          Behind the counter{" "}
          <span>Conversation, decisions & recorded evidence</span>
        </summary>
        <div className="cafe-inspector-grid">
          <section>
            <h3>The conversation</h3>
            <ol>
              {scene.transcript.map((t) => (
                <li key={t.id}>
                  <span>
                    Turn {t.id} ·{" "}
                    {t.kind === "choice" ? "explicit choice" : "customer"}
                  </span>
                  <p>{t.text}</p>
                </li>
              ))}
            </ol>
            <h3>Replay your decisions</h3>
            <div className="cafe-timeline">
              {decisions.map((d, i) => (
                <button
                  key={i}
                  onClick={() => {
                    setDraft("");
                    commit(d.scene, `Replayed decision ${i + 1}`);
                  }}
                >
                  {i + 1}. {d.label}
                </button>
              ))}
            </div>
          </section>
          <section>
            <h3>Evidence, without the private goal</h3>
            <p>
              {totalRecorded} of {result?.coverage?.planned ?? 102} declared
              requests completed. This is an authored development fixture. It
              does not establish accuracy on real cafe customers.
            </p>
            <p>
              Model extraction exact match:{" "}
              {result?.metrics?.extractionExact?.numerator ?? "?"}/
              {result?.metrics?.extractionExact?.denominator ?? "?"}. Provider
              failures are tracked separately. Structural guards cannot prove
              that Jev understood the customer correctly.
            </p>
            <pre>
              {JSON.stringify(
                {
                  contractVersion: CONTRACT_VERSION,
                  menuRevision: MENU_REVISION,
                  source: scene.source,
                  transcript: scene.transcript,
                  preferences: scene.preferences,
                  question,
                  questionSource: questionFromModel
                    ? scene.source
                    : "deterministic menu split",
                  legalRecipes: feasible.length,
                  stock: scene.inventory,
                  recipe,
                  ingredients: recipe
                    ? ingredients(recipe).map((i) => INGREDIENTS[i].name)
                    : [],
                  rawModel: scene.response,
                  guardRejections: scene.errors,
                },
                null,
                2,
              )}
            </pre>
            <details>
              <summary>Fictional menu and ingredient facts</summary>
              <pre>
                {JSON.stringify(
                  { menu: MENU, ingredients: INGREDIENTS },
                  null,
                  2,
                )}
              </pre>
            </details>
          </section>
        </div>
      </details>
    </div>
  );
}
