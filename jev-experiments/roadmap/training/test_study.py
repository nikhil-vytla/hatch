import json
import math
import unittest
from prepare import ordinal_target, choice
from study import metrics, grouped_metrics, baseline, variant, read_rows, DEFAULT_CACHE

class StudyTests(unittest.TestCase):
    def row(self):
        return {'id': 'x', 'dataset': 'fixture', 'state': 'state', 'question': {'id': 'q', 'kind': 'ordinal', 'prompt': 'Rate', 'min': 0, 'max': 2}, 'values': [0, 1, 2], 'target': [0, .75, .25]}

    def test_ordinal_mapping_preserves_mean(self):
        for value in [0, .1, 1.75, 4.9, 5]:
            p = ordinal_target(value, 0, 5)
            self.assertAlmostEqual(sum(p), 1)
            self.assertAlmostEqual(sum(i * x for i, x in enumerate(p)), value)
        with self.assertRaises(ValueError): ordinal_target(6, 0, 5)

    def test_metrics_include_unsupported_coverage(self):
        row = self.row()
        value = metrics([{**row, 'status': 'ok', 'probabilities': [0, .75, .25]}, {**row, 'status': 'unsupported', 'reason': 'too_long'}])
        self.assertEqual(value['coverage'], .5)
        self.assertEqual(value['ordinalMae'], 0)
        self.assertAlmostEqual(value['nll'], -(.75 * math.log(.75) + .25 * math.log(.25)))
        self.assertEqual(value['accuracy'], 1)
        self.assertEqual(value['unsupportedReasons'], {'too_long': 1})
        with self.assertRaises(ValueError): metrics([{**row, 'status': 'ok', 'probabilities': [.9, .8, .7]}])
        tied = {**row, 'target': [.5, .5, 0], 'status': 'ok', 'probabilities': [.1, .8, .1]}
        self.assertEqual(metrics([tied])['accuracy'], 1)
        missing = grouped_metrics([{**row, 'status': 'unsupported', 'reason': 'too_long'}])
        self.assertIsNone(missing['macroNll'])
        self.assertEqual(missing['overall']['coverage'], 0)

    def test_candidates_preserve_gold_and_do_not_duplicate(self):
        row = choice('fixture', '1', 'a state', 'label3', [f'label{i}' for i in range(77)])
        self.assertEqual(len(row['values']), 8)
        self.assertEqual(len(set(row['values'])), 8)
        self.assertEqual(row['values'][row['target'].index(1)], 'label3')
        changed = variant(row, 1)
        self.assertEqual(changed['values'][changed['target'].index(1)], 'label3')
        self.assertEqual({x['id'] for x in changed['question']['options']}, set(row['values']))
        self.assertEqual(row, choice('fixture', '1', 'a state', 'label3', [f'label{i}' for i in range(77)]))

    def test_state_blind_prior_ignores_text_and_order(self):
        row = choice('fixture', '1', 'do something', 'a', list('abcdefgh'))
        left = baseline([row], [row], 'prior')[0]
        changed = {**row, 'state': 'completely different text', 'values': list(reversed(row['values'])), 'target': list(reversed(row['target']))}
        right = baseline([changed], [row], 'prior')[0]
        self.assertEqual(left['probabilities'], list(reversed(right['probabilities'])))

    def test_complete_frozen_transfer(self):
        if not (DEFAULT_CACHE / 'transfer.jsonl').exists():
            self.skipTest('Run prepare.py for corpus integration checks')
        rows = read_rows(DEFAULT_CACHE, 'transfer')
        transfer = [x for x in rows if x['dataset'] == 'typed_decisions']
        self.assertEqual(len({x['caseId'] for x in transfer}), 400)
        self.assertEqual(len(transfer), 2000)
        adaptation = read_rows(DEFAULT_CACHE, 'train') + read_rows(DEFAULT_CACHE, 'validation')
        self.assertFalse(any(x['dataset'] == 'typed_decisions' for x in adaptation))
        self.assertFalse({r['id'] for r in adaptation} & {r['id'] for r in rows})

if __name__ == '__main__': unittest.main()
