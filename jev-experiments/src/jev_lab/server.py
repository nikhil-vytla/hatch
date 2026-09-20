"""Loopback-only development API. Cloud deployment has a separate authenticated handler."""

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .core import ROOT, Client, Ledger, Run, load_shell_key


@asynccontextmanager
async def lifespan(app):
    load_shell_key()
    run = Run("browser-live")
    app.state.client = Client(run)
    yield
    await app.state.client.close()
    run.finish(
        {"note": "Interactive private requests remain in ignored runs, not public gallery results."}
    )


app = FastAPI(lifespan=lifespan)
(ROOT / "results").mkdir(exist_ok=True)
app.mount("/results", StaticFiles(directory=ROOT / "results"), name="results")


class Evaluation(BaseModel):
    state: str | dict | list
    questions: dict = Field(min_length=1, max_length=128)


@app.get("/api/health")
def health():
    return {"local": True, "live": True, "budget": Ledger().summary()}


@app.post("/api/evaluate")
async def evaluate(body: Evaluation):
    try:
        return await app.state.client.evaluate(body.state, body.questions, "browser-live")
    except Exception as exc:
        raise HTTPException(502, str(exc)) from None


@app.post("/api/language-results")
async def language_results(body: dict):
    from .language import evaluate_local_results

    return await evaluate_local_results(app.state.client, body)
