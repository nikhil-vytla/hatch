/**
 * `jev-lab eval`'s recorder: the shared recorder (packages/jev-client/src/recorder.ts) with the
 * CLI's defaults. Sends a study's requests one at a time and appends one JSONL row per attempt
 * (id, at, status, latencyMs, inputTokens, costUsd, answers, ...). Fail-fast, and capped before a
 * request could pass --max-usd; resumes only with --resume.
 */
import { estimateTokens, record, type RunResult } from "../../../packages/jev-client/src/recorder";
import { EndpointError, type Endpoint } from "../../../packages/jev-client/src/endpoints";
import type { Job } from "./studies";

export { readRows, receipt, receiptLine, type RecordedRow as Row } from "../../../packages/jev-client/src/recordings";
export { estimateTokens, type RunResult };

export type RunOptions = {
  out: string;
  dryRun?: boolean;
  maxUsd?: number;
  resume?: boolean;
  limit?: number;
  /** Consecutive failures that stop the run (a dead server shouldn't log hundreds of errors). */
  failFast?: number;
  log?: (line: string) => void;
  wait?: (ms: number) => Promise<void>;
};

/** The CLI logs and retries on its adapters' own errors; a gateway error inside `evaluate` is code 0. */
const codeOf = (e: unknown) => (e instanceof EndpointError ? e.status : 0);

export const run = (jobs: Job[], ep: Endpoint, opts: RunOptions): Promise<RunResult> =>
  record(jobs, ep, {
    ...opts,
    resume: opts.resume ?? false,
    worstUsd: (job) => (estimateTokens(job) * ep.usdPerMTok) / 1e6,
    retry: (e, attempt) => ((codeOf(e) === 429 || codeOf(e) === 503) && attempt < 3 ? 1000 * 2 ** attempt : "next"),
    errorRow: (job, e, { at }) => ({ id: job.id, at, status: "error", code: codeOf(e), message: e instanceof Error ? e.message : String(e), endpoint: ep.label }),
  });
