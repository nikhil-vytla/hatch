"""Hatch Inspect — Modal orchestration / execution plane.

Implements the same HTTP compute contract as scripts/compute-shim.ts:
  GET  /health
  POST /v1/sandboxes
  DELETE /v1/sandboxes/{id}
  GET  /v1/sandboxes/{id}/artifacts
  POST /v1/sandboxes/{id}/commit
  POST /v1/sandboxes/{id}/prompt   (NDJSON stream)

Deploy:
  modal setup
  modal deploy cloud/modal/inspect_modal/app.py

Dev (serves ASGI locally via Modal):
  modal serve cloud/modal/inspect_modal/app.py
"""

from __future__ import annotations

import json
import os
import shlex
import tarfile
import tempfile
import time
from pathlib import Path
from typing import Any, AsyncIterator

import modal
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

app = modal.App("hatch-inspect-compute")

# Image with git + node-ish tooling for OpenCode later. Start with git/python.
image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git", "curl", "ca-certificates", "ripgrep")
    .pip_install("fastapi", "uvicorn")
)

# Sandbox id → Modal Sandbox object id (string), kept in a Dict for the Worker.
sandboxes = modal.Dict.from_name("hatch-inspect-sandboxes", create_if_missing=True)
# Optional prompt queue (Ramp-shaped ingress). Control plane may enqueue here later.
prompt_queue = modal.Queue.from_name("hatch-inspect-prompts", create_if_missing=True)


def _run(sb: modal.Sandbox, *args: str, timeout: int = 120) -> str:
    p = sb.exec(*args, timeout=timeout)
    out = p.stdout.read()
    err = p.stderr.read()
    if p.wait() != 0:
        raise RuntimeError(err or out or f"command failed: {args}")
    return out


def _write_files(sb: modal.Sandbox, files: dict[str, str]) -> None:
    for rel, content in files.items():
        # Ensure parent dirs and write via shell to avoid large SDK file APIs.
        parent = str(Path(rel).parent)
        if parent not in (".", ""):
            _run(sb, "bash", "-lc", f"mkdir -p /workspace/{shlex.quote(parent)}")
        # Prefer printf for small files
        b64 = __import__("base64").b64encode(content.encode()).decode()
        _run(
            sb,
            "bash",
            "-lc",
            f"echo {shlex.quote(b64)} | base64 -d > /workspace/{shlex.quote(rel)}",
        )


web = FastAPI(title="Hatch Inspect Compute (Modal)")


@web.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "backend": "modal"}


@web.post("/v1/sandboxes")
def create_sandbox(body: dict[str, Any]) -> dict[str, Any]:
    sb = modal.Sandbox.create(
        image=image,
        app=app,
        timeout=60 * 60,
        workdir="/workspace",
    )
    author = body.get("author") or {"name": "Inspect User", "email": "user@localhost"}
    clone_url = body.get("cloneUrl")
    seed = body.get("seedFiles")
    branch = f"inspect/{sb.object_id[-8:]}"

    if clone_url:
        _run(sb, "bash", "-lc", f"git clone --depth 50 {shlex.quote(clone_url)} /workspace")
        _run(sb, "bash", "-lc", f"git checkout -B {shlex.quote(branch)}")
    else:
        _run(sb, "bash", "-lc", "git init -b main")
        files = seed or {
            "README.md": "# Hatch Inspect Modal sandbox\n",
            "src/index.ts": "export function greet(name: string) {\n  return `hello ${name}`;\n}\n",
        }
        _write_files(sb, files)
        _run(sb, "bash", "-lc", "git add -A")
        _run(
            sb,
            "bash",
            "-lc",
            "git -c user.name=Inspect -c user.email=inspect@localhost commit -m 'chore: seed'",
        )
        _run(sb, "bash", "-lc", f"git checkout -B {shlex.quote(branch)}")

    _run(
        sb,
        "bash",
        "-lc",
        f"git config user.name {shlex.quote(author['name'])} && git config user.email {shlex.quote(author['email'])}",
    )
    sandboxes.put(sb.object_id, {"branch": branch, "createdAt": time.time()})
    return {"id": sb.object_id, "branch": branch}


@web.delete("/v1/sandboxes/{sandbox_id}")
def destroy_sandbox(sandbox_id: str) -> dict[str, Any]:
    try:
        sb = modal.Sandbox.from_id(sandbox_id)
        sb.terminate()
    except Exception:
        pass
    try:
        sandboxes.pop(sandbox_id)
    except KeyError:
        pass
    return {"ok": True, "diskGone": True}


@web.get("/v1/sandboxes/{sandbox_id}/artifacts")
def artifacts(sandbox_id: str) -> dict[str, Any]:
    sb = modal.Sandbox.from_id(sandbox_id)
    porcelain = _run(sb, "bash", "-lc", "git status --porcelain")
    diff = _run(sb, "bash", "-lc", "git diff HEAD || true")
    files: list[dict[str, Any]] = []
    for line in porcelain.splitlines():
        if not line.strip():
            continue
        rel = line[3:].strip()
        if " -> " in rel:
            rel = rel.split(" -> ")[-1].strip()
        try:
            content = _run(sb, "bash", "-lc", f"cat {shlex.quote(rel)}")
            files.append(
                {
                    "path": rel,
                    "status": line[:2].replace(" ", ""),
                    "content": content[:80_000],
                    "truncated": len(content) > 80_000,
                    "binary": False,
                }
            )
        except Exception:
            files.append(
                {
                    "path": rel,
                    "status": line[:2].replace(" ", ""),
                    "content": None,
                    "truncated": False,
                    "binary": False,
                }
            )
    return {"diff": diff, "files": files}


@web.post("/v1/sandboxes/{sandbox_id}/commit")
def commit(sandbox_id: str, body: dict[str, Any]) -> dict[str, Any]:
    sb = modal.Sandbox.from_id(sandbox_id)
    meta = sandboxes.get(sandbox_id) or {}
    author = body.get("author") or {"name": "Inspect User", "email": "user@localhost"}
    message = body.get("message") or "inspect: commit"
    _run(
        sb,
        "bash",
        "-lc",
        f"git config user.name {shlex.quote(author['name'])} && git config user.email {shlex.quote(author['email'])}",
    )
    _run(sb, "bash", "-lc", "git add -A")
    status = _run(sb, "bash", "-lc", "git status --porcelain")
    if status.strip():
        _run(sb, "bash", "-lc", f"git commit -m {shlex.quote(message)}")
    sha = _run(sb, "bash", "-lc", "git rev-parse HEAD").strip()
    return {"sha": sha, "branch": meta.get("branch", "inspect/unknown")}


@web.post("/v1/sandboxes/{sandbox_id}/prompt")
async def prompt(sandbox_id: str, request: Request) -> StreamingResponse:
    """Run a coding agent inside the sandbox.

    Production path installs OpenCode and runs it. Until the image ships OpenCode,
    we accept a lightweight fallback that writes a marker file so the control plane
    contract stays testable after `modal deploy`.
    """
    body = await request.json()
    text = (body.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "text required")

    sb = modal.Sandbox.from_id(sandbox_id)
    # Enqueue for observability (Ramp-shaped Modal Queue ingress).
    prompt_queue.put({"sandboxId": sandbox_id, "text": text, "at": time.time()})

    async def gen() -> AsyncIterator[bytes]:
        def send(obj: dict[str, Any]) -> bytes:
            return (json.dumps(obj) + "\n").encode()

        try:
            # Prefer opencode if present on the image.
            has_oc = True
            try:
                _run(sb, "bash", "-lc", "command -v opencode", timeout=30)
            except Exception:
                has_oc = False

            if has_oc:
                model = body.get("model") or {
                    "providerID": "opencode",
                    "modelID": "big-pickle",
                }
                model_s = f"{model['providerID']}/{model['modelID']}"
                p = sb.exec(
                    "bash",
                    "-lc",
                    f"opencode run --dir /workspace --model {shlex.quote(model_s)} {shlex.quote(text)}",
                    timeout=240,
                )
                for line in p.stdout:
                    yield send({"kind": "text", "text": line})
                err = p.stderr.read()
                code = p.wait()
                if code != 0:
                    yield send({"kind": "error", "message": err or f"exit {code}"})
                else:
                    yield send({"kind": "idle"})
            else:
                # Contract fallback: materialize a trivial change so artifacts work.
                note = f"# agent note\n\nPrompt received:\n\n{text[:2000]}\n"
                _write_files(sb, {"notes/agent-prompt.md": note})
                yield send(
                    {
                        "kind": "text",
                        "text": "OpenCode not in image yet; wrote notes/agent-prompt.md",
                    }
                )
                yield send({"kind": "idle"})
        except Exception as e:
            yield send({"kind": "error", "message": str(e)})

    return StreamingResponse(gen(), media_type="application/x-ndjson")


@app.function(image=image, timeout=60 * 30)
@modal.asgi_app()
def fastapi_app():
    return web
