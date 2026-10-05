// The kernel: one live world, changed only through checked attempts, after Jiti's controller/worker protocol.
//
//   observe -> propose (tagged with the generation it saw) -> generation check -> checkpoint -> run
//           -> gates -> accept (publish a revision) or restore the checkpoint -> observe again
//
// `develop` changes functions; `execute` uses them (and may change managed data); `preview` runs and always restores.
// Every accepted change is a durable revision; a fresh process recovers the latest one and replays nothing.
import { checkInvariants, type Layer, LAYERS, type Proposal, type Report, type Spec, verify } from "./gates.ts";
import { type Revision, Store } from "./store.ts";
import { World } from "./world.ts";

export type Generators = Record<string, (rand: () => number) => unknown>;
export type DevelopResult = { status: "stale" | "rejected" | "accepted" | "accepted-incomplete"; report?: Report; revision?: string; failed?: Layer[] };

const SAFETY: readonly Layer[] = ["static", "invariants", "ratchet", "properties", "traces"];

export class Kernel {
	readonly store: Store;
	world: World;
	spec: Spec;
	generation = 0;
	revision?: Revision;
	readonly generators: Generators;
	turn = 0;

	constructor(dir: string, options: { spec: Spec; state?: unknown; generators: Generators }) {
		this.store = new Store(dir);
		this.generators = options.generators;
		const current = this.store.current();
		if (current) {
			// Recovery: the accepted world and contract come back; unfinished attempts are only marked, never replayed.
			this.world = new World(current.world);
			this.spec = current.specs as Spec;
			this.revision = current;
			this.store.journal({ event: "recovered", revision: current.id });
		} else {
			this.world = new World({ functions: {}, state: options.state ?? {} });
			this.spec = options.spec;
			this.revision = this.store.publish({ reason: "empty world", world: this.world.snapshot(), specs: this.spec });
		}
	}

	observe() {
		return { generation: this.generation, revision: this.revision?.id, functions: [...this.world.functions.keys()], state: this.world.state() };
	}

	develop(proposal: Proposal, seenGeneration: number): DevelopResult {
		this.turn++;
		if (seenGeneration !== this.generation) {
			this.store.journal({ event: "stale", intent: proposal.intent, seen: seenGeneration, now: this.generation });
			return { status: "stale" };
		}
		const report = verify({ base: this.world.snapshot(), proposal, spec: this.spec, traces: this.store.traces(), generators: this.generators });
		const failed = report.verdicts.filter((v) => !v.ok).map((v) => v.layer);
		const unsafe = failed.filter((l) => SAFETY.includes(l));
		this.store.journal({ event: "develop", intent: proposal.intent, failed, surfaced: report.surfaced.length });
		if (unsafe.length > 0 || report.candidate === undefined) return { status: "rejected", report, failed };
		// Accept: the candidate becomes the live world; the confirmed examples join the contract (the ratchet).
		this.world.restore(report.candidate);
		const turn = this.turn;
		this.spec = {
			...this.spec,
			examples: [...this.spec.examples, ...proposal.examples.map((e) => ({ ...e, turn }))],
			properties: [...this.spec.properties, ...(proposal.properties ?? [])],
		};
		this.revision = this.store.publish({ parent: this.revision?.id, reason: proposal.intent, world: this.world.snapshot(), specs: this.spec });
		this.generation++;
		return { status: failed.includes("goals") ? "accepted-incomplete" : "accepted", report, revision: this.revision.id, failed };
	}

	/** Use the application. A call that leaves the state breaking an invariant is undone. Every call is recorded. */
	execute(expr: string): { ok: true; value: unknown } | { ok: false; error: string } {
		const checkpoint = this.world.snapshot();
		try {
			const { value, calls } = this.world.traced(expr);
			const after = this.world.state();
			const broken = checkInvariants(new World({ functions: checkpoint.functions, state: after }), this.spec.invariants, after);
			if (broken) {
				this.world.restore(checkpoint);
				this.store.journal({ event: "execute-rejected", expr, invariant: broken });
				return { ok: false, error: `undone: ${broken}` };
			}
			this.store.recordTrace({ expr, before: checkpoint.state, after, value, calls, revision: this.revision!.id });
			if (JSON.stringify(after) !== JSON.stringify(checkpoint.state)) {
				this.revision = this.store.publish({ parent: this.revision?.id, reason: `data: ${expr}`, world: this.world.snapshot(), specs: this.spec });
				this.generation++;
			}
			return { ok: true, value };
		} catch (error) {
			this.world.restore(checkpoint);
			this.store.journal({ event: "execute-error", expr, error: String((error as Error).message) });
			return { ok: false, error: String((error as Error).message) };
		}
	}

	preview(expr: string): unknown {
		const checkpoint = this.world.snapshot();
		try {
			return this.world.evaluate(expr);
		} finally {
			this.world.restore(checkpoint);
		}
	}

	/** Publish an earlier revision's code, contract and data as a new revision; history is kept. */
	rollback(id: string): Revision {
		const target = this.store.revisions().find((r) => r.id === id);
		if (target === undefined) throw new Error(`no revision ${id}`);
		const broken = checkInvariants(new World(target.world), (target.specs as Spec).invariants, target.world.state);
		if (broken) throw new Error(`rollback target breaks ${broken}`);
		this.world.restore(target.world);
		this.spec = target.specs as Spec;
		this.revision = this.store.publish({ parent: this.revision?.id, reason: `rollback to ${id}`, rollbackOf: id, world: target.world, specs: target.specs });
		this.generation++;
		return this.revision;
	}
}

export { LAYERS };
