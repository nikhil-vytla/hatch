#!/usr/bin/env python3
"""Derive evidence gates without changing raw client transcripts or measured outcomes."""
import json,pathlib
HERE=pathlib.Path(__file__).resolve().parent
VERSIONS={'opencode':'1.18.31','claude':'2.1.278','codex':'0.154.0'}
HISTORICAL={'boundary-opencode':'Absolute permission patterns prevented the required explanation file despite two correct MCP results. Corrected relative-path condition is retained separately.','opencode-cwd-timeout':'Effective project cwd differed from subprocess cwd; timed out without completing host application.','claude-fable-unavailable':'The host provider rejected the configured Fable request before any delegation.','codex-approval-default':'Client approval rejected all MCP calls before server invocation; the host fixed the task itself.'}
def transcript_objects(value,depth=0):
    if depth>24:return
    if isinstance(value,dict):
        yield value
        for child in value.values():yield from transcript_objects(child,depth+1)
    elif isinstance(value,list):
        for child in value:yield from transcript_objects(child,depth+1)
    elif isinstance(value,str) and value.lstrip().startswith(('{','[')):
        try:parsed=json.loads(value)
        except json.JSONDecodeError:return
        yield from transcript_objects(parsed,depth+1)
def annotate(folder):
    if (folder/'summary.portable.json').exists():
        raise ValueError('Historical derivatives cannot be re-annotated; use portable-index.ts.')
    path=folder/'summary.json';record=json.loads(path.read_text());audit=folder/'mcp-audit.jsonl'
    events=[json.loads(line) for line in audit.read_text().splitlines()] if audit.exists() else []
    artifacts=[event for event in events if event.get('event')=='tools/result' and event.get('tool')=='route_task' and event.get('status')=='ok' and event.get('artifactKind') in ['patch','answer','structured']]
    calls=[event for event in events if event.get('event')=='tools/call']
    record['delegationOccurred']=bool(artifacts)
    record['usableDelegatedArtifacts']=len(artifacts)
    record['cliVersion']=record.get('cliVersion',VERSIONS[record['harness']])
    command=record.get('command',[])
    model=command[command.index('--model')+1] if '--model' in command else None
    record['hostModel']={'configured':model,'identityBasis':'command configuration' if model else 'not reported; configured default'}
    record['firstAuditTime']=next((event['time'] for event in events if event.get('time')),None)
    historical=folder.name in HISTORICAL
    if folder.name.startswith('boundary-'):
        from run_harness import SOURCE,TEST
        mode='unsupported-task-and-unavailable-route'
        objects=[]
        for line in (folder/'stdout.jsonl').read_text().splitlines():
            try:objects.extend(transcript_objects(json.loads(line)))
            except json.JSONDecodeError:continue
        requests={obj['task']['id']:obj['task'] for obj in objects if isinstance(obj.get('task'),dict) and obj['task'].get('id') in ['', 'boundary-no-route']}
        results={obj['taskId']:obj for obj in objects if obj.get('schemaVersion')=='1' and 'attempts' in obj and 'selection' in obj and obj.get('taskId') in ['', 'boundary-no-route']}
        record['sourceUnchanged']=(folder/'host.diff').read_text()=='' and not record.get('additionalTestsWritten')
        record['contextComplete']=set(requests)=={'','boundary-no-route'} and all(SOURCE.strip() in request.get('context','') and TEST.strip() in request.get('context','') for request in requests.values())
        record['observedBoundaryStatuses']={key:result['status'] for key,result in results.items()}
        record['noDestinationAttempts']=len(results)==2 and all(result['attempts']==[] and not result.get('outcome',{}).get('artifact') for result in results.values())
        record['boundaryExplanations']={key:result['selection'].get('explanation') for key,result in results.items()}
        passed=bool(len(calls)==2 and all(call.get('tool')=='route_task' for call in calls) and record['observedBoundaryStatuses']=={'':'unsupported','boundary-no-route':'unavailable'} and record['contextComplete'] and record['noDestinationAttempts'] and all(record['boundaryExplanations'].values()) and record['sourceUnchanged'] and record.get('mcpConfigUnchanged') and record.get('routerConfigUnchanged') and record.get('analysisFileWritten') and record.get('exitCode')==0 and not record.get('timedOut'))
        reason='Exactly two actual route_task calls with complete authored context: deliberate empty-id task rejected as unsupported and valid task rejected as unavailable. No destination attempts, source/config edits or reroutes. Unsupported means invalid task contract in this condition, not model capability.'
    elif folder.name.startswith('cancel-'):
        mode='active-interruption'
        passed=bool(record.get('invokedBeforeInterrupt') and record.get('hostExitedBeforeScheduledReply') and not record.get('lateSuccessApplied'))
        reason='The real client exited during an active call before the scheduled reply; no late artifact was applied. Server cancellation is only claimed where recorded.'
    elif folder.name.startswith('malformed-'):
        mode='malformed-response'
        source_unchanged=(folder/'host.diff').read_text()==''
        record['sourceUnchanged']=source_unchanged
        passed=bool(len(calls)==1 and any(e.get('event')=='tools/result' and e.get('status')=='error' for e in events) and not artifacts and source_unchanged and record.get('analysisFileWritten'))
        reason='One actual call returned an error and no usable artifact; host source and tests remained unchanged. Existing failing tests are expected in this condition.'
    else:
        mode='bounded-delegation'
        statuses={e.get('status') for e in events if e.get('event')=='tools/result'}
        kinds=[e['artifactKind'] for e in artifacts]
        passed=bool(not historical and record.get('exitCode')==0 and not record.get('timedOut') and record.get('independentTestsExitCode')==0 and record.get('patchedBug') and record.get('additionalTestsWritten') and record.get('analysisFileWritten') and kinds.count('patch')>=2 and 'structured' in kinds and {'unavailable','unsupported'}.issubset(statuses))
        reason=HISTORICAL.get(folder.name,'Requires actual bug/test/analysis artifacts, host changes, passing independent tests and no-route/unsupported handling.')
    record['evidenceGate']={'condition':mode,'passed':passed,'reason':reason,'historicalFailure':historical}
    record['annotationProvenance']='Derived by evidence_index.py from retained audit events, command, diff and measured summary fields. Does not reinterpret tool discovery as delegation. CLI versions were captured during this experiment session.'
    path.write_text(json.dumps(record,indent=2)+'\n')
    return record
if __name__=='__main__':
    if any((HERE/'evidence').glob('*/summary.portable.json')):
        import subprocess
        subprocess.run(['bun', str(HERE/'portable-index.ts')], check=True)
        raise SystemExit(0)
    records=[(folder.name,annotate(folder)) for folder in (HERE/'evidence').iterdir() if (folder/'summary.json').exists()]
    records.sort(key=lambda entry:entry[1].get('firstAuditTime') or '')
    index=[]
    for order,(name,record) in enumerate(records,1):
        record['auditChronologyOrder']=order
        (HERE/'evidence'/name/'summary.json').write_text(json.dumps(record,indent=2)+'\n')
        index.append({'order':order,'run':name,'firstAuditTime':record['firstAuditTime'],'harness':record['harness'],'version':record['cliVersion'],'hostModel':record['hostModel'],'delegationOccurred':record['delegationOccurred'],'gate':record['evidenceGate'],'summary':name+'/summary.json','transcript':name+'/stdout.jsonl','audit':name+'/mcp-audit.jsonl'})
    (HERE/'evidence/index.json').write_text(json.dumps({'orderBasis':'First retained MCP audit event, not elapsed-time ranking. Failure variants were renamed before their corrected runs; original command paths preserve the names at invocation.','runs':index},indent=2)+'\n')
    print(json.dumps([{'run':name,'gate':record['evidenceGate']['passed'],'delegationOccurred':record['delegationOccurred']} for name,record in records],indent=2))
