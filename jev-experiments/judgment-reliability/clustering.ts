import { hash } from "./protocol";

type ClusterPair = { source: string; original_id: string | number | null | undefined; question: string };

export const ANALYSIS_VERSION = "judge-reliability-analysis-v2.1";
export const BOOTSTRAP = { draws: 10000, seed: 73421 } as const;
export const CLUSTER_RULE = "Group every pair by source plus SHA-256 of its exact question string. This keeps repeated questions together when original_id is missing or when identical text has different source IDs. The archive is checked to contain no non-null source+ID spanning multiple question texts; such variants would require connected-component grouping.";
export const ANALYSIS_AMENDMENT = {
  id: "missing-source-id-clusters",
  date: "2026-09-20",
  reason: "The frozen source+original_id analysis grouped 312 pairs with missing IDs into three source-wide clusters. Exact-question grouping separates those questions and merges one identical-text group with different valid source IDs, without changing any recorded judgment or accuracy denominator.",
  preserved: "Frozen protocol.ts, manifest.json, cases.jsonl and append-only events.jsonl remain byte-identical. Only analysis grouping, confidence intervals and descriptive cluster counts are amended.",
} as const;

/** Preserve exact input strings: no trimming, normalization or semantic merging. */
export function sourceClusterKey(pair: ClusterPair): string {
  return JSON.stringify([pair.source, "question-sha256", hash(pair.question)]);
}

export function analysisMetadata(pairs: ClusterPair[], frozenCount: number) {
  const withId = pairs.filter(p => p.original_id != null), withoutId = pairs.filter(p => p.original_id == null);
  const idGroups = new Map<string, Set<string>>();
  for (const pair of withId) {
    const key = JSON.stringify([pair.source, String(pair.original_id)]);
    const texts = idGroups.get(key) ?? new Set<string>(); texts.add(pair.question); idGroups.set(key, texts);
  }
  const sourceIdMultipleTexts = [...idGroups.values()].filter(texts => texts.size > 1).length;
  if (sourceIdMultipleTexts) throw new Error("Source ID spans different question texts; analysis requires connected-component grouping before publication.");
  const textGroups = new Map<string, ClusterPair[]>();
  for (const pair of pairs) {
    const key = JSON.stringify([pair.source, hash(pair.question)]);
    const group = textGroups.get(key) ?? []; group.push(pair); textGroups.set(key, group);
  }
  return {
    version: ANALYSIS_VERSION,
    amendment: ANALYSIS_AMENDMENT,
    cluster_rule: CLUSTER_RULE,
    source_clusters: new Set(pairs.map(sourceClusterKey)).size,
    frozen_protocol_source_questions: frozenCount,
    pairs_with_source_id: withId.length,
    pairs_without_source_id: withoutId.length,
    nonnull_source_id_groups: idGroups.size,
    null_id_question_groups: new Set(withoutId.map(sourceClusterKey)).size,
    distinct_question_texts: textGroups.size,
    same_text_distinct_id_groups: [...textGroups.values()].filter(group => new Set(group.filter(p => p.original_id != null).map(p => String(p.original_id))).size > 1).length,
    source_id_multiple_text_groups: sourceIdMultipleTexts,
    bootstrap: BOOTSTRAP,
  };
}
