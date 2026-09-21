import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import contextlib
import io
import export_decision_rows as export
from evidence import file_sha


class PublicComparisonTests(unittest.TestCase):
    def fixture(self, root):
        evidence, cache = root / 'evidence', root / 'cache'
        evidence.mkdir()
        location = cache / 'laya'
        location.mkdir(parents=True)
        coreml, hashes = [], {}
        for split in ['validation', 'test', 'transfer']:
            row = {'id': split + '/1', 'values': [False, True], 'target': [0, 1], 'status': 'ok', 'probabilities': [.25, .75], 'state': 'PRIVATE SOURCE SENTINEL', 'question': {'prompt': 'PRIVATE QUESTION SENTINEL'}}
            path = location / f'predictions-17-{split}.jsonl'
            path.write_text(json.dumps(row) + '\n')
            hashes[path.name] = file_sha(path)
            coreml.append({**row, 'probabilities': [.2, .8]})
        report = {'status': 'complete', 'precision': 'float32', 'provenance': {'predictionSha256': hashes}, 'evaluations': {}}
        for units in ['CPU_ONLY', 'ALL']:
            path = location / f'coreml-17-float32-{units}.jsonl'
            path.write_text(''.join(json.dumps(row) + '\n' for row in coreml))
            report['evaluations'][units] = {'predictionsSha256': file_sha(path), 'decisionsCompared': 3, 'maxProbabilityDelta': .05, 'argmaxAgreement': 1}
        (evidence / 'export-laya-17.json').write_text(json.dumps(report))
        return evidence, cache

    def test_published_rows_omit_source_text_and_preserve_all_decisions(self):
        with tempfile.TemporaryDirectory() as temporary:
            evidence, cache = self.fixture(Path(temporary))
            with patch.object(export, 'HERE', evidence), patch.object(sys, 'argv', ['export_decision_rows.py', '--model', 'laya', '--cache', str(cache)]), contextlib.redirect_stdout(io.StringIO()):
                export.main()
            for units in ['CPU_ONLY', 'ALL']:
                raw = (evidence / f'export-decisions-laya-17-{units}.jsonl').read_text()
                self.assertNotIn('PRIVATE', raw)
                rows = [json.loads(line) for line in raw.splitlines()]
                self.assertEqual(len(rows), 3)
                self.assertEqual({row['split'] for row in rows}, {'validation', 'test', 'transfer'})
                self.assertTrue(all(row['values'] == [False, True] and row['argmaxAgreement'] for row in rows))

    def test_changed_prediction_bytes_cannot_be_published(self):
        with tempfile.TemporaryDirectory() as temporary:
            evidence, cache = self.fixture(Path(temporary))
            with (cache / 'laya/predictions-17-test.jsonl').open('a') as stream:
                stream.write('{}\n')
            with patch.object(export, 'HERE', evidence), patch.object(sys, 'argv', ['export_decision_rows.py', '--model', 'laya', '--cache', str(cache)]), self.assertRaises(ValueError):
                export.main()
            self.assertFalse(list(evidence.glob('export-decisions*.jsonl')))


if __name__ == '__main__':
    unittest.main()
