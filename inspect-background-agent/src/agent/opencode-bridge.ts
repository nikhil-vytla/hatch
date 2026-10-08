import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { opencodeBin } from "../sandbox/git-sandbox.js";

export type OpenCodeModel = {
  readonly providerID: string;
  readonly modelID: string;
};

export type OpenCodeDelta =
  | { readonly kind: "connected" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly name: string; readonly status: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "stopped" }
  | { readonly kind: "idle" }
  | { readonly kind: "raw"; readonly type: string; readonly data: unknown };

const DEFAULT_MODEL: OpenCodeModel = {
  providerID: "opencode",
  modelID: "big-pickle",
};

/**
 * Runs OpenCode against a sandbox directory via `opencode run`.
 * The CLI path is the reliable local integration (free opencode/* models).
 * `serve` remains available for future multi-turn HTTP sessions.
 */
export class OpenCodeBridge {
  constructor(
    private readonly opts: {
      readonly model?: OpenCodeModel;
    } = {},
  ) {}

  get model(): OpenCodeModel {
    return this.opts.model ?? DEFAULT_MODEL;
  }

  /** No-op for CLI mode; kept so control plane can await start(). */
  async start(): Promise<string> {
    return "cli://opencode-run";
  }

  async createSession(_directory: string): Promise<string> {
    // CLI mode does not keep a durable OpenCode session id.
    return `cli_${Date.now().toString(36)}`;
  }

  async *runPrompt(args: {
    readonly sessionId: string;
    readonly directory: string;
    readonly text: string;
    readonly timeoutMs?: number;
    /** Continue the sandbox's previous OpenCode session (conversation memory). */
    readonly continueSession?: boolean;
    /** Abort kills the run; the generator ends with kind: "stopped". */
    readonly signal?: AbortSignal;
  }): AsyncGenerator<OpenCodeDelta> {
    const bin = opencodeBin();
    const model = `${this.model.providerID}/${this.model.modelID}`;
    const timeoutMs = args.timeoutMs ?? 240_000;

    yield { kind: "connected" };

    const child = spawn(
      bin,
      [
        "run",
        "--dir",
        args.directory,
        "--model",
        model,
        ...(args.continueSession
          ? ["--continue"]
          : ["--title", `inspect-${args.sessionId}`]),
        args.text,
      ],
      {
        cwd: args.directory,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stoppedBySignal = false;
    const onAbort = () => {
      stoppedBySignal = true;
      child.kill("SIGKILL");
    };
    if (args.signal?.aborted) onAbort();
    args.signal?.addEventListener("abort", onAbort, { once: true });

    const killTimer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);

    const forward = async function* (
      stream: NodeJS.ReadableStream,
      asError = false,
    ): AsyncGenerator<OpenCodeDelta> {
      const rl = createInterface({ input: stream });
      for await (const line of rl) {
        const cleaned = stripAnsi(line);
        if (!cleaned.trim()) continue;
        if (asError && /error|failed/i.test(cleaned)) {
          yield { kind: "error", message: cleaned };
        } else if (/^←\s+Write\b/i.test(cleaned) || /\bWrote file\b/i.test(cleaned)) {
          yield { kind: "tool", name: "write", status: cleaned };
          yield { kind: "text", text: cleaned + "\n" };
        } else if (/^\$\s+/.test(cleaned)) {
          yield { kind: "tool", name: "bash", status: "running" };
          yield { kind: "text", text: cleaned + "\n" };
        } else {
          yield { kind: "text", text: cleaned + "\n" };
        }
      }
    };

    let exitCode: number | null = null;
    const exitPromise = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });

    // Interleave stdout then wait for process end while draining stderr.
    const stdoutTask = (async function* () {
      yield* forward(child.stdout!);
    })();
    const stderrChunks: OpenCodeDelta[] = [];
    const stderrTask = (async () => {
      for await (const d of forward(child.stderr!, true)) {
        stderrChunks.push(d);
      }
    })();

    for await (const d of stdoutTask) {
      yield d;
    }
    await stderrTask;
    exitCode = await exitPromise;
    clearTimeout(killTimer);
    args.signal?.removeEventListener("abort", onAbort);

    if (stoppedBySignal) {
      yield { kind: "stopped" };
      return;
    }

    for (const d of stderrChunks) {
      if (d.kind === "error") yield d;
      else if (d.kind === "text" && /error/i.test(d.text)) yield d;
    }

    if (exitCode && exitCode !== 0) {
      yield { kind: "error", message: `opencode run exited with code ${exitCode}` };
    }
    yield { kind: "idle" };
  }

  async close(): Promise<void> {
    // CLI mode has no long-lived server.
  }
}

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "").replace(/\x1b\[[0-9;]*m/g, "");
}
