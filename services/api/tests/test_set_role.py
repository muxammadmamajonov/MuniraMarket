"""The dev role tool: argument parsing, and ``--create`` against a real database."""

import pytest

from app.dev.set_role import parse_args, set_role
from app.models.enums import UserRole
from app.repositories.users import SqlAlchemyUserRepository, TelegramProfile
from tests.db_data import SessionFactory

pytest_plugins = ["tests.db_fixtures"]  # the session_factory fixture (integration test only)


def test_parses_id_and_role() -> None:
    assert parse_args(["123456789", "operator"]) == (123456789, UserRole.OPERATOR, False)


def test_parses_create_flag_anywhere() -> None:
    assert parse_args(["--create", "42", "admin"]) == (42, UserRole.ADMIN, True)
    assert parse_args(["42", "admin", "--create"]) == (42, UserRole.ADMIN, True)


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
        ["--create"],
    ],
)
def test_rejects_bad_arguments(argv: list[str]) -> None:
    with pytest.raises(ValueError, match="usage"):
        parse_args(argv)


@pytest.mark.integration
@pytest.mark.asyncio(loop_scope="module")
async def test_create_flag_makes_a_placeholder_user_whose_role_survives_sign_in(
    session_factory: SessionFactory,
) -> None:
    assert not await set_role(session_factory, 777_000_001, UserRole.ADMIN)
    assert await set_role(session_factory, 777_000_001, UserRole.ADMIN, create=True)
    # Running it again (user exists) only sets the role.
    assert await set_role(session_factory, 777_000_001, UserRole.ADMIN, create=True)

    async with session_factory() as session:
        signed_in = await SqlAlchemyUserRepository(session).upsert_from_telegram(
            TelegramProfile(
                telegram_user_id=777_000_001,
                first_name="Demo",
                last_name=None,
                username=None,
                language_code="uz",
            )
        )
    assert signed_in.role is UserRole.ADMIN
    assert signed_in.first_name == "Demo"
