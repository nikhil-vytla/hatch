import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyMacEml,
  createMacAdapter,
  type MacRuntimeConfig,
} from "./mac-adapter";
import { decide } from "./decide";
import models from "../mac/models.json";
const request = {
  schemaVersion: "1" as const,
  requestId: "wiring",
  state: "Synthetic input",
  questions: [{ id: "q", kind: "boolean" as const, prompt: "True?" }],
};
test("explicit Mac bridge passes stdin and selected model without a cloud fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-local-bridge-test-")),
    executable = join(directory, "mock-local");
  const config: MacRuntimeConfig = {
      executable,
      dataDirectory: directory,
      model: "laya-base-experimental",
    },
    identity = createMacAdapter(config).identity;
  const stub = `#!/usr/bin/env bun\nconst args=process.argv.slice(2);if(args[0]==='decide'){const request=JSON.parse(await Bun.stdin.text());console.log(JSON.stringify({schemaVersion:'1',requestId:request.requestId,status:'ok',decisions:[{questionId:'q',selected:true,distribution:[{value:false,probability:0},{value:true,probability:1}]}],execution:${JSON.stringify(identity)},timing:{totalMs:0},issues:[]}));}else{console.log(JSON.stringify({status:'ok',source:args.at(-1),received:await Bun.file(args.at(-1)).text(),model:args[2]}));}`;
  try {
    await writeFile(executable, stub, { mode: 0o700 });
    const result = await decide(request, { adapter: createMacAdapter(config) });
    expect(result.status).toBe("ok");
    expect(result.execution.revision).toBe(
      models.models["laya-base-experimental"].revision,
    );
    const eml = "Subject: Synthetic receipt\n\nPayment received";
    const email = await classifyMacEml(eml, config);
    expect(email.received).toBe(eml);
    expect(email.model).toBe("laya-base-experimental");
    expect(
      await access(email.source).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("missing explicitly selected local executable returns an error, never a baseline", async () => {
  const result = await decide(request, {
    adapter: createMacAdapter({
      executable: "/nonexistent/jev-test-local",
      dataDirectory: "/nonexistent",
      model: "laya-base-experimental",
    }),
  });
  expect(result.status).toBe("error");
  expect(result.execution.adapter).toBe("jev-local-mlx");
  expect(result.decisions).toEqual([]);
});
