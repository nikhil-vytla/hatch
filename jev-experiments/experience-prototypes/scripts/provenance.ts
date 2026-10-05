/**
 * Steps that add provenance to a recorded result before it is published. Each published record
 * names its steps in the publication manifest; the integrity index lists them as its recipe.
 * Steps only add fields: publication verification checks every recorded value survives.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { preparePublicResult } from "../../rewardbench2/publication";

/** One change to a record's `result`, named for the integrity index. `lab` is jev-experiments/. */
export type Step = { readonly name: string; apply(result: any, lab: string): void };

const bankingRevision = "57ec275d8078af65b7731c2a98be812d844a6d6b";
const banking = {
  name: "BANKING77",
  organization: "PolyAI",
  revision: bankingRevision,
  url: `https://github.com/PolyAI-LDN/task-specific-datasets/tree/${bankingRevision}/banking_data`,
  sampling:
    "Recorded subsets of public banking utterances. See case IDs and the full evidence record for splits and labels.",
};

/** The BANKING77 source, with this record's sampling note when it differs. */
export const banking77 = (sampling = banking.sampling): Step => ({
  name: "banking77",
  apply(result) {
    result.provenance = [{ ...banking, sampling }];
  },
});

/** CLINC150 after BANKING77, at the commit the record pinned. */
export const clinc150: Step = {
  name: "clinc150",
  apply(result) {
    const revision = (result.sources ?? {})["clinc/oos-eval"]?.commit;
    result.provenance.push({
      name: "CLINC150",
      organization: "CLINC",
      revision,
      url: `https://github.com/clinc/oos-eval/tree/${revision}/data`,
      sampling:
        "Recorded test examples include unsupported requests labeled out of scope. These are supplied dataset utterances.",
    });
  },
};

export const judgeBench: Step = {
  name: "judgeBench",
  apply(result) {
    const revision = (result.sources ?? {})["ScalerLab/JudgeBench"]?.commit;
    result.provenance = {
      name: "JudgeBench",
      organization: "ScalerLab",
      revision,
      url: `https://github.com/ScalerLab/JudgeBench/tree/${revision}`,
      sampling:
        "100 sampled candidate pairs, evaluated in both answer orders. Upstream supplies the expected winner; the response model is shown for each case.",
    };
  },
};

/** Content notices from the prior dataset review, for the rows it flagged in this dataset. */
export const priorContentAudit = (dataset: "classify" | "judge"): Step => ({
  name: "priorContentAudit",
  apply(result, lab) {
    const auditPath = resolve(lab, "rewardbench2/prior-content-audit.json");
    if (!existsSync(auditPath)) return;
    const audit = JSON.parse(readFileSync(auditPath, "utf8"));
    for (const finding of audit.findings.filter((f: any) => f.dataset === dataset)) {
      const notice = {
        categories: finding.categories,
        note: finding.explanation,
        level: finding.severity,
        method:
          "GPT-5.6 Sol contextual review after lexical screening; not an exhaustive moderation guarantee.",
      };
      if (dataset === "classify") {
        const row = result.experiments.clinc150.rows[finding.row_id];
        if (!row) throw Error("Audited CLINC150 row is missing");
        row.content_notice = notice;
      } else
        for (const row of result.rows)
          if (finding.row_ids?.includes(row.id)) row.content_notice = notice;
    }
  },
});

/** RewardBench 2: public result fields, the repeatability checks and its own content review. */
export const rewardBench: Step = {
  name: "rewardBench",
  apply(result, lab) {
    preparePublicResult(result);
    result.repeatability = {
      initial: JSON.parse(
        readFileSync(resolve(lab, "rewardbench2/isolation-check.json"), "utf8"),
      ),
      controls: JSON.parse(
        readFileSync(resolve(lab, "rewardbench2/repeat-check.json"), "utf8"),
      ),
    };
    const path = resolve(lab, "rewardbench2/content-audit/audit.json");
    const audit = JSON.parse(readFileSync(path, "utf8"));
    const byId = new Map(
      audit.findings.map((f: any) => [`${f.subset}:${f.id}`, f]),
    );
    for (const row of result.rows) {
      const finding: any = byId.get(`${row.subset}:${row.id}`);
      if (finding)
        row.content_notice = {
          categories: finding.categories,
          note: finding.note,
          level: finding.level,
        };
    }
    result.content_review = {
      model: audit.model,
      method: audit.method,
      coverage: audit.coverage,
      flagged_non_safety_cases: audit.findings.length,
      safety_display:
        "All Safety cases require deliberate reveal. No cases are excluded from scoring.",
    };
  },
};

/** How many planned rows completed and how many came back with an error. */
export const availability: Step = {
  name: "availability",
  apply(result) {
    const rows = result.rows ?? result.scenes ?? [];
    result.availability = {
      planned: rows.length,
      completed: rows.filter((row: any) => !row.error).length,
      unavailable: rows.filter((row: any) => !!row.error).length,
    };
  },
};
