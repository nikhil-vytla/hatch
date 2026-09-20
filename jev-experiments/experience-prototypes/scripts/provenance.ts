import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { preparePublicResult } from "../../rewardbench2/publication";

const bankingRevision = "57ec275d8078af65b7731c2a98be812d844a6d6b";
const banking = {
  name: "BANKING77",
  organization: "PolyAI",
  revision: bankingRevision,
  url: `https://github.com/PolyAI-LDN/task-specific-datasets/tree/${bankingRevision}/banking_data`,
  sampling:
    "Recorded subsets of public banking utterances. See case IDs and the full evidence record for splits and labels.",
};
export function enrichProvenance(name: string, result: any, lab: string) {
  const sources = result.sources ?? {};
  if (["classify", "robustness", "optimize", "replica"].includes(name)) {
    result.provenance = [
      {
        ...banking,
        sampling:
          name === "robustness"
            ? "BANKING77 requests with authored distractors, reordered choices, repetitions, and prompt-injection variants."
            : banking.sampling,
      },
    ];
    if (name === "classify") {
      const revision = sources["clinc/oos-eval"]?.commit;
      result.provenance.push({
        name: "CLINC150",
        organization: "CLINC",
        revision,
        url: `https://github.com/clinc/oos-eval/tree/${revision}/data`,
        sampling:
          "Recorded test examples include unsupported requests labeled out of scope. These are supplied dataset utterances.",
      });
    }
  }
  if (name === "judge") {
    const revision = sources["ScalerLab/JudgeBench"]?.commit;
    result.provenance = {
      name: "JudgeBench",
      organization: "ScalerLab",
      revision,
      url: `https://github.com/ScalerLab/JudgeBench/tree/${revision}`,
      sampling:
        "100 sampled candidate pairs, evaluated in both answer orders. Upstream supplies the expected winner; the response model is shown for each case.",
    };
  }
  const auditPath = resolve(lab, "rewardbench2/prior-content-audit.json");
  if (existsSync(auditPath) && ["classify", "judge"].includes(name)) {
    const audit = JSON.parse(readFileSync(auditPath, "utf8"));
    for (const finding of audit.findings.filter(
      (f: any) => f.dataset === name,
    )) {
      const notice = {
        categories: finding.categories,
        note: finding.explanation,
        level: finding.severity,
        method:
          "GPT-5.6 Sol contextual review after lexical screening; not an exhaustive moderation guarantee.",
      };
      if (name === "classify") {
        const row = result.experiments.clinc150.rows[finding.row_id];
        if (!row) throw Error("Audited CLINC150 row is missing");
        row.content_notice = notice;
      } else
        for (const row of result.rows)
          if (finding.row_ids?.includes(row.id)) row.content_notice = notice;
    }
  }
  if (name === "rewardbench2") {
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
  }
  return result;
}
