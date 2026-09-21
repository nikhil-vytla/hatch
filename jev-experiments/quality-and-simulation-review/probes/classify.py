"""Recompute published intent evidence without calling any model or fetching data."""
import csv
import json
import sys
from collections import Counter
from pathlib import Path

LAB = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(LAB / 'src'))
from jev_lab.records import read_record

record_path = LAB / 'experience-prototypes/results/classify.jsonl'
doc = read_record(record_path)
r = doc['result']
report = {'record': str(record_path.relative_to(LAB)), 'datasets': {}}
for name, e in r['experiments'].items():
    rows = e['rows']
    base = {x['id']: x for x in e['baseline_rows']}
    groups = {}
    for group, subset in [('all', rows), ('in_scope', [x for x in rows if x['target'] != 'out_of_scope']), ('out_of_scope', [x for x in rows if x['target'] == 'out_of_scope'])]:
        if not subset:
            continue
        groups[group] = {'n': len(subset), 'jev_correct': sum(x['prediction'] == x['target'] for x in subset), 'baseline_correct': sum(base[x['id']]['prediction'] == x['target'] for x in subset)}
    report['datasets'][name] = {
        'partitions': groups,
        'option_counts': sorted(set(len(x['probabilities']) for x in rows)),
        'missing_text': sum(not x.get('text') for x in rows),
        'unavailable': sum(bool(x.get('error')) for x in rows),
        'recovered': sum(bool(x.get('original_error')) for x in rows),
        'probability_one_predictions': sum(x['probabilities'][x['prediction']] == 1 for x in rows),
        'probability_one_mistakes': sum(x['probabilities'][x['prediction']] == 1 and x['prediction'] != x['target'] for x in rows),
        'false_oos_rejections': sum(x['target'] != 'out_of_scope' and x['prediction'] == 'out_of_scope' for x in rows),
        'jev': e['jev'], 'baseline': e['tfidf_logistic'], 'paired_difference': e['paired_difference'],
    }
cache = LAB / '.cache/upstream'
bank_repo = 'PolyAI-LDN/task-specific-datasets'
clinc_repo = 'clinc/oos-eval'
bank = list(csv.DictReader((cache / bank_repo / r['sources'][bank_repo]['commit'] / 'banking_data/test.csv').open()))
clinc = json.loads((cache / clinc_repo / r['sources'][clinc_repo]['commit'] / 'data/data_full.json').read_text())
report['pinned_source_counts'] = {'banking77_test': len(bank), 'banking77_test_examples_per_class': sorted(set(Counter(x['category'] for x in bank).values())), 'clinc150_splits': {k: len(v) for k,v in clinc.items()}}
report['coverage'] = {'current_benchmark_cases': 785, 'full_benchmark_cases': 8580, 'missing_benchmark_cases': 7795, 'canonical_options_scored_full': 3080 * 77 + 5500 * 151}
report['request_accounting'] = {'original_logical_requests': 790, 'original_benchmark_decisions': 785, 'separate_authored_semantic_requests': len(r['semantic_types']), 'separate_authored_semantic_decisions': sum(len(x['answers']) for x in r['semantic_types']), 'original_physical_attempts': r['transport']['attempts'], 'original_status_counts': r['transport']['status_counts'], 'recovery_job_entries': len(r['recovery']['attempts']), 'recovery_physical_attempts': sum(len(x.get('attempts', [])) for x in r['recovery']['attempts']), 'recovered_benchmark_cases': r['recovery']['recovered_cases']}
report['case_lines'] = {}
for n, line in enumerate(record_path.read_text().splitlines(), 1):
    value = json.loads(line).get('value')
    if isinstance(value, dict) and value.get('id') in ['banking77/test/2710', 'clinc150/test/1038'] and 'text' in value:
        report['case_lines'][value['id']] = n
print(json.dumps(report, indent=2))
