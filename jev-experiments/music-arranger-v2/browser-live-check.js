async (page) => {
  // A local intercepted request verifies cancellation. No owner key or provider call.
  let calls = 0;
  await page.unroute("**/api/evaluate");
  await page.route("**/api/evaluate", async route => {
    calls++;
    const request = route.request().postDataJSON();
    await page.waitForTimeout(700);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ answers: { phrase: { type: "choice", value: request.state.candidates[0].id, probabilities: { [request.state.candidates[0].id]: 1 }, confidence: 1 } }, source: "test-intercept", model: "test-only" }) }).catch(() => {});
  });
  try {
    await page.evaluate(async () => { const api = await import("/src/api.ts"); api.setApiKey("test-only-intercepted-request"); });
    await page.getByRole("button", { name: "Ask Jev for a phrase", exact: true }).click();
    await page.getByRole("button", { name: "Lock phrase 1", exact: true }).click();
    await page.waitForTimeout(900);
    const recommendations = await page.locator(".ma-recommendation").count();
    if (recommendations !== 0 || calls !== 1) throw new Error(`Stale-response guard failed: ${recommendations} recommendations, ${calls} requests`);
    await page.getByRole("button", { name: "Unlock phrase 1", exact: true }).click();
    return { interceptedRequests: calls, staleRecommendations: recommendations, apiKey: "test-only value cleared", providerRequests: 0 };
  } finally {
    await page.evaluate(async () => { const api = await import("/src/api.ts"); api.setApiKey(""); });
    await page.unroute("**/api/evaluate");
  }
}
