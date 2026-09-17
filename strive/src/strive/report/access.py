"""Reporting access to audit data requires the completed release boundary."""
from ..cli.data import read_json
from ..errors import VerificationError
from ..store import RunReader


def authorize(read: RunReader) -> None:
    if read.authority.scope.lineage_id != "audit":
        return
    run = read.objects.directory.parent.parent
    boundary = run.parent.parent
    try:
        release = read_json((boundary / "RELEASED").read_bytes())
        imported = read_json((run / "IMPORT.json").read_bytes())
    except OSError as error:
        raise VerificationError("audit reporting is embargoed until authorized release") from error
    if release.get("freeze") != imported.get("freeze") or release.get("destination") != imported.get("destination"):
        raise VerificationError("audit reporting release does not match the frozen import")
