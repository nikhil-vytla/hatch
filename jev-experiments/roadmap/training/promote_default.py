"""Promote only the already tested package selected by frozen validation criteria."""
from datetime import datetime, timezone
import json
import sys
from prepare import HERE, digest
from audit_release import audit
from select_default import derive_selection


def main():
    mac = HERE.parent / 'mac'
    sys.path.insert(0, str(mac))
    from package_sources import source_manifest
    selection_path = HERE / 'default-selection.json'
    selection = json.loads(selection_path.read_text())
    if any(selection.get(key) != value for key, value in derive_selection(HERE).items()):
        raise ValueError('Selected candidate does not match fresh validation-only derivation')
    package_path = mac / 'default-package-verification.json'
    package = json.loads(package_path.read_text())
    if not audit(HERE)['researchEvidenceComplete'] or package.get('passed') is not True or package.get('selectionArtifactSha256') != digest(selection_path.read_bytes()):
        raise ValueError('Complete research and an exact verified selection/package pair are required')
    if selection.get('selectedCandidate') != 'laya' or selection.get('selectedSeed') != 17:
        raise ValueError('No matching distributable exists for this selected candidate')
    if package.get('installedSourcesMatched') is not True or package.get('shippedSourceSha256') != source_manifest(mac):
        raise ValueError('Shipped source files changed after fresh installation verification')
    for filename, checksum in selection['evidenceSha256'].items():
        if digest((HERE / filename).read_bytes()) != checksum:
            raise ValueError('Selection evidence changed after package verification')
    proposed = json.dumps(package['proposedRegistry'], indent=2) + '\n'
    if digest(proposed.encode()) != package['proposedRegistrySha256']:
        raise ValueError('Proposed registry checksum mismatch')
    (mac / 'models.json').write_text(proposed)
    selection.update(installedDefault=package['selectedModel'], promotedAtUtc=datetime.now(timezone.utc).isoformat(), packageVerificationSha256=digest(package_path.read_bytes()), promotedRegistrySha256=digest(proposed.encode()))
    selection_path.write_text(json.dumps(selection, indent=2) + '\n')
    print(json.dumps({'installedDefault': selection['installedDefault'], 'experimental': True}))


if __name__ == '__main__':
    main()
