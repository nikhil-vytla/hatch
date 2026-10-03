/**
 * Three small demos of one mechanic: a single request asks Jev a yes/no question about each of
 * several authored items. The spreadsheet asks about conversations, undo about edits, change
 * impact about conclusions after a fact changes.
 */
import { useEffect, useState } from "react";
import { Changes, SemanticTable, UndoExperiment } from "./new-experiments";
import { Notice, Pills } from "./shared";
import { fetchJson } from "./api";

const TABS = ["Semantic spreadsheet", "Intent-based undo", "Change impact"] as const;

type Tab = (typeof TABS)[number];

const DATA: Record<Tab, string> = {
  "Semantic spreadsheet": "semantic-table",
  "Intent-based undo": "undo",
  "Change impact": "changes",
};

const cache = new Map<string, Promise<any>>();

const load = (name: string) => {
  if (!cache.has(name))
    cache.set(
      name,
      fetchJson(`/data/${name}.json`),
    );

  return cache.get(name) as Promise<any>;
};

export function JudgmentsScene({ record }: { record: any }) {
  const [tab, setTab] = useState<Tab>("Semantic spreadsheet");
  const [records, setRecords] = useState<Record<string, any>>({
    "semantic-table": { result: record },
  });
  const [failed, setFailed] = useState("");

  useEffect(() => {
    const name = DATA[tab];

    if (records[name]) return;

    let live = true;

    load(name)
      .then((r) => live && setRecords((all) => ({ ...all, [name]: r })))
      .catch(() => live && setFailed(name));

    return () => {
      live = false;
    };
  }, [tab, records]);

  const current = records[DATA[tab]]?.result;

  return (
    <div className="judgments-scene">
      <Pills label="View" values={[...TABS]} value={tab} onChange={(v) => setTab(v as Tab)} />
      {!current ? (
        <Notice>{failed === DATA[tab] ? "This recording could not be loaded." : "Loading…"}</Notice>
      ) : tab === "Semantic spreadsheet" ? (
        <SemanticTable record={current} />
      ) : tab === "Intent-based undo" ? (
        <UndoExperiment record={current} />
      ) : (
        <Changes record={current} />
      )}
    </div>
  );
}
