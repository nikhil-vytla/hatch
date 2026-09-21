"""Read-only reproduction of JudgeBench audit counts; no model/network calls."""
from collections import Counter, defaultdict
from pathlib import Path
import json
import sys

lab = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(lab / 'src'))
from jev_lab.records import read_record

result = read_record(lab / 'experience-prototypes/results/judge.jsonl')['result']
rows = result['rows']
pairs = defaultdict(list)
for row in rows:
    pairs[row['pair_id']].append(row)
assert all(len(group) == 2 and {r['swap'] for r in group} == {False, True} for group in pairs.values())
assert all(not row.get('error') for row in rows)
counts = Counter(sum(r['prediction'] == r['target'] for r in group) for group in pairs.values())
print(json.dumps({
    'pairs': len(pairs), 'ordered_rows': len(rows),
    'both_correct': counts[2], 'inconsistent': counts[1], 'both_wrong': counts[0],
    'ordered_accuracy': sum(r['prediction'] == r['target'] for r in rows) / len(rows),
    'official_two_order_score_complete_pairs': counts[2] / len(pairs),
    'atomic_ordered_accuracy': sum(r['atomic_prediction'] == r['target'] for r in rows) / len(rows),
    'atomic_ties': sum(r['answers']['a_correct']['value'] == r['answers']['b_correct']['value'] for r in rows),
    'full_inputs': sum(all(r.get(k) for k in ('question', 'candidate_a', 'candidate_b')) for r in rows),
    'recovered': result['recovery']['recovered_cases'],
}, indent=2))
revision = result['sources']['ScalerLab/JudgeBench']['commit']
upstream = []
for path in (lab / '.cache/upstream/ScalerLab/JudgeBench' / revision / 'data').glob('*.jsonl'):
    split = [json.loads(line) for line in path.read_text().splitlines()]
    upstream.extend(split)
    print(path.name, len(split))
if upstream:
    by_id = {r['pair_id']: r for r in upstream}
    assert all(r['candidate_a'] == by_id[r['pair_id']]['response_B' if r['swap'] else 'response_A'] and r['candidate_b'] == by_id[r['pair_id']]['response_A' if r['swap'] else 'response_B'] for r in rows)
    print('all embedded candidate strings match pinned source')
    print('distinct source questions: sample', len({(by_id[k]['source'], by_id[k]['original_id']) for k in pairs}), 'full', len({(r['source'], r['original_id']) for r in upstream}))
