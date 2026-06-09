"""Tests for ImageBackendConfig and ImageSearchConfig models."""
import pytest
from sqlalchemy.exc import IntegrityError

from pptmaster.db.models import ImageBackendConfig, ImageSearchConfig
from pptmaster.db.session import open_db_session
import pptmaster.db.session as _db_session_module


@pytest.fixture(autouse=True)
async def reset_db_engine():
    """Dispose and reset the engine singleton between tests to avoid asyncpg
    'Future attached to a different loop' errors when each test runs in its
    own event loop (pytest-asyncio function scope)."""
    # Reset before the test so this test gets a fresh engine on its own loop.
    if _db_session_module._engine is not None:
        await _db_session_module._engine.dispose()
    _db_session_module._engine = None
    _db_session_module._factory = None
    yield
    # Dispose after the test to release pool connections cleanly.
    if _db_session_module._engine is not None:
        await _db_session_module._engine.dispose()
    _db_session_module._engine = None
    _db_session_module._factory = None


@pytest.mark.asyncio
async def test_image_backend_config_round_trip():
    async with open_db_session() as session:
        cfg = ImageBackendConfig(
            backend="gemini",
            api_key_encrypted=b"secret-key",
            display_name="Gemini default",
        )
        session.add(cfg)
        await session.commit()
        await session.refresh(cfg)
        assert cfg.id is not None
        assert cfg.backend == "gemini"
        assert cfg.is_default is False
        # cleanup
        await session.delete(cfg)
        await session.commit()


@pytest.mark.asyncio
async def test_image_search_config_provider_unique():
    async with open_db_session() as session:
        a = ImageSearchConfig(provider="pexels", api_key_encrypted=b"k1")
        b = ImageSearchConfig(provider="pexels", api_key_encrypted=b"k2")
        session.add(a)
        session.add(b)
        with pytest.raises(IntegrityError):
            await session.commit()
        await session.rollback()
