"""Text helpers for documents and file names."""

from __future__ import annotations

import re
import unicodedata
import warnings

__all__ = ["avatar_initials", "initials", "slugify", "truncate"]


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


def avatar_initials(name: str) -> str:
    """Up to two initials for an avatar, from the first and last words.

    >>> avatar_initials('Ada Lovelace')
    'AL'
    >>> avatar_initials('grace brewster murray hopper')
    'GH'
    >>> avatar_initials('Plato')
    'P'
    """
    words = name.split()
    if not words:
        return ""
    if len(words) == 1:
        return words[0][0].upper()
    return (words[0][0] + words[-1][0]).upper()


def initials(*args, **kwargs):
    """Deprecated: use `avatar_initials`."""
    warnings.warn("initials is deprecated; use avatar_initials", DeprecationWarning, stacklevel=2)
    return avatar_initials(*args, **kwargs)
