import json
from pathlib import Path
import tempfile
import unittest
import subprocess
import sys
import hashlib
import io
import contextlib
from unittest.mock import patch
import jev_local as j


class LocalTests(unittest.TestCase):
    def request(self, question):
        return {'schemaVersion': '1', 'requestId': 'r1', 'state': 'A state', 'questions': [question]}

    def test_typed_options(self):
        self.assertEqual(j.options({'kind': 'boolean'}), [(False, 'No, the statement does not hold.'), (True, 'Yes, the statement holds.')])
        self.assertEqual([v for v, _ in j.options({'kind': 'ordinal', 'min': -1, 'max': 1, 'step': .5})], [-1, -.5, 0, .5, 1])
        for q in [{'kind': 'ordinal', 'min': 0, 'max': 100}, {'kind': 'ordinal', 'min': 0, 'max': 1, 'step': .3}, {'kind': 'choice', 'options': [{'id': 'a', 'label': 'a'}, {'id': 'a', 'label': 'again'}]}]:
            with self.assertRaises(ValueError): j.options(q)

    def test_input_validation(self):
        request = self.request({'id': 'q', 'kind': 'boolean', 'prompt': 'Is it true?'})
        j.validate(request)
        request['questions'] *= 2
        with self.assertRaises(ValueError): j.validate(request)
        request = self.request({'id': 'q', 'kind': 'boolean', 'prompt': 'Is it true?'})
        request['state'] = 'x' * (j.LIMITS['maxStateBytes'] + 1)
        with self.assertRaises(ValueError): j.validate(request)
        with self.assertRaises(ValueError): j.validate({'schemaVersion': '1', 'requestId': 'r1', 'questions': []})

    def test_mime_plain_text_and_no_file_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'unicode.eml'
            path.write_bytes(b'Subject: =?utf-8?q?Caf=C3=A9?=\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nMeet at the caf=C3=A9.\r\n')
            before = path.read_bytes()
            state, checksum = j.read_eml(path)
            self.assertEqual(state['subject'], 'Café')
            self.assertIn('café', state['body'])
            self.assertEqual(path.read_bytes(), before)
            path.write_bytes(b'Content-Type: text/html\r\n\r\n<p>Hello</p>')
            with self.assertRaises(ValueError): j.read_eml(path)

    def test_checksum_mismatch_never_installs(self):
        spec = {'files': [{'path': 'weights.bin', 'bytes': 3, 'sha256': '0' * 64}]}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source'
            source.mkdir()
            (source / 'weights.bin').write_bytes(b'bad')
            with patch.object(j, 'model_spec', return_value=spec):
                with self.assertRaises(ValueError): j.install_model('fixture', root / 'data', source)
                self.assertFalse((root / 'data/fixture/weights.bin').exists())
                self.assertFalse((root / 'data/fixture/weights.bin.partial').exists())

    def test_missing_model_stays_local(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(j.urllib.request, 'urlopen', side_effect=AssertionError('No network')):
            with self.assertRaises(ValueError): j.Runtime('laya-base-experimental', Path(directory))

    def test_tiny_ordinal_identity(self):
        self.assertEqual([value for value, _ in j.options({'kind': 'ordinal', 'min': 1e-11, 'max': 2e-11, 'step': 1e-11})], [1e-11, 2e-11])

    def test_temporary_symlink_cannot_overwrite_unrelated_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, destination = root / 'source', root / 'data/fixture'
            source.mkdir()
            destination.mkdir(parents=True)
            (source / 'weights.bin').write_bytes(b'new')
            sentinel = root / 'unrelated'
            sentinel.write_bytes(b'preserve')
            (destination / 'weights.bin.partial').symlink_to(sentinel)
            spec = {'experimental': True, 'files': [{'path': 'weights.bin', 'bytes': 3, 'sha256': hashlib.sha256(b'new').hexdigest()}]}
            with patch.object(j, 'model_spec', return_value=spec):
                j.install_model('fixture', root / 'data', source)
            self.assertEqual(sentinel.read_bytes(), b'preserve')
            self.assertFalse((destination / 'weights.bin').is_symlink())

    def test_missing_model_has_complete_error_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            request = self.request({'id': 'q', 'kind': 'boolean', 'prompt': 'True?'})
            (root / 'request.json').write_text(json.dumps(request))
            completed = subprocess.run([sys.executable, str(j.HERE / 'jev_local.py'), 'decide', '--model', 'laya-base-experimental', '--data', str(root / 'missing'), str(root / 'request.json')], capture_output=True, text=True)
            response = json.loads(completed.stdout)
            self.assertEqual(response['requestId'], request['requestId'])
            self.assertEqual(response['status'], 'error')
            self.assertTrue({'schemaVersion', 'requestId', 'status', 'decisions', 'execution', 'timing', 'issues'} <= response.keys())

    def test_oversized_json_is_rejected_before_model_loading(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'too-big.json'
            path.write_bytes(b'x' * (j.LIMITS['maxInputBytes'] + 50))
            with patch.object(sys, 'argv', ['jev-local', 'decide', '--model', 'laya-base-experimental', str(path)]), patch.object(j, 'Runtime') as runtime, contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(j.main(), 2)
            runtime.assert_not_called()
            self.assertIn('byte limit', json.loads(output.getvalue())['issues'][0]['message'])

    def test_cli_total_includes_initialization(self):
        response = {'status': 'ok', 'timing': {'totalMs': 2, 'loadMs': 100}}
        with patch.object(sys, 'argv', ['jev-local', 'decide', '--model', 'laya-base-experimental', '-']), patch.object(sys, 'stdin', io.StringIO(json.dumps(self.request({'id': 'q', 'kind': 'boolean', 'prompt': 'True?'})))), patch.object(j, 'Runtime') as runtime, patch.object(j.time, 'perf_counter', side_effect=[1, 1.12]), contextlib.redirect_stdout(io.StringIO()) as output:
            runtime.return_value.decide.return_value = response
            self.assertEqual(j.main(), 0)
        self.assertAlmostEqual(json.loads(output.getvalue())['timing']['totalMs'], 120)

    def test_runtime_only_doctor_does_not_require_default_model_files(self):
        with patch.object(sys, 'argv', ['jev-local', 'doctor', '--runtime-only']), patch.object(j, 'selected_default', return_value='laya-base-experimental'), patch.object(j, 'diagnostic', return_value={'status': 'ok'}) as diagnostic, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(j.main(), 0)
        diagnostic.assert_called_once_with(None, j.DATA)

if __name__ == '__main__':
    unittest.main()
