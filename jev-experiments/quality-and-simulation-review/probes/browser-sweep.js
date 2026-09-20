async page => {
  const ids = ['paste','ui','worlds','games','music','pixels','semantic-table','undo','changes','logos','beverage','journeys','decisions','routing','verify','search','context','micro','vision','classify','judge','robustness','latency','optimize','teach','reward','replica','rewardbench2','adapters','snake','orbital','local-models','benchmark-atlas'];
  const checks = [];
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  for (const id of ids) {
    await page.goto('https://jev-experiments.vercel.app/#experiment/' + id);
    await page.locator('.record-footer').waitFor({timeout:15000});
    await page.locator('.loading-stage').waitFor({state:'hidden',timeout:15000});
    if (id === 'ui') await page.getByRole('button', {name:'Replay recorded build',exact:true}).waitFor();
    checks.push(await page.evaluate(() => ({url:location.href,title:document.querySelector('h1')?.textContent,viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,alerts:[...document.querySelectorAll('[role=alert]')].map(x=>x.textContent),headings:[...document.querySelectorAll('h2,h3')].map(x=>x.textContent),buttons:[...document.querySelectorAll('main button')].map(x=>x.textContent?.trim()).filter(Boolean)})));
  }
  return {checkedAt: new Date().toISOString(), checks, errors};
}
