import copy
import unittest
from select_default import candidate, select


class ValidationOnlySelectionTests(unittest.TestCase):
    def evidence(self):
        validation = {'macroNll': .9, 'overall': {'coverage': 1, 'supported': 192}}
        trained = {'protocolSha256': 'frozen', 'recipes': [{'seed': seed, 'splits': {'validation': copy.deepcopy(validation), 'test': {'macroNll': 999}}} for seed in [17, 29, 43]]}
        condition = {'warmMedianMs': 20, 'splits': {'validation': {'argmaxAgreement': 1, 'maxProbabilityDelta': .001, 'decisionsCompared': 192, 'metrics': {'overall': {'coverage': 1}}}, 'test': {'argmaxAgreement': 0}}}
        exported = {'status': 'complete', 'completeGraph': True, 'seed': 17, 'pilotLimit': 0, 'passed': False, 'evaluations': {units: copy.deepcopy(condition) for units in ['CPU_ONLY', 'ALL']}}
        return trained, exported

    def test_test_scores_and_global_export_flag_do_not_select(self):
        trained, exported = self.evidence()
        before = candidate('laya', trained, exported, 'frozen')
        for recipe in trained['recipes']:
            recipe['splits']['test'] = {'macroNll': -999}
        exported['passed'] = True
        for result in exported['evaluations'].values():
            result['splits']['test'] = {'argmaxAgreement': 1}
        self.assertTrue(before['eligible'])
        self.assertEqual(before, candidate('laya', trained, exported, 'frozen'))

    def test_incomplete_or_failed_validation_cannot_qualify(self):
        for mutation in ['missing_cpu', 'pilot', 'partial_rows', 'nan', 'wrong_protocol']:
            with self.subTest(mutation=mutation):
                trained, exported = self.evidence()
                if mutation == 'missing_cpu': del exported['evaluations']['CPU_ONLY']
                elif mutation == 'pilot': exported['pilotLimit'] = 1
                elif mutation == 'partial_rows': exported['evaluations']['ALL']['splits']['validation']['decisionsCompared'] = 191
                elif mutation == 'nan': exported['evaluations']['ALL']['splits']['validation']['maxProbabilityDelta'] = float('nan')
                elif mutation == 'wrong_protocol': trained['protocolSha256'] = 'changed'
                self.assertFalse(candidate('laya', trained, exported, 'frozen')['eligible'])

    def test_latency_only_breaks_validation_ties(self):
        candidates = [{'model': 'best', 'eligible': True, 'validationMacroNll': .9, 'allWarmMedianMs': 40}, {'model': 'close', 'eligible': True, 'validationMacroNll': .905, 'allWarmMedianMs': 20}, {'model': 'fast', 'eligible': True, 'validationMacroNll': .92, 'allWarmMedianMs': 1}]
        self.assertEqual(select(candidates)['model'], 'close')


if __name__ == '__main__':
    unittest.main()
