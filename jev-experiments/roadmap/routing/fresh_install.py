#!/usr/bin/env python3
"""Check an isolated fresh CLI/MCP install without providers or model inference.

The report goes to stdout unless --output names a new file. Historical evidence
is never replaced. Staged source is deleted before the first installed action.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SOURCE_FOLDERS = ["jev-experiments/roadmap/routing", "jev-experiments/roadmap/runtime",
                  "jev-experiments/packages/decision-runtime/src"]
NATIVE_REQUEST = {
    "schemaVersion": "2", "requestId": "installed-native-v2",
    "state": {"fixture": ["structured", {"count": 2, "enabled": True}, None]},
    "questions": [
        {"id": "choice", "kind": "choice", "prompt": {"instruction": "Choose a named entry"},
         "options": [{"id": "first", "label": "First", "description": {"value": [1, True]}},
                     {"id": "second", "label": "Second", "description": ["two", None]},
                     {"id": "third", "label": "Third", "description": None}]},
        {"id": "noul", "kind": "boolean", "prompt": ["Evaluate", {"field": "enabled"}],
         "criteria": {"true": {"meaning": "yes"}, "false": ["no", None]}},
        {"id": "score", "kind": "ordinal", "prompt": None, "min": 10, "max": 30, "step": 10,
         "levels": [{"meaning": "low"}, ["middle", 20], "high"]},
    ],
}
ORDINAL_LIMIT = {"schemaVersion": "2", "requestId": "installed-limit", "state": {},
                 "questions": [{"id": "score", "kind": "ordinal", "prompt": "Eleven levels", "min": 0, "max": 10}]}
TASK = {"id": "installed-no-route", "prompt": "Analyze this synthetic fixture", "context": "Only supplied fixture data.", "outputTokens": 128}
MAIL = "Subject: Receipt\nContent-Type: text/plain\n\nPayment received. Thank you.\n"
ENCODED_MAIL = "Subject: Encoded fixture\nContent-Type: text/plain\nContent-Transfer-Encoding: base64\n\nSGVsbG8=\n"


def digest(value):
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def native_semantics(value):
    require(value["status"] == "ok" and value["schemaVersion"] == "2" and not value["issues"], "Native request did not succeed")
    require(value["execution"] == {"adapter": "state-blind-prior", "model": "uniform-v1", "local": True}, "Unexpected decision adapter")
    rows = {row["questionId"]: row for row in value["decisions"]}
    require(set(rows) == {"choice", "noul", "score"}, "Missing typed decision")
    require(rows["choice"]["selected"] == "first" and rows["choice"]["distribution"] ==
            [{"value": name, "probability": 1 / 3} for name in ["first", "second", "third"]], "Choice distribution changed")
    require(rows["noul"]["selected"] is False and rows["noul"]["probabilityTrue"] == 0.5 and
            rows["noul"]["distribution"] == [{"value": False, "probability": 0.5}, {"value": True, "probability": 0.5}], "Noul probability changed")
    require(rows["score"]["selected"] == 10 and rows["score"]["expected"] == 20 and
            rows["score"]["distribution"] == [{"value": value, "probability": 1 / 3} for value in [10, 20, 30]], "Score modal/expected semantics changed")


def run_check():
    started = time.monotonic()
    bun = shutil.which("bun")
    require(bun is not None, "Bun is required")
    source_files = [path for folder in SOURCE_FOLDERS for path in (ROOT / folder).glob("*.ts") if not path.name.endswith(".test.ts")]
    # The opt-in hosted classifier shares the maintained native gateway adapter.
    # Include its source in the isolated tree; a working checkout must not hide
    # an incomplete standalone bundle dependency closure.
    source_files += [HERE / "install.sh", ROOT / "jev-experiments/roadmap/mac/models.json",
                     ROOT / "jev-experiments/experience-prototypes/server/gateway.ts"]
    source_hashes = {path.relative_to(ROOT).as_posix(): digest(path.read_bytes()) for path in sorted(source_files)}
    historical = HERE / "fresh-install.json"
    historical_hash = digest(historical.read_bytes()) if historical.exists() else None
    git_head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip() if (ROOT / ".git").exists() else None
    report = {"condition": "Current source-built Bun CLI/MCP; no configured destination, provider call, weights, or model inference.",
              "provenance": {"gitHead": git_head, "sourceState": "staged-working-tree-bytes", "stagedSourceSha256": source_hashes,
                             "sourceDigest": digest(json.dumps(source_hashes, sort_keys=True)),
                             "verifierSha256": digest(Path(__file__).read_bytes()), "historicalFreshInstallSha256": historical_hash},
              "inputs": {"nativeRequest": NATIVE_REQUEST, "ordinalLimitRequest": ORDINAL_LIMIT, "task": TASK,
                         "mailSha256": digest(MAIL), "encodedMailSha256": digest(ENCODED_MAIL)}, "checks": {}}
    with tempfile.TemporaryDirectory(prefix="jev-router-install-v2-") as temporary:
        area = Path(temporary)
        stage, cwd, user_dir, scratch = [area / name for name in ["source", "unrelated-working-directory", "empty-user-directory", "scratch"]]
        for folder in [cwd, user_dir, scratch]:
            folder.mkdir()
        for source in source_files:
            target = stage / source.relative_to(ROOT)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read_bytes())
        env = {"PATH": str(Path(bun).parent) + os.pathsep + "/usr/bin:/bin", "HOME": str(user_dir),
               "TMPDIR": str(scratch), "LANG": "C", "LC_ALL": "C"}
        report["bunVersion"] = subprocess.check_output([bun, "--version"], cwd=cwd, env=env, text=True).strip()
        builtins = set(json.loads(subprocess.check_output(
            [bun, "-e", 'console.log(JSON.stringify(require("node:module").builtinModules))'],
            cwd=cwd, env=env, text=True)))
        prefix = area / "installed prefix with spaces"
        install = subprocess.run(["sh", str(stage / "jev-experiments/roadmap/routing/install.sh"), str(prefix)],
                                 cwd=cwd, env=env, capture_output=True, text=True, timeout=30)
        require(install.returncode == 0, "Isolated staged installation failed")
        bundle = (prefix / "lib/jev.js").read_bytes()
        external_imports = sorted(set(re.findall(r'(?:\bfrom\s*|\bimport\s*\(\s*)[\"\']([^\"\']+)', bundle.decode())))
        require(all(name.removeprefix("node:") in builtins or name == "bun" for name in external_imports), "Bundle retains a non-builtin import")
        require(str(ROOT).encode() not in bundle and str(stage).encode() not in bundle, "Bundle contains a build-tree path")
        report.update({"bundleBytes": len(bundle), "bundleSha256": digest(bundle),
                       "installedFiles": {path.relative_to(prefix).as_posix(): digest(path.read_bytes()) for path in prefix.rglob("*") if path.is_file()},
                       "externalImports": external_imports})
        shutil.rmtree(stage)
        report["checks"]["stagedSourceRemovedBeforeFirstAction"] = not stage.exists()
        cli = str(prefix / "bin/jev")
        mail, encoded_mail, request = cwd / "receipt.eml", cwd / "encoded.eml", cwd / "native.json"
        mail.write_text(MAIL)
        encoded_mail.write_text(ENCODED_MAIL)
        request.write_text(json.dumps(NATIVE_REQUEST) + "\n")
        input_hashes = {path.name: digest(path.read_bytes()) for path in cwd.iterdir()}

        def invoke(operation, value=None, filename=None, expected_exit=0):
            argv = [cli, operation] + ([filename.name] if filename else [])
            result = subprocess.run(argv, input=json.dumps(value) if value is not None else None,
                                    cwd=cwd, env=env, capture_output=True, text=True, timeout=15)
            require(result.returncode == expected_exit and not result.stderr, "Installed CLI exit or stderr differs: " + operation)
            return {"exitCode": result.returncode, "result": json.loads(result.stdout)}

        doctor = invoke("doctor")
        require(doctor["result"]["configuredRoutes"] == [] and doctor["result"]["localCloudFallback"] is False
                and doctor["result"]["operations"] == ["decide", "route_task", "classify_eml"], "Doctor configuration differs")
        outcomes = {"doctor": doctor, "decide": invoke("decide", filename=request),
                    "decideUnsupported": invoke("decide", ORDINAL_LIMIT, expected_exit=2),
                    "routeUnavailable": invoke("route_task", TASK, expected_exit=2),
                    "routeUnsupported": invoke("route_task", {**TASK, "id": ""}, expected_exit=2),
                    "email": invoke("classify_eml", filename=mail),
                    "emailUnsupported": invoke("classify_eml", filename=encoded_mail, expected_exit=2)}
        native_semantics(outcomes["decide"]["result"])
        unsupported = outcomes["decideUnsupported"]["result"]
        require(unsupported["status"] == "unsupported" and unsupported["decisions"] == []
                and any(issue["code"] == "ordinal_limit" for issue in unsupported["issues"]), "Ordinal limit was not explicit")
        for key, status in [("routeUnavailable", "unavailable"), ("routeUnsupported", "unsupported")]:
            require(outcomes[key]["result"]["status"] == status and outcomes[key]["result"]["attempts"] == []
                    and "artifact" not in outcomes[key]["result"]["outcome"], "Routing refusal changed")
        require(outcomes["email"]["result"]["selected"] == "receipt" and outcomes["email"]["result"]["calibrated"] is False, "Lexical email result changed")
        require(outcomes["emailUnsupported"]["result"]["status"] == "unsupported"
                and outcomes["emailUnsupported"]["result"]["labels"] == [], "Unsupported MIME was not explicit")
        report["cli"], report["doctor"] = outcomes, doctor["result"]
        report["checks"]["installedCliSemantics"] = True

        audit_file, transcript = area / "mcp-audit.jsonl", []
        with tempfile.TemporaryFile() as errors:
            process = subprocess.Popen([cli, "mcp"], cwd=cwd, env={**env, "JEV_MCP_AUDIT": str(audit_file)},
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors, text=True)
            selector = selectors.DefaultSelector()
            selector.register(process.stdout, selectors.EVENT_READ)

            def exchange(message):
                transcript.append({"direction": "client", "message": message})
                process.stdin.write(json.dumps(message) + "\n")
                process.stdin.flush()
                if "id" not in message:
                    return None
                require(bool(selector.select(timeout=15)), "Installed MCP response timed out")
                line = process.stdout.readline()
                require(bool(line), "Installed MCP closed before replying")
                reply = json.loads(line)
                transcript.append({"direction": "server", "message": reply})
                require(reply.get("id") == message["id"] and "error" not in reply, "Unexpected MCP reply")
                return reply["result"]

            try:
                initialized = exchange({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                    "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "fresh-install-v2", "version": "2"}}})
                require(initialized["protocolVersion"] == "2025-06-18", "MCP initialization changed")
                exchange({"jsonrpc": "2.0", "method": "notifications/initialized"})
                discovery = exchange({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
                tools = {tool["name"]: tool for tool in discovery["tools"]}
                require(set(tools) == {"decide", "route_task", "classify_eml"}, "Installed MCP tool set differs")
                schema = tools["decide"]["inputSchema"]["properties"]["request"]
                require(schema["properties"]["schemaVersion"] == {"const": "2"}, "Installed MCP advertises an old contract")
                variants = schema["properties"]["questions"]["items"]["oneOf"]
                require(all({entry["type"] for entry in variant["properties"]["prompt"]["anyOf"]} ==
                            {"string", "object", "array", "null"} for variant in variants), "Structured prompt shapes missing from discovery")
                calls = [("decide", {"request": NATIVE_REQUEST}, "ok"),
                         ("decide", {"request": ORDINAL_LIMIT}, "unsupported"),
                         ("route_task", {"task": TASK}, "unavailable"),
                         ("route_task", {"task": {**TASK, "id": ""}}, "unsupported"),
                         ("classify_eml", {"eml": MAIL}, "ok"),
                         ("classify_eml", {"eml": ENCODED_MAIL}, "unsupported")]
                mcp_results = []
                for request_id, (name, arguments, status) in enumerate(calls, 3):
                    response = exchange({"jsonrpc": "2.0", "id": request_id, "method": "tools/call", "params": {"name": name, "arguments": arguments}})
                    structured = response["structuredContent"]
                    require(structured["status"] == status and response["isError"] == (status != "ok")
                            and json.loads(response["content"][0]["text"]) == structured, "Installed MCP content or error flag differs")
                    mcp_results.append(structured)
                native_semantics(mcp_results[0])
                require(mcp_results[1]["decisions"] == [] and any(issue["code"] == "ordinal_limit" for issue in mcp_results[1]["issues"]), "MCP ordinal limit changed")
                require(mcp_results[2]["attempts"] == mcp_results[3]["attempts"] == [], "MCP refusal made an attempt")
                require(mcp_results[4]["selected"] == "receipt" and mcp_results[4]["calibrated"] is False and mcp_results[5]["labels"] == [], "MCP email semantics changed")
                process.stdin.close()
                require(process.wait(timeout=10) == 0, "Installed MCP did not exit cleanly")
                require(process.stdout.read() == "", "Unexpected extra MCP stdout")
                errors.seek(0)
                require(errors.read() == b"", "Installed MCP wrote stderr")
            finally:
                selector.close()
                if process.poll() is None:
                    process.kill()
                    process.wait()
        audit = [json.loads(line) for line in audit_file.read_text().splitlines()]
        require(sum(row["event"] == "tools/call" for row in audit) == 6
                and sum(row["event"] == "tools/result" for row in audit) == 6, "MCP audit did not record complete calls")
        report["mcp"] = {"exitCode": process.returncode, "transcript": transcript, "audit": audit}
        report["checks"]["installedMcpDiscoveryAndCalls"] = True
        report["mailUnchanged"] = mail.read_text() == MAIL
        report["checks"]["allInputsUnchanged"] = input_hashes == {path.name: digest(path.read_bytes()) for path in cwd.iterdir()}
        shutil.rmtree(prefix)
        report["uninstalled"] = not prefix.exists()
        report["checks"]["documentedPrefixRemovalUninstalls"] = report["uninstalled"]
    report["checks"]["sourceBytesUnchanged"] = source_hashes == {path.relative_to(ROOT).as_posix(): digest(path.read_bytes()) for path in sorted(source_files)}
    report["checks"]["historicalReportPreserved"] = historical_hash == (digest(historical.read_bytes()) if historical.exists() else None)
    report["passed"] = all(report["checks"].values())
    report["elapsedSeconds"] = round(time.monotonic() - started, 3)
    report["limits"] = "Uniform decisions test typed arithmetic and accepted structure, not model quality. Email is an uncalibrated lexical baseline. No-route refusals do not exercise provider execution. No network sandbox or billing claim is implied."
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="Create a new report; fail if the path already exists")
    args = parser.parse_args()
    if args.output and args.output.exists():
        parser.error("Output already exists; choose a new report path")
    report = run_check()
    encoded = json.dumps(report, indent=2) + "\n"
    if args.output:
        with args.output.open("x") as stream:
            stream.write(encoded)
        print(json.dumps({key: report[key] for key in ["passed", "bundleBytes", "bundleSha256", "mailUnchanged", "uninstalled"]}, indent=2))
    else:
        print(encoded, end="")
    raise SystemExit(0 if report["passed"] else 1)
