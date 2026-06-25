"""Database session management."""

from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from pptmaster.config import get_settings

_engine = None
_factory = None


def get_engine():
    global _engine
    if _engine is None:
        _engine = create_async_engine(get_settings().database_url, echo=False, pool_size=10, max_overflow=20)
    return _engine


def get_async_session_factory():
    global _factory
    if _factory is None:
        _factory = async_sessionmaker(get_engine(), class_=AsyncSession, expire_on_commit=False)
    return _factory


async def get_db_session() -> AsyncGenerator[AsyncSession, None]:
    factory = get_async_session_factory()
    async with factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


@asynccontextmanager
async def open_db_session() -> AsyncIterator[AsyncSession]:
    """Async context-manager for DB sessions in background tasks and non-FastAPI code.

    Usage::

        async with open_db_session() as db:
            ...

    For FastAPI endpoint signatures, use ``Depends(get_db_session)`` instead.
    """
    factory = get_async_session_factory()
    async with factory() as session:
        yield session
