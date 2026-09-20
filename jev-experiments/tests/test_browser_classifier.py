"""Cross-runtime parity against sklearn, including Unicode and repeated tokens."""

import json
import shutil
import subprocess

import numpy as np
import pytest
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression

from jev_lab.core import ROOT
from jev_lab.teach import exported


@pytest.mark.skipif(shutil.which("bun") is None, reason="Bun is needed for browser parity")
def test_browser_predict_matches_sklearn():
    train = [
        "hot tea café",
        "warm tea please",
        "tea no milk",
        "iced coffee cream",
        "cold coffee milk",
        "coffee café sugar",
        "cold fruit juice",
        "fresh orange juice",
        "juice no café",
    ]
    labels = ["tea"] * 3 + ["coffee"] * 3 + ["juice"] * 3
    texts = ["tea tea café", "COFFEE milk", "cold orange juice", "unknown", "", "café café crème"]
    vectorizer = TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True)
    model = LogisticRegression(C=4).fit(vectorizer.fit_transform(train), labels)
    result = subprocess.run(
        ["bun", str(ROOT / "tests/predict-browser.ts")],
        input=json.dumps({"model": exported(vectorizer, model), "texts": texts}),
        text=True,
        capture_output=True,
        check=True,
    )
    actual = np.array(
        [[row[label] for label in model.classes_] for row in json.loads(result.stdout)]
    )
    np.testing.assert_allclose(actual, model.predict_proba(vectorizer.transform(texts)), atol=1e-12)
