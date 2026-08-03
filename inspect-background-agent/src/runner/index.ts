import type { LeasedSlot, ToolKind } from "../slot/index.js";
import type { Turn } from "../session/index.js";
import type { SessionId } from "../kernel/index.js";

export type SidecarUrls = {
  readonly ideUrl: string;
  readonly vncUrl: string | null;
  readonly ttyUrl: string | null;
};

/**
 * In-sandbox supervisor (Bun Runner–shaped). Only component that talks to the
 * agent runtime. Mints sidecar URLs the frontend iframes through JWT tunnels
 * in production; locally returns opaque local:// URLs.
 */
export interface Runner {
  sidecars(sessionId: SessionId): SidecarUrls;
  runTurn(args: {
    readonly turn: Turn;
    readonly slot: LeasedSlot;
    readonly onDelta: (text: string) => void;
    readonly shouldStop: () => boolean;
    readonly toolGate: (kind: ToolKind) => Promise<"allow" | "park-then-allow">;
  }): Promise<{ readonly summary: string; readonly changedCode: boolean }>;
}

export type AgentPort = {
  run(args: {
    readonly prompt: string;
    readonly onDelta: (text: string) => void;
    readonly shouldStop: () => boolean;
    readonly readFile: (path: string) => Promise<string>;
    readonly writeFile: (path: string, content: string) => Promise<void>;
    readonly toolGate: (kind: ToolKind) => Promise<"allow" | "park-then-allow">;
  }): Promise<{ readonly summary: string; readonly changedCode: boolean }>;
};

export function createLocalRunner(agent: AgentPort): Runner {
  return {
    sidecars(sessionId) {
      return {
        ideUrl: `local://ide/${sessionId}`,
        vncUrl: `local://vnc/${sessionId}`,
        ttyUrl: `local://tty/${sessionId}`,
      };
    },
    async runTurn({ turn, slot, onDelta, shouldStop, toolGate }) {
      return agent.run({
        prompt: turn.text,
        onDelta,
        shouldStop,
        readFile: (path) => slot.read(path),
        async writeFile(path, content) {
          const mutable = await slot.admitWrites();
          await mutable.write(path, content);
        },
        toolGate,
      });
    },
  };
}

/** Scripted OpenCode stand-in used by local demos/tests. */
export function createScriptedAgent(): AgentPort {
  return {
    async run({ prompt, onDelta, shouldStop, readFile, writeFile, toolGate }) {
      onDelta(`Working on: ${prompt}\n`);
      const readme = await readFile("README.md");
      onDelta(`Read README (${readme.length} bytes)\n`);
      if (shouldStop()) {
        return { summary: "stopped before mutate", changedCode: false };
      }
      const gate = await toolGate("edit");
      if (gate === "park-then-allow") {
        onDelta("Parked for git sync, then writing.\n");
      }
      if (shouldStop()) {
        return { summary: "stopped during sync", changedCode: false };
      }
      await writeFile("fix.txt", `fixed: ${prompt}\n`);
      onDelta("Wrote fix.txt\n");
      return {
        summary: `Applied fix for: ${prompt.slice(0, 80)}`,
        changedCode: true,
      };
    },
  };
}
