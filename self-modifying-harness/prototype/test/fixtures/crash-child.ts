// Child process of test/crash-migration.test.ts: proposes cell versions against the data directory in argv[2].
//   seed     accepts counter v1 and adds 2 to its state;
//   upgrade  proposes counter v2, whose migration multiplies the count by ten. With FORGE_CRASH_AFTER_MIGRATION=counter in
//            the environment this process dies (exit 137) after the migration committed and before the catalog did.
import { catalogueOf, type Forge, openForge, propose, version } from "../support.ts";

const dir = process.argv[2];

const phase = process.argv[3];

const PARAMETERS = { type: "object", properties: { by: { type: "integer", minimum: 0, maximum: 5 } }, required: ["by"] };

const CHECKS = [{ args: { by: 2 }, expect: 2 }];

const SOURCE = "const n = (await kv.get('n')) ?? 0; await kv.put('n', n + args.by); return n + args.by;";

async function run(forge: Forge): Promise<void> {
	if (phase === "seed") {
		const v1 = version("counter", SOURCE, { parameters: PARAMETERS, checks: CHECKS });
		const done = await propose(forge, v1, { expectLive: null, owned: [], changes: [] });

		if (!done.ok) throw new Error(`seed rejected: ${done.reason}`);

		await forge.runtime.call(v1, "counter", { by: 2 }, "seed:1");

		return;
	}

	const live = (await catalogueOf(forge)).cells.counter.live;
	const migrate = "await kv.put('n', ((await kv.get('n')) ?? 0) * 10);";
	const v2 = version("counter", `${SOURCE} // v2`, { parameters: PARAMETERS, checks: CHECKS, migrate, parent: live ?? undefined });
	const done = await propose(forge, v2, { expectLive: live, owned: [], changes: [] });

	if (!done.ok) throw new Error(`upgrade rejected: ${done.reason}`);
}

const forge = await openForge(dir);

try {
	await run(forge);
} finally {
	await forge.close();
}
