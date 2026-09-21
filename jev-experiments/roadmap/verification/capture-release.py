"""Capture current production UI in the already opened jev-release browser.

This is a bounded visual/overflow check, not a full accessibility audit. Existing
functional reports cover editing, input, branching, exports and cancellation.
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
cases = [
    ('home-desktop-final', '/', 1440, 1000, 'light'),
    ('home-mobile-final', '/', 390, 844, 'light'),
    ('materials-dark-final', '/materials', 1440, 1000, 'dark'),
    ('routing-mobile-final', '/routing', 390, 844, 'dark'),
    ('study-desktop-final', '/#experiment/local-models', 1440, 1000, 'light'),
    ('study-mobile-final', '/#experiment/local-models', 390, 844, 'dark'),
]
rows = []
for name, route, width, height, theme in cases:
    target = HERE / 'screenshots' / (name + '.png')
    code = """async page => {
      await page.setViewportSize(SIZE);
      await page.emulateMedia({reducedMotion:'reduce',colorScheme:THEME});
      await page.goto(URL);
      await page.getByRole('button',{name:THEME+' theme',exact:true}).click();
      await page.locator('main').waitFor();
      if(page.url().includes('local-models')) await page.locator('.typed-study').waitFor();
      else if(page.url().includes('routing')) await page.getByRole('button',{name:'Show recorded example',exact:true}).waitFor();
      else await page.locator('main canvas').first().waitFor();
      await page.waitForTimeout(500);
      await page.screenshot({path:TARGET});
      return await page.evaluate(() => ({
        title:document.title,
        heading:document.querySelector('h1')?.textContent,
        footer:document.querySelector('footer')?.innerText,
        horizontalOverflow:document.documentElement.scrollWidth>innerWidth,
        viewport:{width:innerWidth,height:innerHeight},
        reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,
        canvasBounds:[...document.querySelectorAll('main canvas')].map(canvas=>{
          const r=canvas.getBoundingClientRect();return {top:r.top,bottom:r.bottom,width:r.width,height:r.height};
        })
      }));
    }""".replace('SIZE', json.dumps({'width': width, 'height': height})).replace('THEME', json.dumps(theme)).replace('URL', json.dumps('http://127.0.0.1:5195' + route)).replace('TARGET', json.dumps(str(target)))
    result = subprocess.run([str(WRAPPER), '--session', 'jev-release', 'run-code', code], cwd=ROOT, text=True, capture_output=True, timeout=45)
    match = re.search(r'### Result\n(.*?)\n### ', result.stdout, re.S)
    if result.returncode or not match:
        raise RuntimeError(result.stdout + result.stderr)
    row = {'name': name, 'route': route, 'theme': theme, **json.loads(match.group(1)),
           'screenshot': str(target.relative_to(HERE)), 'bytes': target.stat().st_size,
           'sha256': hashlib.sha256(target.read_bytes()).hexdigest()}
    row['passed'] = not row['horizontalOverflow'] and row['bytes'] < 2_000_000 and 'Not affiliated with or endorsed by TypeSafe AI' in (row['footer'] or '')
    rows.append(row)
    print(name, row['passed'], row['bytes'], flush=True)
report = {'recordedAtUtc': datetime.now(timezone.utc).isoformat(),
          'conditions': 'Production preview in Chromium. Emulated viewports, reduced motion and explicit theme. Captures and overflow/footer assertions; physical-phone testing is not claimed.',
          'scriptSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
          'cases': rows, 'passed': all(row['passed'] for row in rows)}
(HERE / 'visual-release.json').write_text(json.dumps(report, indent=2) + '\n')
if not report['passed']:
    raise SystemExit(1)
