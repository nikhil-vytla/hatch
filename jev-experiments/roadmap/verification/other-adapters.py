"""Run existing Go/Rust adapter checks with temporary official toolchains.

No shell profile, persistent PATH or user toolchain default is changed. Downloaded
code and build caches live in a TemporaryDirectory and are deleted on completion.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
import time
import tomllib
from datetime import datetime, timezone

HERE = Path(__file__).resolve().parent
REPOSITORY = HERE.parents[2]
ADAPTERS = REPOSITORY / 'jev-experiments/adapters'
REPORT = HERE / 'other-adapters.json'


def sha(path):
    return hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()


def command(args, *, cwd=None, env=None, timeout=900):
    start = time.monotonic()
    process = subprocess.run(args, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, timeout=timeout)
    return {'command': args, 'exitCode': process.returncode,
            'elapsedSeconds': round(time.monotonic() - start, 3),
            'stdout': process.stdout[-12000:], 'stderr': process.stderr[-12000:]}


def checked(args, **kwargs):
    result = command(args, **kwargs)
    if result['exitCode']:
        raise RuntimeError(json.dumps(result))
    return result


def download(url, destination):
    checked(['/usr/bin/curl', '--fail', '--silent', '--show-error', '--location',
             '--proto', '=https', '--tlsv1.2', '--output', str(destination), url], timeout=180)


def protected_files():
    home = Path.home()
    paths = ['.rustup/settings.toml', '.cargo/config.toml', '.cargo/env', '.zshrc',
             '.zprofile', '.bash_profile', '.profile', '.config/go/env']
    return {name: sha(home / name) if (home / name).is_file() else None for name in paths}


def snapshot(adapter):
    return {str(path.relative_to(adapter)): sha(path) for path in sorted(adapter.rglob('*'))
            if path.is_file() and not {'target', '.git'}.intersection(path.relative_to(adapter).parts)}


def go_check(root, env, source):
    metadata = root / 'go-releases.json'
    download('https://go.dev/dl/?mode=json&include=all', metadata)
    # Match the adapter and setup-go go-version-file condition, latest 1.23 patch.
    release = next(row for row in json.loads(metadata.read_text())
                   if row['version'].startswith('go1.23.') and row['stable'])
    artifact = next(row for row in release['files']
                    if row['os'] == 'darwin' and row['arch'] == 'arm64' and row['kind'] == 'archive')
    archive = root / artifact['filename']
    url = 'https://go.dev/dl/' + artifact['filename']
    print('Downloading and verifying ' + artifact['filename'], flush=True)
    download(url, archive)
    if sha(archive) != artifact['sha256'] or archive.stat().st_size != artifact['size']:
        raise ValueError('Official Go archive checksum/size mismatch')
    with tarfile.open(archive) as stream:
        stream.extractall(root / 'go-toolchain', filter='data')
    binary = root / 'go-toolchain/go/bin/go'
    local = {**env, 'GOROOT': str(binary.parents[1]), 'GOPATH': str(root / 'gopath'),
             'GOCACHE': str(root / 'go-build'), 'GOMODCACHE': str(root / 'go-modules'),
             'GOENV': 'off', 'GOTOOLCHAIN': 'local', 'GOTELEMETRY': 'off',
             'GOPROXY': 'https://proxy.golang.org', 'GOSUMDB': 'sum.golang.org',
             'GOMAXPROCS': '2', 'GOFLAGS': '-mod=readonly -p=2'}
    version = checked([str(binary), 'version'], env=local)
    print(version['stdout'].strip() + ': go test ./...', flush=True)
    result = command([str(binary), 'test', './...'], cwd=source, env=local)
    result['command'] = ['<temporary-go>/bin/go', 'test', './...']
    return {'status': 'passed' if not result['exitCode'] else 'failed',
            'version': version['stdout'].strip(), 'officialArchive': url,
            'archiveSha256': artifact['sha256'], 'archiveChecksumVerified': True,
            'isolation': {key: value.replace(str(root), '<temporary>') for key, value in local.items()
                          if key in ['GOROOT', 'GOPATH', 'GOCACHE', 'GOMODCACHE', 'GOENV', 'GOTOOLCHAIN', 'GOTELEMETRY', 'GOFLAGS']},
            'test': result}


def rust_check(root, env, source):
    rustup = shutil.which('rustup')
    if not rustup:
        raise RuntimeError('Existing rustup executable not found; no global installer was run')
    channel = root / 'channel-rust-stable.toml'
    channel_url = 'https://static.rust-lang.org/dist/channel-rust-stable.toml'
    download(channel_url, channel)
    manifest = tomllib.loads(channel.read_text())
    version = manifest['pkg']['rust']['version'].split()[0]
    local = {**env, 'RUSTUP_HOME': str(root / 'rustup'), 'CARGO_HOME': str(root / 'cargo'),
             'RUSTUP_TOOLCHAIN': version, 'RUSTUP_DIST_SERVER': 'https://static.rust-lang.org',
             'RUSTUP_UPDATE_ROOT': 'https://static.rust-lang.org/rustup',
             'RUSTUP_AUTO_INSTALL': '0',
             'CARGO_TARGET_DIR': str(root / 'rust-target'), 'CARGO_INCREMENTAL': '0',
             'CARGO_BUILD_JOBS': '2', 'CARGO_TERM_COLOR': 'never'}
    print('Installing official Rust ' + version + ' into temporary prefix', flush=True)
    install = checked([rustup, 'toolchain', 'install', version, '--profile', 'minimal', '--no-self-update'], env=local)
    install['command'] = ['rustup', 'toolchain', 'install', version, '--profile', 'minimal', '--no-self-update']
    manager = checked([rustup, '--version'], env=local)
    executable_paths = {}
    for tool in ['rustc', 'cargo']:
        path = Path(checked([rustup, 'which', '--toolchain', version, tool], env=local)['stdout'].strip()).resolve()
        if not path.is_relative_to(root.resolve()):
            raise ValueError('Rust executable is outside the temporary prefix: ' + tool)
        executable_paths[tool] = '<temporary>/' + str(path.relative_to(root.resolve()))
    compiler = checked([rustup, 'run', version, 'rustc', '--version'], env=local)
    cargo = checked([rustup, 'run', version, 'cargo', '--version'], env=local)
    print(compiler['stdout'].strip() + ': cargo test --locked', flush=True)
    result = command([rustup, 'run', version, 'cargo', 'test', '--locked'], cwd=source, env=local)
    result['command'] = ['rustup', 'run', version, 'cargo', 'test', '--locked']
    return {'status': 'passed' if not result['exitCode'] else 'failed',
            'rustupVersion': manager['stdout'].strip(), 'rustcVersion': compiler['stdout'].strip(),
            'cargoVersion': cargo['stdout'].strip(), 'officialChannel': channel_url,
            'channelDate': manifest['date'], 'channelSha256': sha(channel),
            'verifiedExecutablePaths': executable_paths,
            'integrity': 'rustup verifies the official component checksums during installation.',
            'isolation': {key: value.replace(str(root), '<temporary>') for key, value in local.items()
                          if key in ['RUSTUP_HOME', 'CARGO_HOME', 'RUSTUP_TOOLCHAIN', 'RUSTUP_AUTO_INSTALL', 'CARGO_TARGET_DIR', 'CARGO_BUILD_JOBS']},
            'install': install, 'test': result}


def main():
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise SystemExit('This reproduction script targets the reviewed macOS arm64 host.')
    original = protected_files()
    originals = {name: snapshot(ADAPTERS / name) for name in ['go', 'rust']}
    report = {'recordedAtUtc': datetime.now(timezone.utc).isoformat(), 'host': platform.platform(),
              'sourceRevision': checked(['git', 'rev-parse', 'HEAD'], cwd=REPOSITORY)['stdout'].strip(),
              'sourceHashes': originals, 'toolchains': {}, 'providerCalls': 0, 'gpuUsed': False}
    with tempfile.TemporaryDirectory(prefix='jev-other-adapters-') as temporary:
        root = Path(temporary)
        env = {**os.environ, 'XDG_CACHE_HOME': str(root / 'xdg-cache'), 'XDG_CONFIG_HOME': str(root / 'xdg-config')}
        for name, runner in [('go', go_check), ('rust', rust_check)]:
            source = root / 'adapters' / name
            shutil.copytree(ADAPTERS / name, source, ignore=shutil.ignore_patterns('target', '.git'))
            try:
                report['toolchains'][name] = runner(root, env, source)
            except Exception as error:
                report['toolchains'][name] = {'status': 'failed', 'errorType': type(error).__name__, 'error': str(error)}
            report['toolchains'][name]['sourceCopyUnchanged'] = snapshot(source) == originals[name]
            REPORT.write_text(json.dumps(report, indent=2) + '\n')
        report['globalConfigurationUnchanged'] = protected_files() == original
        report['originalAdapterSourcesUnchanged'] = all(snapshot(ADAPTERS / name) == hashes for name, hashes in originals.items())
    report['temporaryFilesRemoved'] = not root.exists()
    report['passed'] = all(row['status'] == 'passed' and row['sourceCopyUnchanged'] for row in report['toolchains'].values()) and report['globalConfigurationUnchanged'] and report['originalAdapterSourcesUnchanged']
    REPORT.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'report': str(REPORT), 'passed': report['passed'],
                      'results': {name: row['status'] for name, row in report['toolchains'].items()}}), flush=True)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
