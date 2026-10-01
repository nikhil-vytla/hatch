"""Export a fitted TF-IDF + logistic-regression classifier for the browser runtime.

Generic: it takes any fitted vectorizer and model. (The teaching and reward experiments that
used it trained on Jev's outputs and were removed on 1 Oct 2026; TypeSafe's Master Customer
Agreement §2.3(b) forbids training a model to imitate Jev.)
"""


def exported(vectorizer, model):
    return {
        "kind": "tfidf-logistic",
        "vocabulary": vectorizer.vocabulary_,
        "idf": vectorizer.idf_.tolist(),
        "classes": model.classes_.tolist(),
        "weights": model.coef_.tolist(),
        "bias": model.intercept_.tolist(),
        "tokenizer": "lowercase Unicode words with at least two characters; word unigrams and bigrams; sublinear TF; L2 normalization",
    }
