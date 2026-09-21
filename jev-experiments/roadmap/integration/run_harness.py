#!/usr/bin/env python3
"""Run real CLI clients in isolated, generated fixture repos. Save sanitized evidence."""
import argparse,json,os,pathlib,subprocess,tempfile,time
HERE=pathlib.Path(__file__).resolve().parent
MCP=HERE.parent/'routing/mcp.ts'
ROUTER=HERE/'examples/router.json'
SOURCE='export function totalThrough(n: number): number {\n  let total = 0;\n  for (let i = 1; i < n; i++) total += i;\n  return total;\n}\n'
TEST='import { expect, test } from "bun:test";\nimport { totalThrough } from "./sum";\ntest("inclusive total", () => { expect(totalThrough(0)).toBe(0); expect(totalThrough(1)).toBe(1); expect(totalThrough(4)).toBe(10); });\n'
PROMPT='''This is an isolated MCP integration fixture. Use the Jev route_task MCP tool for THREE separate bounded delegations: (1) fix the inclusive-sum bug in sum.ts, returning a patch; (2) write additional Bun tests for boundary cases, returning a patch; (3) analyze this tiny repository and return a structured explanation. For each delegation, read and supply the complete relevant source in task.context, and specify outputTokens 2048. The delegate cannot read files or run tools. Actually call route_task, do not emulate it or merely describe a call. Inspect each returned artifact, apply suitable proposed edits yourself through your normal file tools, and run bun test independently. Also actually call route_task with requiredTools ["shell"] and explain its no-route result without loosening restrictions. Finally call decide with a valid question requesting unsupported kind "image" and explain the unsupported result. Do not change config files. Write ANALYSIS.md recording the analysis, test result, and failure handling. Report whether all MCP calls happened. Work only in this fixture directory.'''
def sanitize(value):
    if isinstance(value,dict):return {k:sanitize(v) for k,v in value.items() if k.lower() not in {'responseheaders','requestheaders','headers','authorization','api_key','apikey','set-cookie','cookie'}}
    if isinstance(value,list):return [sanitize(v) for v in value]
    if isinstance(value,str):
        for k,v in os.environ.items():
            if any(x in k for x in ['API_KEY','TOKEN','SECRET','PASSWORD']) and len(v)>8:value=value.replace(v,'[REDACTED]')
        return value
    return value
def safe_lines(text):
    out=[]
    for line in text.splitlines():
        try:out.append(json.dumps(sanitize(json.loads(line))))
        except json.JSONDecodeError:out.append(sanitize(line))
    return '\n'.join(out)+'\n'
def run(name,timeout,evidence_name=None):
    directory=pathlib.Path(tempfile.mkdtemp(prefix='jev-'+name+'-')).resolve()
    evidence=HERE/'evidence'/(evidence_name or name)
    if evidence.exists():raise RuntimeError('Preserve existing evidence; choose a new --evidence-name.')
    evidence.mkdir(parents=True)
    (directory/'sum.ts').write_text(SOURCE);(directory/'sum.test.ts').write_text(TEST)
    subprocess.run(['git','init','-q'],cwd=directory,check=True)
    subprocess.run(['git','add','.'],cwd=directory,check=True)
    before=subprocess.run(['bun','test'],cwd=directory,capture_output=True,text=True)
    audit=evidence/'mcp-audit.jsonl'
    if audit.exists():audit.unlink()
    env={**os.environ,'JEV_ROUTER_CONFIG':str(ROUTER),'JEV_MCP_AUDIT':str(audit)}
    server={'command':'bun','args':[str(MCP)],'env':{'JEV_ROUTER_CONFIG':str(ROUTER),'JEV_MCP_AUDIT':str(audit)}}
    mcp_config=directory/'mcp.json';mcp_config.write_text(json.dumps({'mcpServers':{'jev':server}}))
    original_mcp=mcp_config.read_bytes();original_router=ROUTER.read_bytes()
    if name=='opencode':
        # OpenCode matches read/edit permission patterns relative to its worktree.
        # --dir pins that worktree; deny external paths and allow only authored fixture files.
        file_scope={'*':'deny','sum.ts':'allow','*.test.ts':'allow','ANALYSIS.md':'allow'}
        permission={'*':'deny','read':file_scope,'glob':'allow','grep':'allow','edit':file_scope,'external_directory':'deny','bash':{'*':'deny','bun test':'allow','git diff':'allow'},'jev_*':'allow'}
        config={'$schema':'https://opencode.ai/config.json','share':'disabled','snapshot':False,'autoupdate':False,'permission':permission,'mcp':{'jev':{'type':'local','command':['bun',str(MCP)],'environment':server['env'],'enabled':True}},'agent':{'jev-fixture':{'description':'Run isolated integration fixture','mode':'primary','steps':30,'permission':permission}}}
        env['OPENCODE_CONFIG_CONTENT']=json.dumps(config)
        command=['opencode','run','--dir',str(directory),'--pure','--format','json','--agent','jev-fixture','--model','amazon-bedrock/global.anthropic.claude-fable-5-1']
    elif name=='claude':
        command=['claude','--bare','--strict-mcp-config','--mcp-config',str(mcp_config),'--model','claude-sonnet-4-6','--permission-mode','acceptEdits','--allowedTools','Read,Write,Edit,Glob,Grep,Bash(bun test*),Bash(git diff*),Bash(git apply*),mcp__jev__route_task,mcp__jev__decide','--output-format','stream-json','--verbose','--no-session-persistence','-p']
    else:
        command=['codex','exec','--ignore-user-config','--ephemeral','--json','--sandbox','workspace-write','-c','approval_policy="never"','-c','mcp_servers.jev.tools.route_task.approval_mode="approve"','-c','mcp_servers.jev.tools.decide.approval_mode="approve"','-c','mcp_servers.jev.command="bun"','-c','mcp_servers.jev.args='+json.dumps([str(MCP)]),'-c','mcp_servers.jev.env='+json.dumps(server['env']).replace(': ', ' = '),'-']
    started=time.monotonic()
    try:
        result=subprocess.run(command,input=PROMPT,cwd=directory,env=env,capture_output=True,text=True,timeout=timeout)
        status={'exitCode':result.returncode,'timedOut':False};stdout=result.stdout;stderr=result.stderr
    except subprocess.TimeoutExpired as e:
        status={'exitCode':None,'timedOut':True};stdout=e.stdout or b'';stderr=e.stderr or b''
        if isinstance(stdout,bytes):stdout=stdout.decode(errors='replace')
        if isinstance(stderr,bytes):stderr=stderr.decode(errors='replace')
    after=subprocess.run(['bun','test'],cwd=directory,capture_output=True,text=True)
    diff=subprocess.run(['git','diff'],cwd=directory,capture_output=True,text=True)
    events=[json.loads(l) for l in audit.read_text().splitlines()] if audit.exists() else []
    calls=[x for x in events if x['event']=='tools/call'];results=[x for x in events if x['event']=='tools/result']
    summary={'harness':name,'directory':str(directory),'command':command,'elapsedSeconds':round(time.monotonic()-started,2),**status,'baselineTestsExitCode':before.returncode,'independentTestsExitCode':after.returncode,'mcpDiscovered':any(x['event']=='tools/list' for x in events),'toolCalls':calls,'toolResults':results,'patchedBug':'i <= n' in (directory/'sum.ts').read_text(),'analysisFileWritten':(directory/'ANALYSIS.md').exists(),'additionalTestsWritten':(directory/'sum.test.ts').read_text()!=TEST or any(p.name!='sum.test.ts' for p in directory.glob('*.test.ts')),'mcpConfigUnchanged':mcp_config.read_bytes()==original_mcp,'routerConfigUnchanged':ROUTER.read_bytes()==original_router}
    for filename,content in [('stdout.jsonl',safe_lines(stdout)),('stderr.txt',safe_lines(stderr)),('tests-before.txt',safe_lines(before.stdout+before.stderr)),('tests-after.txt',safe_lines(after.stdout+after.stderr)),('host.diff',diff.stdout),('prompt.txt',PROMPT)]: (evidence/filename).write_text(content)
    for p in directory.iterdir():
        if p.is_file() and (p.name=='ANALYSIS.md' or p.name.endswith('.test.ts')):(evidence/('final-'+p.name)).write_text(p.read_text())
    (evidence/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
    from evidence_index import annotate
    annotate(evidence)
    print(json.dumps(summary,indent=2))
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('harness',choices=['opencode','claude','codex']);parser.add_argument('--timeout',type=int,default=240);parser.add_argument('--evidence-name');args=parser.parse_args();run(args.harness,args.timeout,args.evidence_name)
