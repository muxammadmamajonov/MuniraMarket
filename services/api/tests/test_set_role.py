"""The dev role tool's argument parsing (no database needed)."""

import pytest

from app.dev.set_role import parse_args
from app.models.enums import UserRole


def test_parses_id_and_role() -> None:
    assert parse_args(["123456789", "operator"]) == (123456789, UserRole.OPERATOR)


@pytest.mark.parametrize(
    "argv",
    [
        [],
        ["1"],
        ["x", "admin"],
        ["0", "admin"],
        ["-5", "admin"],
        ["1", "root"],
        ["1", "admin", "x"],
    ],
)
def test_rejects_bad_arguments(argv: list[str]) -> None:
    with pytest.raises(ValueError, match="usage"):
        parse_args(argv)
