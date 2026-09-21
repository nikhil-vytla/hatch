#!/usr/bin/env python3
"""Fresh Bun-only install, first lexical result, MCP discovery, and uninstall smoke."""
import hashlib,json,pathlib,subprocess,tempfile,time
HERE=pathlib.Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix='jev-router-install-') as temporary:
 prefix=pathlib.Path(temporary)/'tool';started=time.monotonic()
 install=subprocess.run(['sh',str(HERE/'install.sh'),str(prefix)],capture_output=True,text=True,check=True)
 cli=str(prefix/'bin/jev')
 doctor=subprocess.run([cli,'doctor'],capture_output=True,text=True,check=True)
 eml=pathlib.Path(temporary)/'receipt.eml';eml.write_text('Subject: Receipt\nContent-Type: text/plain\n\nPayment received. Thank you.\n');before=eml.read_bytes()
 email=subprocess.run([cli,'classify_eml',str(eml)],capture_output=True,text=True,check=True)
 lines=[{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-06-18','clientInfo':{'name':'fresh-install-smoke','version':'1'}}},{'jsonrpc':'2.0','id':2,'method':'tools/list'}]
 mcp=subprocess.run([cli,'mcp'],input=''.join(json.dumps(line)+'\n' for line in lines),capture_output=True,text=True,check=True)
 report={'condition':'Fresh source-built Bun CLI, no weights or training dependencies; default email is explicitly a lexical demonstration.','prefix':str(prefix),'bundleBytes':(prefix/'lib/jev.js').stat().st_size,'bundleSha256':hashlib.sha256((prefix/'lib/jev.js').read_bytes()).hexdigest(),'elapsedSeconds':time.monotonic()-started,'doctor':json.loads(doctor.stdout),'emailExitCode':email.returncode,'email':json.loads(email.stdout),'mcpExitCode':mcp.returncode,'mcpReplies':[json.loads(line) for line in mcp.stdout.splitlines()],'mailUnchanged':eml.read_bytes()==before,'uninstall':'Temporary install prefix removed after this smoke; no shell/client configuration changed.'}
 assert report['email']['selected']=='receipt' and report['mailUnchanged']
 assert {tool['name'] for tool in report['mcpReplies'][1]['result']['tools']}=={'decide','route_task','classify_eml'}
report['uninstalled']=not prefix.exists()
(HERE/'fresh-install.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({key:report[key] for key in ['bundleBytes','elapsedSeconds','mailUnchanged','uninstalled']},indent=2))
