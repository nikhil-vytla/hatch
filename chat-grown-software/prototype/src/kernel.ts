// The kernel: one live world, changed only through checked attempts, after Jiti's controller/worker protocol.
//
//   observe -> propose (tagged with the generation it saw) -> generation check -> checkpoint -> run
//           -> gates -> accept (publish a revision) or restore the checkpoint -> observe again
//
// `develop` changes functions; `execute` uses them (and may change managed data); `preview` runs and always restores.
// Every accepted change is a durable revision; a fresh process recovers the latest one and replays nothing.
//
// "Done" is the user's, not the model's: a change whose safety layers pass goes live, but it is only `accepted` when
// this turn's confirmed examples pass AND call every function in scope. Otherwise it is `accepted-incomplete`, and
// `ask` says what to ask the user next.
import { type Question, questions } from "./ask.ts";
import { buildCandidate, checkInvariants, type Layer, LAYERS, type Proposal, type Report, type Spec, verify } from "./gates.ts";
import { type Asked, type Revision, Store } from "./store.ts";
import { World } from "./world.ts";

export type Generators = Record<string, (rand: () => number) => unknown>;
export type DevelopResult = { status: "stale" | "rejected" | "accepted" | "accepted-incomplete"; report?: Report; revision?: string; failed?: Layer[]; uncovered?: string[] };
export type ExecuteResult = ({ ok: true; value: unknown } | { ok: false; error: string }) & { replayed?: true };

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

	/** The questions to put to the user about a proposal, answered by the candidate it would build. */
	ask(proposal: Proposal, words: string): { questions: Question[]; uncovered: string[] } | { error: string } {
		const built = buildCandidate(this.world.snapshot(), proposal);
		if (built.world === undefined) return { error: built.error ?? "does not load" };
		const history = [...this.spec.examples.map((e) => e.call ?? e.expr), ...this.store.traces().map((t) => t.expr)];
		const valid = (state: unknown) => checkInvariants(built.world!, this.spec.invariants, state) === undefined;
		const result = questions({ candidate: built.world, proposal, words, history, valid });
		built.world.setState(this.world.state());
		return result;
	}

	develop(proposal: Proposal, seenGeneration: number, options: { asked?: Asked } = {}): DevelopResult {
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
		this.revision = this.store.publish({ parent: this.revision?.id, reason: proposal.intent, world: this.world.snapshot(), specs: this.spec, asked: options.asked });
		this.generation++;
		const done = !failed.includes("goals") && report.uncovered.length === 0;
		return { status: done ? "accepted" : "accepted-incomplete", report, revision: this.revision.id, failed, uncovered: report.uncovered };
	}

	/**
	 * Use the application. A call that leaves the state breaking an invariant is undone. Every call is recorded.
	 * With a request id the effect is exactly-once: the id and the result are written in the same revision file as the
	 * state change, so a retry (after a crash or a lost reply) returns the first result and changes nothing.
	 */
	execute(expr: string, requestId?: string): ExecuteResult {
		if (requestId !== undefined) {
			const seen = this.store.request(requestId);
			if (seen) {
				this.store.journal({ event: "execute-replayed", expr, requestId });
				return { ok: true, value: seen.value, replayed: true };
			}
		}
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
			if (JSON.stringify(after) !== JSON.stringify(checkpoint.state)) {
				// The revision (with the request id and result) is the commit point; the trace is written after it.
				this.revision = this.store.publish({ parent: this.revision?.id, reason: `data: ${expr}`, world: this.world.snapshot(), specs: this.spec, requestId, result: value });
				this.generation++;
				if (process.env.CRASH_AFTER_COMMIT === "1") process.exit(86); // test hook: die before replying
			}
			this.store.recordTrace({ expr, before: checkpoint.state, after, value, calls, revision: this.revision!.id, requestId });
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

	/**
	 * Publish an earlier revision as a new one; history is kept. Code and data roll back separately:
	 *   "code" (the default): that revision's functions and contract, with today's data;
	 *   "data": today's functions and contract, with that revision's data;
	 *   "both": the whole revision, as Jiti does.
	 * The combination must satisfy the invariants of the contract it ends up under, or the rollback is refused (data the
	 * old code cannot hold needs an explicit migration, not a silent drop).
	 */
	rollback(id: string, what: "code" | "data" | "both" = "code"): Revision {
		const target = this.store.revisions().find((r) => r.id === id);
		if (target === undefined) throw new Error(`no revision ${id}`);
		const functions = what === "data" ? this.world.snapshot().functions : target.world.functions;
		const specs = (what === "data" ? this.spec : target.specs) as Spec;
		const state = what === "code" ? this.world.state() : target.world.state;
		const world = { functions, state };
		const broken = checkInvariants(new World(world), specs.invariants, state);
		if (broken) throw new Error(`rolling back ${what} to ${id} would break ${broken}; it needs a migration`);
		this.world.restore(world);
		this.spec = specs;
		this.revision = this.store.publish({ parent: this.revision?.id, reason: `rollback ${what} to ${id}`, rollbackOf: id, world, specs });
		this.generation++;
		return this.revision;
	}

	/** Why does a function look the way it does? The revision that last changed it and the chat message that asked. */
	why(name: string): { revision: string; reason: string; asked?: Asked } | undefined {
		let last: Revision | undefined;
		let prev: string | undefined;
		for (const r of this.store.revisions()) {
			const src = r.world.functions[name];
			if (src !== undefined && src !== prev && !r.rollbackOf) last = r;
			prev = src;
		}
		return last && { revision: last.id, reason: last.reason, asked: last.asked };
	}
}

export { LAYERS };
