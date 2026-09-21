async (page) => {
  await page.goto("http://127.0.0.1:5193/#experiment/ghost-brush"); await page.reload();
  await page.getByRole("button", { name: "Blue fabric", exact: true }).click();
  await page.getByRole("button", { name: "Draw a sample", exact: true }).click();
  const sheet = page.getByRole("application"); await sheet.focus(); await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Control+z");
  if (!(await page.locator(".gb-counter").textContent()).includes("01")) throw new Error("Active undo removed the prior completed stroke");
  if (!(await page.locator(".gb-status").textContent()).includes("Lift the pen")) throw new Error("Active undo guard did not run");
  await page.keyboard.press("Space");
  if (!(await page.locator(".gb-counter").textContent()).includes("02")) throw new Error("Active stroke was lost");
  await page.locator(".gb-history > summary").click();
  await page.getByRole("textbox", { name: "Variant name" }).fill("Recorded provenance");
  await page.getByRole("button", { name: "Preserve", exact: true }).click();
  await page.getByRole("button", { name: /Use Coral nerve/ }).click();
  await page.getByRole("button", { name: /Recorded provenance.*restore/ }).click();
  if (!(await page.locator(".gb-source").textContent()).includes("Recorded Jev")) throw new Error("Restored recorded brush lost its attribution");
  return { checks: ["Control+Z during an active second stroke preserves the first and active strokes", "Restoring a recorded brush variant restores Recorded Jev attribution"], count: 2, realModelCalls: 0 };
}
