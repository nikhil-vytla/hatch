"""Provider-free integrity checks for the exact-archive verifier."""
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import verify


def record(timestamp="before", score=.7):
    return (json.dumps({"format": "jev-records-v1", "document": {"manifest": {"experiment": "visual-search", "prepared_at": timestamp}, "result": {"count": 1}}}) + "\n" + json.dumps({"path": ["result", "rows"], "index": 0, "value": {"score": score}}) + "\n").encode()

class ArchiveTests(unittest.TestCase):
    def test_only_preparation_timestamp_can_vary(self):
        self.assertTrue(verify.prepared_at_only(record(), record("after")))
        self.assertFalse(verify.prepared_at_only(record(), record("after", .8)))
        self.assertFalse(verify.prepared_at_only(record(), record("after") + b'{}\n'))
        self.assertFalse(verify.prepared_at_only(record(), record("after").replace(b'"count": 1', b'"count": 2')))
        self.assertFalse(verify.prepared_at_only(record(), record("after").replace(b'"visual-search"', b'"another-study"')))
        self.assertFalse(verify.prepared_at_only(record(), b'not JSON'))
        self.assertFalse(verify.prepared_at_only(record(), record(None)))
        rows = [json.loads(line) for line in record("after").splitlines()]
        rows[0] = {"document": rows[0]["document"], "format": rows[0]["format"]}
        reordered = ("\n".join(json.dumps(row) for row in rows) + "\n").encode()
        self.assertFalse(verify.prepared_at_only(record(), reordered))

    def test_archive_rejects_escape_and_links(self):
        for name, kind in [("../escape", tarfile.REGTYPE), ("link", tarfile.SYMTYPE), ("node_modules/hidden", tarfile.REGTYPE)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                output = io.BytesIO()
                with tarfile.open(fileobj=output, mode="w") as archive:
                    item = tarfile.TarInfo(name); item.type = kind; item.linkname = "target"
                    archive.addfile(item)
                with self.assertRaises(ValueError): verify.extract(output.getvalue(), Path(directory))

    def test_archive_requires_empty_target(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory); (target / "existing").write_text("preserve")
            with self.assertRaises(ValueError): verify.extract(b"", target)
            self.assertEqual((target / "existing").read_text(), "preserve")
