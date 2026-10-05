"""Read-only check of GitHub's current production deployment and canonical URL."""
from pathlib import Path
import datetime, hashlib, json, subprocess, tempfile
here=Path(__file__).resolve().parent
base='repos/nikhil-vytla/hatch'
def github(path):
    return json.loads(subprocess.check_output(['gh','api',base+path]))
branch=github('/branches/main')
deployment=next(d for d in github('/deployments?per_page=10') if d['environment']=='Production' and d['sha']==branch['commit']['sha'])
status=github('/deployments/'+str(deployment['id'])+'/statuses')[0]
with tempfile.TemporaryDirectory(prefix='jev-canonical-') as directory:
    target=Path(directory)/'page.html'
    code=subprocess.check_output(['curl','--fail','--show-error','--silent','--location','--output',str(target),'--write-out','%{http_code}','https://jev-experiments.vercel.app'],text=True)
    page_hash=hashlib.sha256(target.read_bytes()).hexdigest()
report={
    'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'mainSha':branch['commit']['sha'],
    'deployment':{'id':deployment['id'],'sha':deployment['sha'],'environment':deployment['environment'],'status':status['state'],'environmentUrl':status['environment_url']},
    'canonical':{'url':'https://jev-experiments.vercel.app','status':int(code),'htmlSha256':page_hash},
    'applicationPatchDeployed':False,
    'scope':'Confirms the existing GitHub-main production deployment and canonical URL. This research folder/application patch is not in that deployment; this does not satisfy the new release deployment gate.',
    'rootDirectory':'jev-experiments/experience-prototypes',
    'rootDirectoryEvidence':'Previously verified vercel-git-root/after.json; remote settings not re-read in this check.',
}
(here/'canonical-deployment.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
