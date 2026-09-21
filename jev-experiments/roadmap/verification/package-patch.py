"""Preserve working application edits under the repository's research-folder rule."""
from pathlib import Path
import subprocess
root=Path(__file__).resolve().parents[3]
out=root/'jev-experiments/roadmap/application.patch'
patch=subprocess.check_output(['git','diff','--binary','HEAD','--','jev-experiments',':(exclude)jev-experiments/roadmap'],cwd=root)
for relative in ['jev-experiments/experience-prototypes/api/route.ts']:
 if subprocess.run(['git','ls-files','--error-unmatch',relative],cwd=root,capture_output=True).returncode:
  result=subprocess.run(['git','diff','--no-index','--binary','--','/dev/null',relative],cwd=root,capture_output=True)
  if result.returncode not in [0,1]:raise RuntimeError(result.stderr.decode())
  patch+=result.stdout
out.write_bytes(patch)
print(f'Saved {len(patch)} bytes to {out.relative_to(root)}')
