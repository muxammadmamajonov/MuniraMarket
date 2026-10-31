"""Invisible and direction-changing characters in names and descriptions.

A product, category or zone name is shown to customers, operators and in Telegram messages. Unicode
*format* characters (category ``Cf``: bidi overrides/isolates such as U+202E, zero-width spaces and
joiners such as U+200B, the byte-order mark U+FEFF, the soft hyphen, ...) render as nothing but
change how the text around them is displayed or compared, so two names can look identical while
differing, or text can appear reversed. None of them belongs in a catalog name, so they are
refused everywhere names are written (JSON API and CSV import). Descriptions keep their newlines
and tabs but refuse the same characters.

Lone surrogates (``Cs``) cannot be stored as UTF-8, and single-line text also refuses the Unicode
line/paragraph separators (``Zl``/``Zp``) and the few invisible "filler" letters that have no
other use than looking blank.
"""

import unicodedata
from typing import Final

_REFUSED_CATEGORIES: Final = frozenset({"Cf", "Cs"})
_REFUSED_SINGLE_LINE_CATEGORIES: Final = frozenset({"Zl", "Zp"})
# Letters/marks that display as blank (Hangul fillers, combining grapheme joiner, Khmer inherent
# vowels, halfwidth Hangul filler).
_INVISIBLE_FILLERS: Final = frozenset("͏ᅟᅠ឴឵ㅤﾠ")

INVISIBLE_TEXT_MESSAGE: Final = (
    "must not contain invisible or text-direction characters (e.g. U+200B, U+202E, U+FEFF)"
)


def has_invisible_characters(value: str, *, multiline: bool = False) -> bool:
    """Whether ``value`` contains a character refused in names (``multiline``: descriptions)."""
    for character in value:
        if character in _INVISIBLE_FILLERS:
            return True
        category = unicodedata.category(character)
        if category in _REFUSED_CATEGORIES:
            return True
        if not multiline and category in _REFUSED_SINGLE_LINE_CATEGORIES:
            return True
    return False
