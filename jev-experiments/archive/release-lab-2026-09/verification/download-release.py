"""Click the production routing/study downloads and verify their exact bytes.

Run after the final build and evidence-assets.ts. Reuses the opened jev-release
Playwright CLI session; no provider calls or installation commands are executed.
"""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
WRAPPER = Path.home() / '.codex/skills/playwright/scripts/playwright_cli.sh'
asset_report = json.loads((HERE / 'evidence-assets.json').read_text())
assert asset_report['passed']
source_by_url = {}
for item in asset_report['files']:
    for asset in item['builtAssets']:
        source_by_url['/assets/' + Path(asset).name] = item
rows = []
for scene, route in [('routing', '/routing'), ('study', '/#experiment/local-models')]:
    code = """async page => {
      await page.setViewportSize({width:390,height:844});
      await page.emulateMedia({reducedMotion:'reduce',colorScheme:'dark'});
      await page.goto(URL);
      await page.getByRole('button',{name:'dark theme',exact:true}).click();
      const names=SCENE==='routing'
        ? ['Use the CLI or connect your coding tool','Protocols and comparison evidence','OpenCode: actual delegation evidence','Claude Code: actual delegation evidence','Codex: actual delegation evidence']
        : ['Run a typed decision locally on a Mac','Selection, baselines and source evidence'];
      for(const name of names) await page.getByText(name,{exact:true}).click();
      const rows=[],seen=new Set();
      const count=SCENE==='study'?await page.locator('.study-models button').count():1;
      for(let model=0;model<count;model++) {
        if(SCENE==='study') await page.locator('.study-models button').nth(model).click();
        const links=page.locator(SCENE==='study'?'.typed-study a[download]':'main a[download]');
        for(let i=0;i<await links.count();i++) {
          const link=links.nth(i);
          if(!await link.isVisible())continue;
          const url=await link.getAttribute('href');
          if(seen.has(url))continue;
          seen.add(url);
          const event=page.waitForEvent('download');
          await link.click();
          const download=await event;
          const file='.playwright-cli/jev-public-'+download.suggestedFilename().split('/').at(-1);
          await download.saveAs(file);
          rows.push({label:await link.innerText(),url,file,failure:await download.failure()});
          await page.waitForTimeout(500);
        }
      }
      return {rows,horizontalOverflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)};
    }""".replace('URL', json.dumps('http://127.0.0.1:5195' + route)).replace('SCENE', json.dumps(scene))
    result = subprocess.run([str(WRAPPER), '--session', 'jev-release', 'run-code', code], cwd=ROOT, text=True, capture_output=True, timeout=90)
    match = re.search(r'### Result\n(.*?)\n### ', result.stdout, re.S)
    if result.returncode or not match:
        raise RuntimeError(result.stdout + result.stderr)
    group = json.loads(match.group(1))
    if group['horizontalOverflow']:
        raise RuntimeError(f'{scene} download section overflowed at 390 px')
    for row in group['rows']:
        source = source_by_url[row['url']]
        content = (ROOT / row['file']).read_bytes()
        row.update(scene=scene, source=source['source'], bytes=len(content),
                   sha256=hashlib.sha256(content).hexdigest())
        row['identical'] = row['sha256'] == source['sha256'] == hashlib.sha256((ROOT / source['source']).read_bytes()).hexdigest()
        rows.append(row)
    print(scene, len(group['rows']), 'downloads', flush=True)
report = {'recordedAtUtc': datetime.now(timezone.utc).isoformat(),
          'conditions': 'Current production preview, 390 px Chromium, dark theme and reduced motion. Actual link clicks with 500 ms between downloads. All three study tabs visited. Each downloaded file compared with both the production asset audit and current source.',
          'scriptSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
          'files': rows,
          'passed': len(rows) >= 56 and all(row['identical'] and row['failure'] is None for row in rows)}
(HERE / 'downloads-release.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'files': len(rows), 'passed': report['passed']}))
if not report['passed']:
    raise SystemExit(1)
