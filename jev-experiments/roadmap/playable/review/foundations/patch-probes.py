"""Run apply.sh only against small temporary Git fixture repositories."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROADMAP=Path(__file__).resolve().parents[3]
patch='''diff --git a/fixture.txt b/fixture.txt
index 3367afd..3e75765 100644
--- a/fixture.txt
+++ b/fixture.txt
@@ -1 +1 @@
-old
+new
'''
results=[]
for case in ['normal','missing-ci-source','conflicting-ci']:
 with tempfile.TemporaryDirectory(prefix='jev-patch-review-') as directory:
  root=Path(directory)
  subprocess.run(['git','init','--quiet',str(root)],check=True)
  (root/'fixture.txt').write_text('old\n')
  work=root/'jev-experiments/roadmap'
  work.mkdir(parents=True)
  shutil.copyfile(ROADMAP/'apply.sh',work/'apply.sh')
  (work/'application.patch').write_text(patch)
  if case!='missing-ci-source':
   (work/'ci').mkdir()
   (work/'ci/jev-checks.yml').write_text('name: fixture\n')
  if case=='conflicting-ci':
   (root/'.github/workflows').mkdir(parents=True)
   (root/'.github/workflows/jev-checks.yml').write_text('name: existing unrelated workflow\n')
  process=subprocess.run(['sh',str(work/'apply.sh')],cwd=root,text=True,capture_output=True)
  results.append({'case':case,'exitCode':process.returncode,'fixtureAfter':(root/'fixture.txt').read_text().strip(),'workflowExists':(root/'.github/workflows/jev-checks.yml').exists(),'stderr':process.stderr.strip()})
print(json.dumps(results,indent=2))
