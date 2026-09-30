import { expect, test } from "bun:test";
import notices from "./notices.json";
import { PROBES } from "./probes";

test("the scene's probe list matches the recorded notices", () => {
  expect(PROBES.map((p) => [p.id, p.probe])).toEqual(notices.notices.map((n) => [n.id, n.probe]));
});
