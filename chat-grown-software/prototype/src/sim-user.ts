// A simulated user for runs without a person at the keyboard. They know what they want: the intended program for
// each turn is the scenario's own forms (the code written as the stand-in for a correct model). They answer each of
// the kernel's questions by what that intended program does. A real user is slower and sometimes wrong; this one
// never is, so results with it are an upper bound on what confirmation can catch.
import type { Question } from "./ask.ts";
import type { Turn } from "./scenario.ts";
import { World } from "./world.ts";

/** The functions the user has in mind after `turnIndex` turns of the intended scenario. */
export function intendedFunctions(turns: Turn[], turnIndex: number): Record<string, string> {
	const world = new World();
	for (const t of turns.slice(0, turnIndex + 1)) {
		for (const name of t.proposal.removes ?? []) world.remove(name);
		for (const form of t.proposal.forms) world.define(form);
	}
	return world.snapshot().functions;
}

export function answer(functions: Record<string, string>, q: Question): unknown {
	const world = new World({ functions, state: q.fixture });
	try {
		return world.evaluate(q.expr);
	} catch (e) {
		return /timed out/.test(String((e as Error).message)) ? "timeout" : "error";
	}
}

export class SimulatedUser {
	private turn = -1;
	readonly turns: Turn[];
	corrections = 0;
	constructor(turns: Turn[]) {
		this.turns = turns;
	}
	/** The next thing the user says, or undefined when they are done. */
	says(): string | undefined {
		this.turn++;
		return this.turns[this.turn]?.user;
	}
	/** Answer the kernel's questions: confirm what the candidate does, or say what it should do instead. */
	answer(qs: Question[]): unknown[] {
		const fns = intendedFunctions(this.turns, this.turn);
		return qs.map((q) => {
			const a = answer(fns, q);
			if (JSON.stringify(a) !== JSON.stringify(q.answer)) this.corrections++;
			return a;
		});
	}
}
