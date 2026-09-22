#!/usr/bin/env bun
import { decide, routeConfiguredTask, classifyEml } from "./index";
import { createMacAdapter, classifyMacEml } from "./mac-adapter";
import { loadConfig } from "./config";
import { configuredClassifierInfo } from "./configured-classifier";
const [command, path] = process.argv.slice(2);
try {
  if (command === "mcp") {
    await import("./mcp");
  } else if (command === "doctor") {
    const config = await loadConfig();
    console.log(
      JSON.stringify(
        {
          status: "ok",
          runtime: "bun",
          version: Bun.version,
          configuredRoutes: config.routes.map((r) => ({
            id: r.id,
            local: r.local,
            destination: r.destination.kind,
          })),
          defaultDecisionAdapter: config.localRuntime
            ? `Explicit local model ${config.localRuntime.model}`
            : config.decisionEndpoint
              ? "configured contract endpoint"
              : "state-blind uniform prior; no model installed",
          operations: ["decide", "route_task", "classify_eml"],
          taskClassifier: configuredClassifierInfo(config),
          localCloudFallback: false,
        },
        null,
        2,
      ),
    );
  } else if (command === "classify_eml") {
    if (!path || !path.toLowerCase().endsWith(".eml"))
      throw Error("Supply an explicit .eml file path.");
    const config = await loadConfig(),
      eml = await Bun.file(path).text(),
      abort = new AbortController();
    process.once("SIGINT", () => abort.abort());
    const result = config.localRuntime
      ? await classifyMacEml(eml, config.localRuntime, abort.signal)
      : classifyEml(eml);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "ok") process.exitCode = 2;
  } else if (command === "decide" || command === "route_task") {
    const request = JSON.parse(
        path ? await Bun.file(path).text() : await Bun.stdin.text(),
      ),
      config = await loadConfig();
    const abort = new AbortController();
    process.once("SIGINT", () => abort.abort());
    const output =
      command === "decide"
        ? await decide(request, {
            signal: abort.signal,
            endpoint: config.decisionEndpoint,
            adapter: config.localRuntime
              ? createMacAdapter(config.localRuntime)
              : undefined,
          })
        : await routeConfiguredTask(request, config, { signal: abort.signal });
    console.log(JSON.stringify(output, null, 2));
    if (output.status !== "ok") process.exitCode = 2;
  } else {
    console.log(
      "Usage: bun cli.ts decide [request.json] | route_task [task.json] | classify_eml message.eml | doctor | mcp\nSet JEV_ROUTER_CONFIG to a trusted registry JSON file. JSON input defaults to stdin. No routes are configured by default.",
    );
    if (command) process.exitCode = 2;
  }
} catch (error) {
  console.error(
    JSON.stringify({
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
}
