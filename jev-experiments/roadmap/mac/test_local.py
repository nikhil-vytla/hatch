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
        return {'schemaVersion': '2', 'requestId': 'r1', 'state': 'A state', 'questions': [question]}

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
        with self.assertRaises(ValueError): j.validate({'schemaVersion': '2', 'requestId': 'r1', 'questions': []})

    def test_native_semantics_are_unsupported_without_silent_text_conversion(self):
        boolean = {'id': 'q', 'kind': 'boolean', 'prompt': 'Check'}
        cases = [
            {**boolean, 'criteria': {'true': 'Evidence present', 'false': 'No evidence'}},
            {**boolean, 'prompt': {'question': 'Check'}},
            {**boolean, 'prompt': ['Check']},
            {**boolean, 'prompt': None},
            {'id': 'q', 'kind': 'ordinal', 'prompt': 'Rate', 'min': 0, 'max': 1, 'levels': ['routine', 'severe']},
            {'id': 'q', 'kind': 'choice', 'prompt': 'Choose', 'options': [{'id': 'a', 'label': 'A', 'description': {'meaning': 'A'}}, {'id': 'b', 'label': 'B'}]},
        ]
        runtime = object.__new__(j.Runtime)
        runtime.spec, runtime.load_ms = {'model': 'fixture', 'revision': 'test'}, 0
        for question in cases:
            with self.subTest(question=question), patch.object(j, 'pack') as pack:
                response = runtime.decide(self.request(question))
                self.assertEqual(response['status'], 'unsupported')
                self.assertEqual(response['schemaVersion'], '2')
                self.assertEqual(response['decisions'], [])
                pack.assert_not_called()

    def test_whole_batch_is_validated_before_packing_or_inference(self):
        request = self.request({'id': 'valid', 'kind': 'boolean', 'prompt': 'Check'})
        request['questions'].append({'id': 'unsupported', 'kind': 'boolean', 'prompt': 'Check', 'criteria': {'true': None, 'false': None}})
        runtime = object.__new__(j.Runtime)
        runtime.spec, runtime.load_ms = {'model': 'fixture', 'revision': 'test'}, 0
        with patch.object(j, 'pack') as pack:
            response = runtime.decide(request)
        pack.assert_not_called()
        self.assertEqual(response['status'], 'unsupported')
        self.assertEqual(response['decisions'], [])

    def test_unsupported_cli_request_precedes_model_loading(self):
        request = self.request({'id': 'q', 'kind': 'boolean', 'prompt': 'Check', 'criteria': {'true': 'Yes', 'false': 'No'}})
        with patch.object(sys, 'argv', ['jev-local', 'decide', '--model', 'laya-base-experimental', '-']), patch.object(sys, 'stdin', io.StringIO(json.dumps(request))), patch.object(j, 'Runtime') as runtime, contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(j.main(), 2)
        runtime.assert_not_called()
        response = json.loads(output.getvalue())
        self.assertEqual(response['status'], 'unsupported')
        self.assertEqual(response['requestId'], request['requestId'])
        self.assertEqual(response['issues'][0]['code'], 'unsupported_criteria')

    def test_v2_primitive_summaries_preserve_modal_and_expected_values(self):
        question = {'id': 'q', 'kind': 'ordinal', 'prompt': 'Rate', 'min': 10, 'max': 30, 'step': 10}
        response = j.decision(question, [10, 20, 30], [.1, .2, .7])
        self.assertEqual(response['selected'], 30)
        self.assertEqual(response['expected'], 26)
        boolean = j.decision({'id': 'b', 'kind': 'boolean'}, [False, True], [.65, .35])
        self.assertIs(boolean['selected'], False)
        self.assertEqual(boolean['probabilityTrue'], .35)
        for probabilities in [[1], [.2, .2, .2], [float('nan'), 0, 1]]:
            with self.assertRaises(ValueError):
                j.decision(question, [10, 20, 30], probabilities)

    def test_no_request_fields_or_json_identity_are_silently_lost(self):
        base = self.request({'id': 'q', 'kind': 'boolean', 'prompt': 'Check'})
        for request in [{**base, 'schemaVersion': '1'}, {**base, 'history': 'ignored'},
                        {**base, 'state': {1: 'integer key'}}, {**base, 'state': ('tuple',)}]:
            with self.assertRaises(j.InputError) as raised:
                j.validate(request)
            self.assertEqual(raised.exception.status, 'error')

    def test_malformed_and_unsupported_are_distinct_before_model_loading(self):
        base = {'id': 'q', 'kind': 'boolean', 'prompt': 'Check'}
        cases = [
            ({**base, 'instructions': 'Lost'}, 'error', 'invalid_question'),
            ({**base, 'criteria': {'true': 'Only one'}}, 'error', 'invalid_criteria'),
            ({**base, 'prompt': 3}, 'error', 'invalid_entry'),
            ({**base, 'prompt': ''}, 'unsupported', 'unsupported_prompt'),
            ({**base, 'prompt': {'task': 'Check'}}, 'unsupported', 'unsupported_structure'),
            ({**base, 'criteria': {'true': None, 'false': None}}, 'unsupported', 'unsupported_criteria'),
        ]
        runtime = object.__new__(j.Runtime)
        runtime.spec, runtime.load_ms = {'model': 'fixture', 'revision': 'test'}, 0
        for question, status, code in cases:
            with self.subTest(code=code), patch.object(j, 'pack') as pack:
                result = runtime.decide(self.request(question))
                self.assertEqual(result['status'], status)
                self.assertEqual(result['issues'][0]['code'], code)
                pack.assert_not_called()

    def test_explicit_choice_description_replaces_label_even_when_empty(self):
        question = {'kind': 'choice', 'options': [
            {'id': 'a', 'label': 'Visible A', 'description': 'Actual criterion'},
            {'id': 'b', 'label': 'Visible B', 'description': ''},
            {'id': 'c', 'label': 'Visible C'},
        ]}
        self.assertEqual(j.options(question), [('a', 'Actual criterion'), ('b', ''), ('c', 'Visible C')])

    def test_limit_accounting_is_compact_but_packing_text_is_unchanged(self):
        state = {'items': ['x'] * 1000}
        request = self.request({'id': 'q', 'kind': 'boolean', 'prompt': 'Check'})
        request['state'] = state
        limit = j.compact_bytes(state)
        self.assertGreater(len(j.dumps(state).encode()), limit)
        with patch.dict(j.LIMITS, {'maxStateBytes': limit}):
            j.validate(request)
        with patch.dict(j.LIMITS, {'maxStateBytes': limit - 1}):
            with self.assertRaises(j.UnsupportedInput) as raised:
                j.validate(request)
            self.assertEqual(raised.exception.code, 'input_limit')
        self.assertEqual(j.dumps({'a': [1, 2]}), '{"a": [1, 2]}')

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

    def test_ordinal_values_preserve_shared_contract_float_identity(self):
        values = [value for value, _ in j.options({'kind': 'ordinal', 'min': .1, 'max': .4, 'step': .1})]
        self.assertEqual(values, [.1, .2, .1 + 2 * .1, .4])
        self.assertNotEqual(values[2], .3)

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
            self.assertEqual({item['code'] for item in response['issues']}, {'model_missing'})
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
