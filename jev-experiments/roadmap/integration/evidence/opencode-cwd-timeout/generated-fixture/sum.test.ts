import { expect, test } from "bun:test";
import { totalThrough } from "./sum";
test("inclusive total", () => { expect(totalThrough(0)).toBe(0); expect(totalThrough(1)).toBe(1); expect(totalThrough(4)).toBe(10); });
