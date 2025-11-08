"""Text Labeling Demo - Marimo Notebook

This notebook demonstrates how to use the TextLabel widget for binary classification tasks.
"""

import marimo

__generated_with = "0.17.7"
app = marimo.App()


@app.cell
def _():
    import marimo as mo
    import sys
    sys.path.insert(0, '..')
    from llabel import TextLabel
    from datasets import load_dataset
    return TextLabel, load_dataset, mo


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    # Text Labeling Demo

    This notebook demonstrates how to use the `TextLabel` widget for binary classification tasks.
    """)
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Sentiment Analysis with IMDB Dataset

    Let's label movie reviews from the IMDB dataset for sentiment analysis.
    """)
    return


@app.cell
def _(load_dataset, mo):
    # Load IMDB dataset from HuggingFace
    dataset = load_dataset("imdb", split="test")

    # Take a small sample for labeling (50 reviews)
    sample_indices = range(0, 50)
    # Convert data to list of dicts (dict is the required format for the TextLabel widget)
    examples = [{"text": dataset[i]["text"]} for i in sample_indices]

    mo.md(f"Loaded {len(examples)} movie reviews from IMDB dataset")
    return (examples,)


@app.cell
def _(TextLabel, examples, mo):
    # Create widget for sentiment labeling
    # Users will label as positive (Yes) or negative (No)
    widget = mo.ui.anywidget(
        TextLabel(
            examples=examples,
            render=lambda ex: ex["text"],  # Extract text field from dict
            notes=True
        )
    )

    widget
    return (widget,)


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ### Instructions

    - Click **Yes** for positive sentiment
    - Click **No** for negative sentiment
    - Click **Skip** if unsure
    - Use **Alt+2**, **Alt+3**, **Alt+4** for keyboard shortcuts
    - Add notes for context or edge cases
    """)
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Export Annotations

    After labeling, export your annotations for further processing.
    """)
    return


@app.cell
def _(widget):
    # Explore annotations as you label
    widget.get_annotations()
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Check Progress

    Monitor your labeling progress.
    """)
    return


@app.cell
def _(mo, widget):
    progress = widget.progress()
    mo.md(f"""
    **Progress:** {progress['labeled']}/{progress['total']} ({progress['percent']}%)
    **Remaining:** {progress['remaining']}
    """)
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Save to File

    Save your annotations for later use.
    """)
    return


@app.cell
def _(mo):
    import json

    # Test with run_button instead (works better in marimo)
    save_button = mo.ui.run_button(label="Save Annotations")
    save_button
    return json, save_button


@app.cell
def _(json, mo, save_button, widget):
    mo.stop(not save_button.value)

    export_anns = widget.export_annotations(include_examples=True)

    with open('text_annotations.json', 'w') as f:
        json.dump(export_anns, f, indent=2)

    mo.md(f"✓ Saved {len(export_anns)} annotations to text_annotations.json")
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Custom Render Function

    You can provide a custom render function to display examples in any format.
    """)
    return


@app.cell
def _(TextLabel, mo):
    # Sample data with metadata
    tweet_examples = [
        {"text": "Machine learning is fascinating", "author": "Alice", "date": "2024-01-15"},
        {"text": "AI will change everything", "author": "Bob", "date": "2024-01-16"},
        {"text": "Deep learning requires lots of data", "author": "Charlie", "date": "2024-01-17"},
        {"text": "Neural networks are powerful", "author": "Diana", "date": "2024-01-18"},
    ]

    # Custom HTML render function
    def render_tweet(example):
        return f"""
        <div style="border-left: 4px solid #1DA1F2; padding-left: 16px; margin: 8px 0;">
            <p style="font-size: 18px; margin: 8px 0;">{example['text']}</p>
            <p style="color: #657786; font-size: 14px; margin: 8px 0;">
                <strong>@{example['author']}</strong> · {example['date']}
            </p>
        </div>
        """

    _widget2 = TextLabel(
        examples=tweet_examples,
        render=render_tweet,
        notes=True
    )

    # Wrap with Marimo's anywidget wrapper
    widget2 = mo.ui.anywidget(_widget2)

    widget2
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Custom Keyboard Shortcuts

    You can customize keyboard shortcuts to match your workflow.
    """)
    return


@app.cell
def _(TextLabel, mo):
    # Custom shortcuts
    custom_shortcuts = {
        "y": "yes",
        "n": "no",
        "s": "skip",
        "p": "prev",
        "t": "focus_notes"
    }

    _widget3 = TextLabel(
        examples=[{"text": "Example 1"}, {"text": "Example 2"}, {"text": "Example 3"}],
        render=lambda ex: ex["text"],
        shortcuts=custom_shortcuts,
        notes=True
    )

    # Wrap with Marimo's anywidget wrapper
    widget3 = mo.ui.anywidget(_widget3)

    # Note: This will use single-key shortcuts instead of Alt+ combinations
    widget3
    return


if __name__ == "__main__":
    app.run()
