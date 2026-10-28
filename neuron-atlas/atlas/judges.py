"""LLM judges for labeling and detection checks: OpenAI-compatible endpoints plus OpenCode's free models.

    deepseek                      OpenAIJudge(label.MODEL, label.BASE_URL, label.KEY)
    openai:<base_url>:<model>     any OpenAI-compatible server (key from OPENAI_API_KEY or label.KEY)
    opencode/<model>              an OpenCode free model, through `opencode run` (rate-limited free tier)
"""
import json, os, re, shutil, subprocess, tempfile, threading
from contextlib import contextmanager
from openai import OpenAI

from . import label

PROMPT = "You are a careful annotator. Reply with JSON only."


def _object(text):
    """First JSON object in text, tolerating prose or a code fence around it."""
    i = (text or "").find("{")
    if i < 0:
        return None
    try:
        obj, _ = json.JSONDecoder().raw_decode(text[i:])
        return obj if isinstance(obj, dict) else None
    except ValueError:
        return None


class Judge:
    name = "judge"

    def ask(self, system, user):
        """Call the backend up to 3 times and return its first JSON object, else None."""
        err = None
        for _ in range(3):
            try:
                obj = _object(self.raw(system, user))
                if obj is not None:
                    return obj
                err = "no JSON object in reply"
            except Exception as e:  # retry transient API, process or JSON errors
                err = e
        print(f"  {self.name} failed: {err}")
        return None

    def raw(self, system, user):
        raise NotImplementedError


class OpenAIJudge(Judge):
    """An OpenAI-compatible chat endpoint, like atlas.label's default DeepSeek client."""

    def __init__(self, model, base_url, api_key, name=None):
        self.model, self.name = model, name or model
        self.cl = OpenAI(base_url=base_url, api_key=api_key)

    def raw(self, system, user):
        r = self.cl.chat.completions.create(model=self.model, messages=[
            {"role": "system", "content": system}, {"role": "user", "content": user}],
            response_format={"type": "json_object"}, temperature=0.2, max_tokens=4000)
        return r.choices[0].message.content or ""


ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


class FreeLimit(RuntimeError):
    """OpenCode refused the call: the free-model usage limit for this machine is used up."""


class OpenCodeJudge(Judge):
    """An OpenCode free model through the opencode CLI (free models are refused over plain HTTP).

    Runs `opencode run -m <model> --agent judge` in the config dir from `opencode_server()`, reading plain text:
    opencode 1.19's `--format json` hangs when stdout is a pipe. When the free quota is used up opencode retries
    silently forever, so stderr is watched with --print-logs and the call fails fast on that error."""

    def __init__(self, model, cfg_dir):
        self.model, self.cfg_dir, self.name, self.exhausted = model, cfg_dir, model, False

    def ask(self, system, user):
        return None if self.exhausted else super().ask(system, user)

    def raw(self, system, user):
        if self.exhausted:
            raise FreeLimit(self.model)
        cmd = ["opencode", "run", "--print-logs", "-m", self.model, "--agent", "judge", f"{system}\n\n{user}"]
        p = subprocess.Popen(cmd, cwd=self.cfg_dir, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        err = []

        def watch():
            for line in p.stderr:
                err.append(line)
                if "Free usage" in line or "FreeUsageLimit" in line:
                    self.exhausted = True
                    p.kill()

        t = threading.Thread(target=watch, daemon=True)
        t.start()
        try:
            out, _ = p.communicate(timeout=300)
        except subprocess.TimeoutExpired:
            p.kill()
            raise
        t.join(timeout=5)
        if self.exhausted:
            print(f"  {self.model}: free usage limit reached, skipping it from now on")
            raise FreeLimit(self.model)
        if p.returncode:
            raise RuntimeError(f"opencode run exited {p.returncode}: {''.join(err)[-400:]}")
        lines = [l for l in ANSI.sub("", out).splitlines() if l.strip() and not l.startswith("> ")]
        return "\n".join(lines)


@contextmanager
def opencode_server(port=None):
    """A temp dir whose opencode.json defines a `judge` agent with every tool denied; yields its path.
    (Named for the original design; OpenCodeJudge runs `opencode run` in this dir, no server needed.)"""
    d = tempfile.mkdtemp(prefix="opencode-judge-")
    deny = {k: "deny" for k in ["edit", "bash", "webfetch", "websearch", "read", "glob", "grep", "list", "task",
                                "todowrite", "codesearch"]}
    cfg = {"$schema": "https://opencode.ai/config.json",
           "agent": {"judge": {"description": "JSON annotator", "mode": "primary", "prompt": PROMPT,
                               "permission": deny}}}
    with open(os.path.join(d, "opencode.json"), "w") as f:
        json.dump(cfg, f, indent=2)
    try:
        yield d
    finally:
        shutil.rmtree(d, ignore_errors=True)


def make_judge(spec, server=None):
    """Build a judge from a CLI spec string; opencode specs need the URL from `opencode_server`."""
    if spec == "deepseek":
        return OpenAIJudge(label.MODEL, label.BASE_URL, label.KEY, name="deepseek")
    if spec.startswith("openai:"):
        base_url, model = spec[len("openai:"):].rsplit(":", 1)
        return OpenAIJudge(model, base_url, os.environ.get("OPENAI_API_KEY") or label.KEY, name=model)
    if spec.startswith("opencode/"):
        if not server:
            raise ValueError("opencode judges need the config dir from opencode_server()")
        return OpenCodeJudge(spec, server)
    raise ValueError(f"unknown judge spec: {spec}")
