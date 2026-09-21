"""Measure active scenes in an already opened Playwright CLI browser session.

Run only while model training and inference measurements are stopped. The
production preview must already be running. This observes browser scheduling,
not physical display frame delivery or audio quality.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path
import subprocess
from datetime import datetime, timezone

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--scene', choices=['materials', 'crowd', 'tetris', 'music'], required=True)
parser.add_argument('--viewport', choices=['desktop', 'mobile'], required=True)
parser.add_argument('--url', default='http://127.0.0.1:5195')
parser.add_argument('--session', default='jev-performance')
parser.add_argument('--wrapper', default=str(Path.home() / '.codex/skills/playwright/scripts/playwright_cli.sh'))
args = parser.parse_args()
output = HERE / f'frames-{args.scene}-{args.viewport}.json'
if output.exists():
    raise SystemExit(f'Refusing to replace an existing measurement: {output}')
size = {'width': 1440, 'height': 1000} if args.viewport == 'desktop' else {'width': 390, 'height': 844}
path = '/materials' if args.scene == 'materials' else f'/#experiment/{args.scene}'
start = {
    'materials': "if (await page.getByRole('button', {name:'Play',exact:true}).count()) await page.getByRole('button', {name:'Play',exact:true}).click(); await page.getByRole('button', {name:'Pause',exact:true}).waitFor();",
    'crowd': "if (await page.getByRole('button', {name:'Play courtyard',exact:true}).count()) await page.getByRole('button', {name:'Play courtyard',exact:true}).click(); await page.getByRole('button', {name:'Pause courtyard',exact:true}).waitFor();",
    'tetris': "await page.getByRole('button', {name:'Start both',exact:true}).click(); await page.getByRole('button', {name:'Pause both',exact:true}).waitFor();",
    'music': "await page.getByRole('button', {name:'Play arrangement',exact:true}).click(); await page.getByRole('button', {name:'Stop playback',exact:true}).waitFor(); await page.waitForFunction(() => document.querySelector('.ma-play-status')?.textContent?.includes('Playing bar'));",
}[args.scene]
stop = {
    'materials': "await page.getByRole('button', {name:'Pause',exact:true}).click();",
    'crowd': "await page.getByRole('button', {name:'Pause courtyard',exact:true}).click();",
    'tetris': "await page.getByRole('button', {name:'Pause both',exact:true}).click();",
    'music': "await page.getByRole('button', {name:'Stop playback',exact:true}).click();",
}[args.scene]
code = """async (page) => {
 const apiAttempts=[];
 await page.route('**/api/**', route=>{
   apiAttempts.push({method:route.request().method(),path:new URL(route.request().url()).pathname});
   return route.abort();
 });
 await page.setViewportSize(SIZE);
 await page.emulateMedia({reducedMotion:'no-preference',colorScheme:'light'});
 await page.addInitScript(() => {
   if(window.__jevFrames)return;
   const nativeFrame=window.requestAnimationFrame.bind(window);
   window.__jevFrames={active:false,callbacks:[],longTasks:[],nativeFrame};
   window.requestAnimationFrame=callback=>nativeFrame(time=>{
     const started=performance.now();
     try { callback(time); }
     finally { if(window.__jevFrames.active) window.__jevFrames.callbacks.push({time,duration:performance.now()-started}); }
   });
   if(PerformanceObserver.supportedEntryTypes.includes('longtask')) {
     const observer=new PerformanceObserver(list=>{
       if(window.__jevFrames.active) for(const entry of list.getEntries()) window.__jevFrames.longTasks.push({start:entry.startTime,duration:entry.duration});
     });
     observer.observe({type:'longtask',buffered:false});
   }
 });
 await page.goto(URL);
 await page.getByRole('button',{name:'light theme',exact:true}).click();
 START
 await page.waitForTimeout(2000);
 const measurement=await page.evaluate(async()=>{
   const state=window.__jevFrames;
   state.callbacks=[];state.longTasks=[];state.active=true;
   const begin=performance.now(),intervals=[];
   let previous=null;
   await new Promise(resolve=>{
     function frame(time){
       if(previous!==null)intervals.push(time-previous);
       previous=time;
       if(performance.now()-begin>=10000)resolve();else state.nativeFrame(frame);
     }
     state.nativeFrame(frame);
   });
   state.active=false;
   const byFrame=new Map();
   for(const row of state.callbacks)byFrame.set(row.time,(byFrame.get(row.time)||0)+row.duration);
   const summarize=values=>{
     const sorted=values.slice().sort((a,b)=>a-b);
     return {count:sorted.length,medianMs:sorted[Math.floor(sorted.length*.5)]??null,p95Ms:sorted[Math.floor(sorted.length*.95)]??null,maxMs:sorted.at(-1)??null};
   };
   return {elapsedMs:performance.now()-begin,frameIntervals:summarize(intervals),animationCallbackWork:summarize([...byFrame.values()]),intervalsOver33Ms:intervals.filter(x=>x>33).length,longTasks:state.longTasks,rawIntervalsMs:intervals,visible:!document.hidden,viewport:{width:innerWidth,height:innerHeight,devicePixelRatio},horizontalOverflow:document.documentElement.scrollWidth>innerWidth,userAgent:navigator.userAgent,sourceText:document.querySelector('main')?.innerText?.slice(0,2500)};
 });
 STOP
 await page.unroute('**/api/**');
 return {jevFrameResult:{...measurement,apiRequestAttempts:apiAttempts}};
}""".replace('SIZE', json.dumps(size)).replace('URL', json.dumps(args.url + path)).replace('START', start).replace('STOP', stop)
result = subprocess.run([args.wrapper, '--session', args.session, 'run-code', code], cwd=ROOT, text=True, capture_output=True, timeout=50)
match = re.search(r'### Result\n(.*?)\n### ', result.stdout, re.S)
if result.returncode or not match:
    print(result.stdout)
    print(result.stderr)
    raise SystemExit('Browser measurement did not return exactly one result')
report = {'recordedAtUtc': datetime.now(timezone.utc).isoformat(), 'scene': args.scene, 'condition': args.viewport,
          'productionPreview': args.url, 'scriptSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
          'productionAssets': {str(path.relative_to(ROOT / 'jev-experiments/experience-prototypes/dist')): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted((ROOT / 'jev-experiments/experience-prototypes/dist/assets').glob('*')) if path.is_file()},
          'conditions': 'Active default local scene, light theme, motion enabled; 2 s warmup and 10 s sample. Separate browser viewport sizes, not physical mobile hardware. API requests are blocked and attempts recorded. Animation callback timing omits asynchronous React/layout/paint work; frame intervals and long tasks provide broader scheduling observations.',
          **json.loads(match.group(1))['jevFrameResult']}
output.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({key: value for key, value in report.items() if key not in ['rawIntervalsMs', 'sourceText', 'productionAssets']}, indent=2))
