async (page) => {
  await page.goto("http://127.0.0.1:5193/#experiment/ghost-brush");
  await page.reload();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1440, height: 1080 });
  const checks = [];
  const ensure = (condition, name) => { if (!condition) throw new Error(name); checks.push(name); };
  await page.evaluate(async () => (await import("/src/api.ts")).setApiKey("ghost-brush-mocked-browser-test"));
  const requests = [];
  await page.route("**/api/evaluate", route => { requests.push(route); });
  const getRoute = async index => { for (let i = 0; i < 50 && !requests[index]; i++) await page.waitForTimeout(20); if (!requests[index]) throw new Error("Request was not intercepted"); return requests[index]; };
  const fulfill = async route => { const body = route.request().postDataJSON(); const answers = Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: "noul", value: id === "fit_coral-nerve" ? .97 : .08 }])); await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ answers, model: "explicit-browser-test-fixture", source: "mocked" }) }); };
  try {
    await page.getByRole("button", { name: "Ask Jev", exact: true }).click();
    const first = await getRoute(0), sheet = page.getByRole("application"); await sheet.scrollIntoViewIfNeeded(); const b = await sheet.boundingBox();
    await page.mouse.move(b.x + b.width * .25, b.y + b.height * .5); await page.mouse.down();
    for (let i = 0; i < 10; i++) await page.mouse.move(b.x + b.width * (.25 + i * .025), b.y + b.height * (.5 + Math.sin(i) * .1));
    ensure(await page.locator(".gb-drawing path").count() > 0, "pointer ink renders while network request is pending");
    await fulfill(first);
    await page.waitForFunction(() => document.querySelector(".gb-source")?.textContent?.includes("Next: Coral nerve"));
    ensure((await page.locator(".gb-paper-top strong").textContent()) === "Indigo loom", "resolved result waits while pointer stroke remains active");
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector(".gb-paper-top strong")?.textContent === "Coral nerve");
    ensure(true, "queued result applies at pointer-up boundary");
    await page.getByRole("button", { name: /Use Indigo loom/ }).click();
    await page.getByRole("button", { name: "Ask Jev", exact: true }).click(); const second = await getRoute(1);
    await page.getByRole("textbox", { name: "What should the line feel like?" }).fill("A newer golden phrase");
    try { await fulfill(second); } catch {}
    await page.waitForTimeout(50);
    ensure((await page.locator(".gb-paper-top strong").textContent()) === "Indigo loom", "editing cancels an obsolete request without changing the brush");
    ensure((await page.locator(".gb-status").textContent()).includes("Phrase updated"), "late failure does not overwrite the newer edit notice");
    return { checks, count: checks.length, requestsIntercepted: requests.length, realModelCalls: 0, note: "Explicit mocked HTTP responses test lifecycle only; these are not model evidence." };
  } finally { await page.unroute("**/api/evaluate"); await page.evaluate(async () => (await import("/src/api.ts")).setApiKey("")); }
}
