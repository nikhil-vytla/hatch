#!/usr/bin/env python3
"""Read Git objects and retained reports; no builds, transports or test execution."""
from pathlib import Path
import hashlib
import json
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SOURCE = 'c89327f7f94a7c70551485ffa0a132ee8640c715'
REPORT = '291e8817403f9442cfdb2d3040de0eb07af70a8a'
BASE = '854657a49a89eb1d19808c9a0e0329be54f037bd'
FOLDER = 'jev-experiments/native-questions-2026-09-22/'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(*args):
    return subprocess.check_output(['git', '--no-optional-locks', *args], cwd=ROOT)


def blob(ref, path):
    return git('show', ref + ':' + path)


def main():
    checks = []
    def check(name, passed):
        checks.append({'name': name, 'passed': bool(passed)})
    records = {name: json.loads(blob(REPORT, FOLDER + name)) for name in ['source.json', 'verification.json', 'adapters.json']}
    source, verification, adapters = (records[n] for n in ['source.json', 'verification.json', 'adapters.json'])
    check('source parent is the reviewed publication base', git('rev-parse', SOURCE+'^').decode().strip() == BASE)
    check('report commit directly follows reviewed source', git('rev-parse', REPORT+'^').decode().strip() == SOURCE)
    changed_reports = git('diff', '--name-only', SOURCE, REPORT).decode().splitlines()
    check('report commit changes only its eight report files', len(changed_reports) == 8 and all(n.startswith(FOLDER) for n in changed_reports))
    check('all retained report source identities match', all(v['sourceCommit'] == SOURCE for v in records.values()))
    for row in source['files']:
        data = blob(SOURCE, row['path'])
        check('pinned source '+row['path'], sha(data) == row['sha256'] and len(data) == row['bytes'])
    changed_source = git('diff', '--name-only', BASE, SOURCE).decode().splitlines()
    check('source slice contains 12 adapter paths and one workflow', set(changed_source) == {row['path'] for row in source['files']} | {'.github/workflows/jev-native-questions.yml'})
    patch = blob(REPORT, FOLDER+'source-code.patch')
    check('retained patch hash matches source manifest', sha(patch) == source['sourcePatchSha256'])
    check('retained patch equals the complete source commit diff', patch == git('diff', '--binary', BASE, SOURCE))
    archive_hash = hashlib.sha256()
    process = subprocess.Popen(['git', '--no-optional-locks', 'archive', '--format=tar', SOURCE], cwd=ROOT, stdout=subprocess.PIPE)
    for chunk in iter(lambda: process.stdout.read(1024 * 1024), b''):
        archive_hash.update(chunk)
    check('Git archive command completed', process.wait() == 0)
    check('all three reports match the exact Git archive', all(v['archiveSha256'] == archive_hash.hexdigest() for v in records.values()))
    verifier = blob(REPORT, FOLDER+'verify_source.py')
    check('retained source verifier identity matches its record', sha(verifier) == verification['verifierSha256'])
    expected_order = ['app frozen install', 'app production build', 'adapter frozen install', 'adapter TypeScript', 'native and adapter tests', 'Python frozen install', 'Python contracts', 'publication integrity']
    check('recorded checks preserve build-before-sibling-install order', [r['name'] for r in verification['checks']] == expected_order)
    check('all eight recorded source checks passed without timeout', verification['passed'] and len(verification['checks']) == 8 and all(r['exitCode'] == 0 and not r['timedOut'] for r in verification['checks']))
    check('Python optional-dependency skip remains explicit', verification['checks'][6]['summaries'] == ['59 passed, 1 skipped in 30.10s'])
    for language in ['go', 'rust']:
        record = adapters['checks'][language]
        check(language+' retained test exit is zero and source unchanged', record['status'] == 'passed' and record['test']['exitCode'] == 0 and record['sourceUnchanged'])
        for name, expected in record['sourceHashes'].items():
            check(language+' archive source '+name, sha(blob(SOURCE, 'jev-experiments/adapters/'+language+'/'+name)) == expected)
    check('Go/Rust aggregate remains a local result', adapters['passed'] and any('not the GitHub Linux CI' in v for v in adapters['limitations']))
    native = 'jev-experiments/packages/decision-runtime/src/native.ts'
    ts = blob(SOURCE, 'jev-experiments/adapters/typescript/index.ts').decode()
    check('TypeScript imports only the committed native module for the shared question definitions', '../../packages/decision-runtime/src/native' in ts and bool(blob(SOURCE, native)))
    check('native definitions have no imported runtime or application dependency', not any(line.startswith('import ') for line in blob(SOURCE, native).decode().splitlines()))
    check('no hosted execution claimed by retained local reports', verification['providerCallsRequested'] is False and adapters['providerCalls'] == 0 and adapters['trainingRequested'] is False)
    result = {'sourceCommit': SOURCE, 'reportCommit': REPORT, 'base': BASE, 'archiveSha256': archive_hash.hexdigest(), 'condition': 'Independent read-only Git object, import-boundary and retained-report inspection. No test, build, provider, client or deployment executed.', 'verifierSha256': sha(Path(__file__).read_bytes()), 'checks': checks, 'passed': all(row['passed'] for row in checks), 'passedChecks': sum(row['passed'] for row in checks), 'totalChecks': len(checks), 'scopeLimit': 'Original evidence predates the separately authored Go/Rust legend fix. This inspection does not test that fix or establish remote CI/deployment.'}
    (HERE/'evidence.json').write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps({key: result[key] for key in ['sourceCommit', 'passedChecks', 'totalChecks', 'passed']}))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
