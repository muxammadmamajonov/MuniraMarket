"""FastAPI dependencies. Shared state lives on ``app.state`` and is built in ``create_app``."""

from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.repositories.users import SqlAlchemyUserRepository, UserRepository
from app.security.service_auth import ServiceContext, require_service_request
from app.telegram.identity import TelegramIdentityVerifier


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    factory: async_sessionmaker[AsyncSession] = request.app.state.session_factory
    async with factory() as session:
        yield session


def get_user_repository(
    session: Annotated[AsyncSession, Depends(get_session)],
) -> UserRepository:
    return SqlAlchemyUserRepository(session)


def get_identity_verifier(request: Request) -> TelegramIdentityVerifier:
    verifier: TelegramIdentityVerifier = request.app.state.identity_verifier
    return verifier


async def require_actor(
    context: Annotated[ServiceContext, Depends(require_service_request)],
) -> int:
    """Signed request that acts on behalf of a Telegram user; returns that user's id."""
    if context.actor_telegram_user_id is None:
        raise HTTPException(status_code=403, detail="Actor required")
    return context.actor_telegram_user_id


UserRepositoryDep = Annotated[UserRepository, Depends(get_user_repository)]
SessionDep = Annotated[AsyncSession, Depends(get_session)]
