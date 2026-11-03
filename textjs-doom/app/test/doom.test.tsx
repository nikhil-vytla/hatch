import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "@textjs/app/testing";
import Page from "../app/page";

afterEach(cleanup);

// Average colour of the half-block cells in a rectangle, as a crude "is something drawn" probe.
function cellColours(app: any, cols: number, rows: number) {
  const seen = new Set<string>();
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const c = app.cell(x, y);
    if (c?.char === "▀") seen.add(`${c.fg}/${c.bg}`);
  }
  return seen;
}

test("boots Doom and draws the title screen as half-block pixels", async () => {
  const app = await render(<Page />, { cols: 120, rows: 46 });
  await app.waitFor(() => expect(cellColours(app, 120, 45).size).toBeGreaterThan(50), { timeout: 10000 });
  await Bun.write("test/title.ansi", app.toAnsi());
}, 20000);

test("menu -> new game -> E1M1, then walk forward", async () => {
  const app = await render(<Page />, { cols: 120, rows: 46 });
  await app.waitFor(() => expect(cellColours(app, 120, 45).size).toBeGreaterThan(50), { timeout: 10000 });
  for (const k of ["escape", "return", "return", "return"]) { await app.press(k); await app.wait(700); }
  await app.wait(1500);
  const before = app.toAnsi();
  for (let i = 0; i < 6; i++) { await app.press("up"); await app.wait(120); }
  await app.wait(400);
  await Bun.write("test/e1m1.ansi", app.toAnsi());
  expect(app.toAnsi()).not.toEqual(before);
}, 30000);
