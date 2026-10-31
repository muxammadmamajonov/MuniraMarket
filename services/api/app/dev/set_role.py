"""Grant a role to an existing user for local back-office testing.

``python -m app.dev.set_role <telegram_user_id> <customer|operator|admin>``

Refuses unless ``APP_ENV`` is ``development`` or ``test`` (the same guard as the seed). The user
must already exist, i.e. have signed in once. Granting staff roles in shared environments is an
operator procedure outside this repository.
"""

import asyncio
import sys

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import get_settings
from app.db.session import create_engine, create_session_factory
from app.dev.seed import SeedRefusedError, ensure_safe_environment
from app.models.enums import UserRole
from app.models.user import User

USAGE = "usage: python -m app.dev.set_role <telegram_user_id> <customer|operator|admin>\n"


def parse_args(argv: list[str]) -> tuple[int, UserRole]:
    if len(argv) != 2:
        raise ValueError(USAGE)
    try:
        telegram_user_id = int(argv[0])
        role = UserRole(argv[1])
    except ValueError:
        raise ValueError(USAGE) from None
    if telegram_user_id <= 0:
        raise ValueError(USAGE)
    return telegram_user_id, role


async def set_role(
    session_factory: async_sessionmaker[AsyncSession], telegram_user_id: int, role: UserRole
) -> bool:
    """Returns ``False`` when no user has that Telegram id."""
    async with session_factory() as session:
        result = await session.execute(
            update(User).where(User.telegram_user_id == telegram_user_id).values(role=role)
        )
        await session.commit()
    return bool(result.rowcount)  # type: ignore[attr-defined]


async def main(argv: list[str]) -> int:
    settings = get_settings()
    try:
        ensure_safe_environment(settings.app_env)
        telegram_user_id, role = parse_args(argv)
    except (SeedRefusedError, ValueError) as exc:
        sys.stderr.write(f"{exc}\n")
        return 2

    engine = create_engine(settings)
    try:
        found = await set_role(create_session_factory(engine), telegram_user_id, role)
    finally:
        await engine.dispose()
    if not found:
        sys.stderr.write("no user with that Telegram id (sign in once first)\n")
        return 1
    sys.stdout.write(f"role set to {role.value}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(sys.argv[1:])))
