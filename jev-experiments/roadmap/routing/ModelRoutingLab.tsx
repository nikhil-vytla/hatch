import { useEffect, useMemo, useRef, useState } from "react";
import {
  Pane,
  Field,
  Button,
  Notice,
} from "../../experience-prototypes/src/shared";
import {
  getApiKey,
  download,
  readResponse,
} from "../../experience-prototypes/src/api";
import { defaultPolicy, selectRoute, classifyTask } from "./policy";
import { defaultWebTask, webRoutes } from "./web-registry";
import type { Policy, RoutingResult } from "./types";
import recorded from "./recorded-example.json";
import { protocolDownloads, harnessDownloads } from "./evidence-links";
import toolkitGuide from "./README.md?url&no-inline";
import clientGuide from "../integration/README.md?url&no-inline";
import opencodeConfig from "../integration/examples/opencode.json?url&no-inline";
import claudeConfig from "../integration/examples/claude.mcp.json?url&no-inline";
import codexConfig from "../integration/examples/codex.toml?url&no-inline";
import routerConfig from "../integration/examples/router.json?url&no-inline";
import clientSkill from "../integration/skills/jev-route-task/SKILL.md?url&no-inline";
export function ModelRoutingLab() {
  const [prompt, setPrompt] = useState(defaultWebTask.prompt),
    [context, setContext] = useState(defaultWebTask.context),
    [weights, setWeights] = useState(defaultPolicy.weights),
    [maxCost, setMaxCost] = useState(0.05),
    [fallback, setFallback] = useState(false),
    [cache, setCache] = useState(false),
    [result, setResult] = useState<RoutingResult | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [recordOpen, setRecordOpen] = useState(false);
  const active = useRef<AbortController | null>(null),
    epoch = useRef(0);
  const invalidate = () => {
    epoch.current++;
    active.current?.abort();
    active.current = null;
    setBusy(false);
    setResult(null);
    setError("");
  };
  useEffect(
    () => () => {
      epoch.current++;
      active.current?.abort();
    },
    [],
  );
  const task = { ...defaultWebTask, prompt, context };
  const policy: Policy = {
    ...defaultPolicy,
    weights,
    maxCostUsd: maxCost,
    allowAvailabilityFallback: fallback,
    maxAttempts: fallback ? 2 : 1,
  };
  const simulationRoutes = useMemo(
    () =>
      webRoutes.map((r) => ({
        ...r,
        cache: cache
          ? {
              tokens: 2000,
              expiresAt: Date.now() + 60_000,
              basis: "simulation" as const,
            }
          : undefined,
      })),
    [cache],
  );
  const classification = classifyTask(task),
    selection = selectRoute(task, webRoutes, policy, { classification }),
    simulatedSelection = selectRoute(task, simulationRoutes, policy, {
      classification,
    });
  async function execute() {
    invalidate();
    const token = ++epoch.current,
      controller = new AbortController();
    active.current = controller;
    setBusy(true);
    try {
      const response = await fetch("/api/route", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getApiKey()}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          task,
          weights,
          maxCostUsd: maxCost,
          allowAvailabilityFallback: fallback,
        }),
      });
      const body = await readResponse(response);
      if (!response.ok) throw Error(body.error ?? "Route execution failed.");
      if (epoch.current === token) setResult(body);
    } catch (e) {
      if (epoch.current === token && !controller.signal.aborted)
        setError(e instanceof Error ? e.message : "Route execution failed.");
    } finally {
      if (epoch.current === token) {
        setBusy(false);
        active.current = null;
      }
    }
  }
  return (
    <div className="experiment-stack">
      <Pane
        title="Model Routing Lab"
        sub="A bounded task, a selected destination, an inspectable result"
      >
        <p>
          The recorded Fable 5.1 Global delegation proposed a loop patch in 6.95
          s; cost is unknown. Change the task and preferences. A delegate
          proposes an answer or patch. Your coding tool controls applying it and
          running tests.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button secondary onClick={() => setRecordOpen(!recordOpen)}>
            {recordOpen ? "Hide" : "Show"} recorded example
          </Button>
          <Button
            secondary
            onClick={() => {
              invalidate();
              setPrompt(defaultWebTask.prompt);
              setContext(defaultWebTask.context);
              setWeights(defaultPolicy.weights);
              setMaxCost(0.05);
              setCache(false);
            }}
          >
            Reset example
          </Button>
          <Button
            secondary
            onClick={() => {
              navigator.clipboard
                ?.writeText(
                  `${location.origin}${location.pathname}#experiment/routing`,
                )
                .catch(() =>
                  setError("Copy the page URL to share this public preset."),
                );
            }}
          >
            Copy public preset link
          </Button>
        </div>
        <p className="muted">
          The preset link contains no task text. Export includes only the result
          you choose to save.
        </p>
        {recordOpen && (
          <details open>
            <summary>Actual recorded prompt, patch and outcome</summary>
            <p>
              The bounded OpenCode delegate returned this patch in{" "}
              {(recorded.result.outcome.totalLatencyMs / 1000).toFixed(2)}{" "}
              seconds. The configured destination was Fable 5.1 Global through
              Bedrock. Provider identity was not independently returned; cost is
              unknown.
            </p>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {recorded.task.prompt +
                "\n\n" +
                recorded.task.context +
                "\n" +
                recorded.result.outcome.artifact.text}
            </pre>
            <p>
              One successful task does not establish relative quality or
              savings. The host fixture independently tests whether it can apply
              a delegated patch.
            </p>
            <Button
              secondary
              onClick={() =>
                download("jev-recorded-routing-trace.json", recorded)
              }
            >
              Export recorded trace
            </Button>
          </details>
        )}
      </Pane>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,320px),1fr))",
          gap: 16,
        }}
      >
        <Pane title="Give the delegate a task">
          <Field label="Task">
            <textarea
              value={prompt}
              rows={4}
              onChange={(e) => {
                invalidate();
                setPrompt(e.target.value);
              }}
            />
          </Field>
          <Field label="Complete relevant source or context">
            <textarea
              value={context}
              rows={9}
              spellCheck={false}
              onChange={(e) => {
                invalidate();
                setContext(e.target.value);
              }}
            />
          </Field>
          <p>
            Task classifier: lexical baseline, {classification.category}. It
            uses an uncalibrated fixed difficulty prior.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button
              onClick={execute}
              disabled={busy || selection.status !== "selected"}
            >
              {busy ? "Delegating…" : "Execute selected route with my key"}
            </Button>
            {busy && (
              <Button secondary onClick={invalidate}>
                Cancel
              </Button>
            )}
          </div>
          <p className="muted">
            Live execution selects GPT-4.1 mini or Claude Haiku 4.5 through
            Vercel AI Gateway. The recording used OpenCode and Bedrock. Use
            Connect to supply your Gateway key; it stays in memory. Execution
            has no filesystem or tool access.
          </p>
          {error && <Notice error>{error}</Notice>}
        </Pane>
        <Pane title="Preferences and restrictions">
          <Notice>
            Quality and latency values are illustrative simulations. Prices use
            the gateway list-price snapshot dated 20 September 2026. No measured
            model comparison or savings claim.
          </Notice>
          {(["quality", "cost", "latency"] as const).map((key) => (
            <Field
              key={key}
              label={`${key[0].toUpperCase() + key.slice(1)} weight: ${weights[key].toFixed(2)}`}
            >
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={weights[key]}
                onChange={(e) => {
                  invalidate();
                  setWeights({ ...weights, [key]: Number(e.target.value) });
                }}
              />
            </Field>
          ))}
          <Field label="Maximum configured charge for this task, USD">
            <input
              type="number"
              min="0"
              max="1"
              step="0.005"
              value={maxCost}
              onChange={(e) => {
                invalidate();
                setMaxCost(Number(e.target.value));
              }}
            />
          </Field>
          <label style={{ display: "flex", gap: 8, padding: "8px 0" }}>
            <input
              type="checkbox"
              checked={fallback}
              onChange={(e) => {
                invalidate();
                setFallback(e.target.checked);
              }}
            />
            Allow availability fallback within the same restrictions
          </label>
          <label style={{ display: "flex", gap: 8, padding: "8px 0" }}>
            <input
              type="checkbox"
              checked={cache}
              onChange={(e) => {
                invalidate();
                setCache(e.target.checked);
              }}
            />
            Simulate a warm 2,000-token cache
          </label>
          <p>
            Cache simulation changes estimates only. Live execution uses cold
            charge reservations and does not pretend a cache exists. Quality
            escalation is off until a verifier and measured stronger routes are
            configured.
          </p>
        </Pane>
      </div>
      <Pane title="Live selection, using cold charge reservations">
        {cache && (
          <Notice>
            Cache simulation only: hypothetical selection{" "}
            {simulatedSelection.routeId ?? "none"}. The live selection below
            uses cold input; simulated cache state is never sent to execution.
          </Notice>
        )}
        <p>
          {selection.explanation}{" "}
          {selection.routeId && `Selected: ${selection.routeId}.`}
        </p>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th scope="col">Destination</th>
                <th scope="col">Eligible</th>
                <th scope="col">Estimated USD</th>
                <th scope="col">Reason</th>
              </tr>
            </thead>
            <tbody>
              {selection.candidates.map((c) => (
                <tr key={c.routeId}>
                  <th scope="row">{c.routeId}</th>
                  <td>{c.eligible ? "Yes" : "No"}</td>
                  <td>{c.estimatedCostUsd?.toFixed(5) ?? "Unknown"}</td>
                  <td>
                    {c.reasons.join(" ") ||
                      `Rank ${c.rankScore?.toFixed(3)}; quality and latency simulated; cache ${c.cacheBasis}.`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Pane>
      {result && (
        <Pane title="Execution outcome">
          <Notice error={result.status !== "ok"}>
            {result.status}:{" "}
            {result.outcome.actualRouteId ?? "No destination executed"}.{" "}
            {result.outcome.failure ?? ""}
          </Notice>
          <p>
            Returned model: {result.outcome.actualModel ?? "none"}. Total{" "}
            {(result.outcome.totalLatencyMs / 1000).toFixed(2)} s. Measured
            cost:{" "}
            {result.outcome.totalCostUsd === null
              ? "unknown"
              : `$${result.outcome.totalCostUsd.toFixed(5)}`}
            .
          </p>
          <p>{result.outcome.note}</p>
          {result.outcome.artifact?.repair && (
            <Notice>
              The original model patch had invalid line counts. One hunk header
              was recounted; paths and source lines were preserved. Inspect the
              original and repair metadata below. Your host must still apply and
              test the proposed patch.
            </Notice>
          )}
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {result.outcome.artifact?.text}
          </pre>
          <Button
            secondary
            onClick={() => download("jev-routing-result.json", result)}
          >
            Export result
          </Button>
          <details>
            <summary>
              Inspect classification, selection, usage and attempts
            </summary>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {JSON.stringify(result, null, 2)}
            </pre>
          </details>
        </Pane>
      )}
      <Pane title="Evidence and reusable tools">
        <details>
          <summary>Use the CLI or connect your coding tool</summary>
          <p>
            From a{" "}
            <a href="https://github.com/nikhil-vytla/hatch">
              repository checkout
            </a>{" "}
            containing this release, install with Bun:
          </p>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            sh jev-experiments/roadmap/routing/install.sh
          </pre>
          <p>
            Run <code>jev doctor</code> from the printed bin directory.
            Configure a destination before delegating. Your coding tool keeps
            control of edits and commands; replace the absolute-path
            placeholders in these examples with your own paths.
          </p>
          <ul>
            <li>
              <a href={toolkitGuide} download="jev-router-guide.md">
                CLI and TypeScript guide
              </a>
            </li>
            <li>
              <a href={clientGuide} download="jev-coding-clients.md">
                Coding-client setup and verified outcomes
              </a>
            </li>
            <li>
              <a href={opencodeConfig} download="jev-opencode.json">
                OpenCode MCP configuration
              </a>
            </li>
            <li>
              <a href={claudeConfig} download="jev-claude.mcp.json">
                Claude Code MCP configuration
              </a>
            </li>
            <li>
              <a href={codexConfig} download="jev-codex.toml">
                Codex MCP configuration
              </a>
            </li>
            <li>
              <a href={routerConfig} download="jev-router.json">
                Example destination registry
              </a>
            </li>
            <li>
              <a href={clientSkill} download="jev-route-task-SKILL.md">
                Delegation skill
              </a>
            </li>
          </ul>
        </details>
        <p>
          The{" "}
          <a
            href="https://github.com/fstandhartinger/auto-model-router"
            target="_blank"
            rel="noreferrer"
          >
            auto-model-router
          </a>{" "}
          separation of task classification, cache-aware selection and outcomes,
          and the{" "}
          <a
            href="https://whichmodel.app.mintapis.com/"
            target="_blank"
            rel="noreferrer"
          >
            Whichmodel playground
          </a>{" "}
          informed this lab. The TypeScript API, CLI and MCP server share the
          selector.
        </p>
        <p>
          The comparison uses four held-out synthetic tasks and replays recorded
          destination answers under a fixed policy. It does not establish
          production savings or general coding quality. Download the protocols
          and results to inspect the conditions and failures.
        </p>
        <details>
          <summary>Protocols and comparison evidence</summary>
          <ul>
            {protocolDownloads.map((item) => (
              <li key={item.file}>
                <a href={item.url} download={item.file}>
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </details>
        <p>
          These primary client runs called the MCP tools, used returned
          proposals through host permissions, and passed independent task tests.
          Their summaries identify client versions and run conditions. These
          retained sessions predate later code fixes and are not relabeled as
          new runs.
        </p>
        {harnessDownloads.map((client) => (
          <details key={client.id}>
            <summary>{client.name}: actual delegation evidence</summary>
            <ul>
              <li>
                <a
                  href={client.summary}
                  download={`jev-${client.id}-summary.json`}
                >
                  Run summary
                </a>
              </li>
              <li>
                <a
                  href={client.audit}
                  download={`jev-${client.id}-mcp-audit.jsonl`}
                >
                  MCP audit (JSONL)
                </a>
              </li>
              <li>
                <a
                  href={client.transcript}
                  download={`jev-${client.id}-host-transcript.jsonl`}
                >
                  Host transcript (JSONL)
                </a>
              </li>
              <li>
                <a href={client.diff} download={`jev-${client.id}-host.diff`}>
                  Host-applied diff
                </a>
              </li>
              <li>
                <a href={client.tests} download={`jev-${client.id}-tests.txt`}>
                  Independent test output
                </a>
              </li>
            </ul>
          </details>
        ))}
      </Pane>
    </div>
  );
}
