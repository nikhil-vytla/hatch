"""Text helpers for documents and file names."""

from __future__ import annotations

import re
import unicodedata

__all__ = ["initials", "slugify", "title_case", "truncate"]


def slugify(text: str) -> str:
    """A file-name-safe form of `text`: ASCII, lowercase, dashes.

    >>> slugify('Café Müller & Söhne GmbH')
    'cafe-muller-sohne-gmbh'
    >>> slugify('  Invoice #2024/017  ')
    'invoice-2024-017'
    """
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")


def truncate(text: str, width: int) -> str:
    """`text` cut to at most `width` characters, ending in an ellipsis when cut.

    >>> truncate('Consulting services, March', 15)
    'Consulting ser…'
    >>> truncate('Hosting', 15)
    'Hosting'
    """
    if len(text) <= width:
        return text
    return text[: width - 1] + "…"


def initials(name: str) -> str:
    """Up to two initials for an avatar, from the first and last words.

    >>> initials('Ada Lovelace')
    'AL'
    >>> initials('grace brewster murray hopper')
    'GH'
    >>> initials('Plato')
    'P'
    """
    words = name.split()
    if not words:
        return ""
    if len(words) == 1:
        return words[0][0].upper()
    return (words[0][0] + words[-1][0]).upper()


def title_case(s: str) -> str:
    """Each word capitalized, except small words after the first."""
    small = {"and", "of", "the"}
    words = s.split()
    return " ".join(w if i and w.lower() in small else w.capitalize() for i, w in enumerate(words))
