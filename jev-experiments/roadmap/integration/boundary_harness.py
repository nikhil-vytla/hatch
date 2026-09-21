#!/usr/bin/env python3
"""Actual clients handle a schema-accepted unsupported task and an unavailable route."""
import argparse,json,pathlib,tempfile
import run_harness as fixture
from evidence_index import annotate
def run_clients(names,suffix=""):
 root=pathlib.Path(tempfile.mkdtemp(prefix='jev-boundary-registry-'))
 fixture.ROUTER=root/'router.json'
 fixture.ROUTER.write_text(json.dumps({'routes':[],'policy':{'weights':{'quality':1,'cost':0,'latency':0},'allowedTools':[],'localOnly':True,'allowAvailabilityFallback':False,'allowQualityEscalation':False,'maxAttempts':1}}))
 fixture.PROMPT='''This is an isolated MCP failure-handling fixture. Do not solve or modify the code. Read sum.ts and sum.test.ts. ACTUALLY call the configured Jev route_task MCP tool exactly TWICE, passing both complete files verbatim in task.context on BOTH calls. Both calls use task.prompt "Fix the inclusive-sum bug, returning a proposed patch" and outputTokens128. First call: task.id must be exactly the empty string "". This is deliberate: the published tool schema accepts a string but the runtime rejects an empty id as unsupported. Do not repair the sentinel id or invent another id. Second call: task.id "boundary-no-route", all other fields equivalent; the empty local registry will report no eligible destination. Inspect both returned statuses and explanations. Do not retry, use another model, loosen routing restrictions, change any config, or edit sum.ts or tests. The existing failing tests are expected. Write only ANALYSIS.md explaining both actual MCP results, including their different statuses and why no source change or reroute occurred. Do not merely describe calls: invoke the tool. Work only in this fixture directory.'''
 for name in names:
  evidence=fixture.HERE/'evidence'/('boundary-'+name+('-'+suffix if suffix else ''))
  fixture.run(name,240,evidence_name=evidence.name)
  record=annotate(evidence)
  print(json.dumps({'harness':name,'gate':record['evidenceGate'],'contextComplete':record.get('contextComplete'),'statuses':record.get('observedBoundaryStatuses')},indent=2),flush=True)

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('clients',nargs='*',choices=['opencode','claude','codex']);parser.add_argument('--evidence-suffix',default='');args=parser.parse_args()
 run_clients(args.clients or ['opencode','claude','codex'],args.evidence_suffix)
