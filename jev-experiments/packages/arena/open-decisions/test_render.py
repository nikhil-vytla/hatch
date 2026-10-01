"""SGLang's PROMPT_FORMAT_VERSION 1 fixtures (test_serving_decisions.py at 99c9d65), against this port.

    python3 test_render.py
"""

import json

from server import render_question

TEXT = json.dumps({"ticket": "Refund please", "tags": ["billing"]}, separators=(",", ":"))


def lines(text, *rest):
    return "\n".join([text, "", *rest])


def test_decisions_fixtures():
    assert render_question(
        TEXT, "choice", {"question": "Which team?"}, ["A", "B", "C"], ["billing", "sales", "other"], ["Payments", None, {"k": 1}]
    ) == lines(TEXT, 'Question: {"question":"Which team?"}', "A: billing - Payments", "B: sales", 'C: other - {"k":1}', "Answer with the letter of one option only.")
    assert render_question(TEXT, "score", "Mood?", ["0", "1"], ["0", "1"], ["Calm", "Angry"]) == lines(
        TEXT, "Question: Mood?", "0: Calm", "1: Angry", "Answer with the number of one level only."
    )
    assert render_question(TEXT, "yes_no", "Urgent", ["yes", "no"], ["yes", "no"], [None, "Can wait"]) == lines(
        TEXT, "Is the following true? Urgent", "no: Can wait", "Answer with yes or no only."
    )


def test_systemone_fixtures():
    assert render_question("s", "choice", None, ["AA", "AB"], ["billing", "sales"], ["Payments", None]) == lines(
        "s", "AA: billing - Payments", "AB: sales", "Answer with the letter of one option only."
    )
    assert render_question("s", "score", None, ["0", "1"], ["0", "1"], ["Calm", "Angry"]) == lines(
        "s", "0: Calm", "1: Angry", "Answer with the number of one level only."
    )
    assert render_question("s", "yes_no", None, ["yes", "no"], ["yes", "no"], ["Reply today", "Can wait"]) == lines(
        "s", "Is the following true?", "yes: Reply today", "no: Can wait", "Answer with yes or no only."
    )


if __name__ == "__main__":
    test_decisions_fixtures()
    test_systemone_fixtures()
    print("SGLang prompt fixtures match")
