/**
 * The decoy toy: two options that trade off, and a third that is worse than one of them on both
 * counts. Nobody should pick the decoy, so it shouldn't change which of the other two wins. Every
 * number is Jev's recorded answer from the prose studies (30 Sep 2026); nothing here calls a model.
 */
import { useEffect, useMemo, useState } from "react";
import { Receipt } from "./receipt";
import { Fold, Notice, Pane, Pills } from "./shared";

type Scenario = { id: string; context: string; question: string; a: string; b: string; aDecoy: string; bDecoy: string };
type SetId = "none" | "decoy-a" | "decoy-b";
type Order = "forward" | "reversed";
type Recorded = {
  id: string;
  item: string;
  set: SetId;
  order: Order;
  request: unknown;
  probabilities: Record<string, number>;
  at?: string;
  servedBy: string | null;
  latencyMs?: number | null;
  inputTokens?: number | null;
  costUsd?: number | null;
  answers?: unknown;
};
type Data = { scenarios: Scenario[]; recorded: Recorded[] };

const ORDER_LABEL: Record<Order, string> = { forward: "A listed first", reversed: "A listed last" };

const TITLES: Record<string, string> = {
  apartment: "Apartment",
  laptop: "Laptop",
  job: "Job offer",
  car: "Car",
  "phone-plan": "Phone plan",
  restaurant: "Restaurant",
  flight: "Flight",
  hotel: "Hotel",
};

const SETS: { id: SetId; label: string }[] = [
  { id: "none", label: "Just A and B" },
  { id: "decoy-a", label: "Add a worse A" },
  { id: "decoy-b", label: "Add a worse B" },
];

const ORDERS = ["Both orders, averaged", "A listed first", "A listed last"];

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** A's share of the pair A and B, leaving the decoy out, as the study measures it. */
const pairShare = (p: Record<string, number>) => {
  const a = p.a ?? 0;
  const b = p.b ?? 0;

  return a + b > 0 ? a / (a + b) : 0.5;
};

export function Decoy() {
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);
  const [scenarioId, setScenarioId] = useState("apartment");
  const [set, setSet] = useState<SetId>("none");
  const [order, setOrder] = useState(ORDERS[0]);

  useEffect(() => {
    fetch("/decoy/decoy.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setData)
      .catch(() => setFailed(true));
  }, []);

  const rows = useMemo(() => new Map((data?.recorded ?? []).map((r) => [r.id, r])), [data]);
  const scenario = data?.scenarios.find((s) => s.id === scenarioId);
  const orders: Order[] = order === ORDERS[1] ? ["forward"] : order === ORDERS[2] ? ["reversed"] : ["forward", "reversed"];

  /** The mean over the chosen orders of a quantity read from each recorded answer; null if unrecorded. */
  const read = (item: string, s: SetId, f: (p: Record<string, number>) => number) => {
    const found = orders.flatMap((o) => {
      const r = rows.get(`decoy:${item}:${s}:${o}`);

      return r ? [f(r.probabilities)] : [];
    });

    return found.length ? found.reduce((x, y) => x + y, 0) / found.length : null;
  };

  if (!data || !scenario)
    return <Notice error={failed}>{failed ? "The recorded answers could not be loaded." : "Loading Jev's recorded answers…"}</Notice>;

  const decoyText = set === "decoy-a" ? scenario.aDecoy : set === "decoy-b" ? scenario.bDecoy : null;
  const option = (key: string) => read(scenario.id, set, (p) => p[key] ?? 0);
  const request = rows.get(`decoy:${scenario.id}:${set}:${orders[0]}`);

  const cards = [
    { key: "a", name: "A", text: scenario.a, note: "" },
    { key: "b", name: "B", text: scenario.b, note: "" },
    ...(decoyText
      ? [{ key: "d", name: "Decoy", text: decoyText, note: `Worse than ${set === "decoy-a" ? "A" : "B"} on both counts` }]
      : []),
  ];

  return (
    <div className="decoy">
      <Pills values={data.scenarios.map((s) => TITLES[s.id] ?? s.id)} value={TITLES[scenario.id] ?? scenario.id} onChange={(v) => setScenarioId(data.scenarios.find((s) => (TITLES[s.id] ?? s.id) === v)?.id ?? "apartment")} />

      <Pane title={scenario.question} sub={scenario.context}>
        <div className="decoy-sets" role="group" aria-label="Which options Jev sees">
          {SETS.map((s) => (
            <button key={s.id} type="button" className={set === s.id ? "active" : ""} aria-pressed={set === s.id} onClick={() => setSet(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="decoy-cards">
          {cards.map((c) => {
            const p = option(c.key);

            return (
              <div key={c.key} className={"decoy-card" + (c.key === "d" ? " is-decoy" : "")}>
                <span className="decoy-name">{c.name}</span>
                <p>{c.text}</p>
                {c.note && <small>{c.note}</small>}
                <div className="decoy-meter" aria-hidden>
                  <i style={{ width: pct(p ?? 0) }} />
                </div>
                <b>{p === null ? "not recorded" : `Jev: ${pct(p)}`}</b>
              </div>
            );
          })}
        </div>
        <div className="receipts">
          {orders.flatMap((o) => {
            const r = rows.get(`decoy:${scenario.id}:${set}:${o}`);

            return r
              ? [
                  <Receipt
                    key={o}
                    label={ORDER_LABEL[o]}
                    data={{
                      mode: "recorded",
                      ms: r.latencyMs,
                      questions: 1,
                      inputTokens: r.inputTokens,
                      costUsd: r.costUsd,
                      at: r.at,
                      servedBy: r.servedBy,
                      raw: { request: r.request, response: r.answers ? { answers: r.answers } : undefined },
                    }}
                  />,
                ]
              : [];
          })}
        </div>
      </Pane>

      <Pane title="A's share of the choice between A and B" sub="The decoy's own share left out">
        <div className="decoy-shift" aria-live="polite">
          {SETS.map((s) => {
            const share = read(scenario.id, s.id, pairShare);

            return (
              <button key={s.id} type="button" className={"decoy-row" + (set === s.id ? " active" : "")} onClick={() => setSet(s.id)}>
                <span>{s.label}</span>
                <span className="decoy-split" aria-hidden>
                  <i style={{ width: pct(share ?? 0) }} />
                </span>
                <b>{share === null ? "—" : `${pct(share)} A · ${pct(1 - share)} B`}</b>
              </button>
            );
          })}
        </div>
        <p className="fine">
          A decoy nobody should choose shouldn't move the split between A and B. For Jev it does: a worse A makes A
          look better, and a worse B makes B look better. People do this too; it's called the decoy or attraction
          effect (Huber, Payne &amp; Puto, 1982).
        </p>
        <Pills values={ORDERS} value={order} onChange={setOrder} />
        <p className="fine">
          Jev was asked each set twice, once in each order. Where options sit in the list matters too, so the average
          of both orders is the fairest single number.
        </p>
      </Pane>

      <Fold title="All eight scenarios">
        <div className="model-table-wrap">
          <table className="model-table">
            <thead>
              <tr>
                <th scope="col">Scenario</th>
                {SETS.map((s) => (
                  <th scope="col" key={s.id}>
                    A's share: {s.label.toLowerCase()}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.scenarios.map((s) => (
                <tr key={s.id}>
                  <th scope="row">{TITLES[s.id] ?? s.id}</th>
                  {SETS.map((x) => {
                    const v = read(s.id, x.id, pairShare);

                    return <td key={x.id}>{v === null ? "—" : pct(v)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="fine">
          In every scenario, A's share is higher next to A's decoy than next to B's: by 47 points on average (95%
          interval 38 to 56). The recorded study and its protocol are in{" "}
          <a href="https://github.com/nikhil-vytla/hatch/tree/main/jev-experiments/packages/arena/prose" target="_blank" rel="noreferrer">
            the prose studies
          </a>
          .
        </p>
      </Fold>

      {request && (
        <Fold title="The exact request Jev saw">
          <p className="fine">
            {orders.length > 1 ? "Listed with A first. " : ""}Options appear under neutral names (Ash, Birch, Cedar) so
            the letters don't hint at an order. Answered {request.at?.slice(0, 10)}
            {request.servedBy ? ` by ${request.servedBy}` : ""}.
          </p>
          <pre className="code">{JSON.stringify(request.request, null, 2)}</pre>
        </Fold>
      )}
    </div>
  );
}
