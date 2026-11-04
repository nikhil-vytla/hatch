# /// script
# requires-python = ">=3.11"
# dependencies = ["marimo", "torch", "transformers>=4.51", "accelerate", "huggingface_hub"]
# ///
"""Live neuron-push playground, in the browser with marimo.

Open on molab:
https://molab.marimo.io/github/nikhil-vytla/hatch/blob/main/neuron-atlas/tools/play.py

Pick one of the five atlas models, type a recipe (or use the prompt chips), press Run, and compare the normal and
pushed replies. The hook logic is imported from push.py in this folder. Query params prefill the app:
?model=Qwen/Qwen3-8B&recipe=L8N7846%2B0.5&prompt=Who%20are%20you%3F
"""

import marimo

__generated_with = "0.25.2"
app = marimo.App(width="medium")


@app.cell
def _():
    import os
    import sys

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import marimo as mo
    from push import (ATLAS_MODELS, Steer, chat_prompt, compile_terms, estimate_resid_median, generate,
                      load_model, load_resid_median, recipe_terms)
    return (ATLAS_MODELS, Steer, chat_prompt, compile_terms, estimate_resid_median, generate, load_model,
            load_resid_median, mo, recipe_terms)


@app.cell
def _(Steer, chat_prompt, estimate_resid_median, load_model, load_resid_median, mo):
    @mo.cache
    def get_model(name):
        model, tok, device = load_model(name)
        steer = Steer(model)
        resid = load_resid_median(name)
        if resid is None:
            resid = estimate_resid_median(model, tok, device, chat_prompt(tok, "Who are you?"))
        return model, tok, device, steer, resid
    return (get_model,)


@app.cell
def _(ATLAS_MODELS, mo):
    q = mo.query_params()
    model0 = q.get("model") or "Qwen/Qwen3.5-4B"
    if model0 not in ATLAS_MODELS:
        model0 = "Qwen/Qwen3.5-4B"
    recipe0 = q.get("recipe") or "L3N2410-0.8"
    prompt0 = q.get("prompt") or "Who are you?"
    prompt_state, set_prompt = mo.state(prompt0)
    chips = [mo.ui.button(label=p, on_click=lambda _, p=p: set_prompt(p))
             for p in ("Who are you?", "Who am I?", "Tell me a short story.")]
    controls = mo.md("""
    **Model** {model}

    **Recipe** {recipe}

    **Prompt** {prompt}

    **Dose scale** {dose}
    """).batch(
        model=mo.ui.dropdown(options=ATLAS_MODELS, value=model0, label="model", allow_select_none=False),
        recipe=mo.ui.text(value=recipe0, label="recipe"),
        prompt=mo.ui.text_area(value=prompt_state(), label="prompt", rows=2),
        dose=mo.ui.slider(0.0, 2.0, step=0.05, value=1.0, label="dose scale", show_value=True),
    ).form(submit_button_label="Run")
    mo.vstack([
        mo.md("# Push a neuron\nPick a model, a recipe, and a prompt. Click a chip to fill the prompt, then **Run**."),
        mo.hstack(chips, wrap=True),
        controls,
    ])
    return (controls,)


@app.cell
def _(chat_prompt, compile_terms, controls, generate, get_model, mo, recipe_terms):
    if controls.value is None:
        result = mo.md("Press **Run** to compare the normal reply with the pushed one.")
    else:
        values = controls.value
        try:
            model, tok, device, steer, resid = get_model(values["model"])
            scale = float(values["dose"])
            raw = [{**t, "value": t["value"] * scale} for t in recipe_terms(values["recipe"])]
            terms = compile_terms(raw, resid, steer.norms)
            text = chat_prompt(tok, values["prompt"])
            steer.clear()
            normal = generate(model, tok, device, text, 64)
            steer.set(terms)
            pushed = generate(model, tok, device, text, 64)
            steer.clear()
            result = mo.hstack([
                mo.md(f"**Normal**\n\n{normal}"),
                mo.md(f"**Pushed** · `{values['recipe']}` × {scale:g}\n\n{pushed}"),
            ], widths="equal", gap=1)
        except SystemExit as exc:
            result = mo.md(f"**push.py says:** {exc}")
        except Exception as exc:
            result = mo.md(f"**Error:** `{type(exc).__name__}: {exc}`")
    result


if __name__ == "__main__":
    app.run()
