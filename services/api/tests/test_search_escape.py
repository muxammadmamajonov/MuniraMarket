import pytest

from app.repositories.catalog import escape_like


@pytest.mark.parametrize(
    ("raw", "escaped"),
    [
        ("milk", "milk"),
        ("100%", "100\\%"),
        ("a_b", "a\\_b"),
        ("back\\slash", "back\\\\slash"),
        ("%_\\", "\\%\\_\\\\"),
        ("Сүт", "Сүт"),
        ("", ""),
    ],
)
def test_escape_like(raw: str, escaped: str) -> None:
    assert escape_like(raw) == escaped


def test_backslash_is_escaped_first_so_escapes_are_not_doubled() -> None:
    # "%" must become exactly "\%", not "\\%".
    assert escape_like("%") == "\\%"
    assert escape_like("\\%") == "\\\\\\%"
