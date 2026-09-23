import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

export const STRIVE_EXE = resolve(import.meta.dir, "../../../target/debug/strive");

export type TestDaemon = {
  home: string;
  socket: string;
  env: Record<string, string | undefined>;
  strive(...args: string[]): { exitCode: number; stdout: string; stderr: string };
  pid(): number;
  dispose(): void;
};

export function startDaemon(extra: Record<string, string> = {}): TestDaemon {
  const home = mkdtempSync("/tmp/strv-ts-");

  // Real keys and upstreams must never reach a test daemon.
  const env = {
    ...process.env,
    STRIVE_HOME: home,
    STRIVE_IDLE_SECS: undefined,
    ANTHROPIC_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    STRIVE_UPSTREAM_ANTHROPIC: "http://127.0.0.1:9",
    STRIVE_UPSTREAM_OPENAI: "http://127.0.0.1:9",
    // No agent host unless a test asks for one.
    STRIVE_HOST: "none",
    ...extra,
  };

  const strive = (...args: string[]) => {
    const r = Bun.spawnSync([STRIVE_EXE, ...args], { env });

    return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  };

  const status = strive("status", "--json");

  if (status.exitCode !== 0) throw new Error(`daemon did not start: ${status.stderr}`);

  return {
    home,
    socket: join(home, "run/strived.sock"),
    env,
    strive,
    pid: () => JSON.parse(strive("status", "--json").stdout).server.pid,
    dispose() {
      strive("stop");
      rmSync(home, { recursive: true, force: true });
    },
  };
}
