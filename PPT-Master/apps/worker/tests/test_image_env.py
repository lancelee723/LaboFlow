"""Tests for build_image_env."""
import pytest
import pptmaster.db.session as _db_session_module

from pptmaster.agent.image_env import build_image_env
from pptmaster.db.models import ImageBackendConfig, ImageSearchConfig
from pptmaster.db.session import open_db_session


@pytest.fixture(autouse=True)
async def reset_db_engine():
    """Dispose and reset the engine singleton between tests to avoid asyncpg
    'Future attached to a different loop' errors when each test runs in its
    own event loop (pytest-asyncio function scope)."""
    if _db_session_module._engine is not None:
        await _db_session_module._engine.dispose()
    _db_session_module._engine = None
    _db_session_module._factory = None
    yield
    if _db_session_module._engine is not None:
        await _db_session_module._engine.dispose()
    _db_session_module._engine = None
    _db_session_module._factory = None


@pytest.mark.asyncio
async def test_empty_when_no_config(clean_image_backend_configs, clean_image_search_configs):
    env = await build_image_env()
    assert env == {}


@pytest.mark.asyncio
async def test_includes_default_backend(clean_image_backend_configs, clean_image_search_configs):
    async with open_db_session() as s:
        s.add(ImageBackendConfig(
            backend="gemini",
            api_key_encrypted=b"sk-gem",
            is_default=True,
        ))
        await s.commit()
    env = await build_image_env()
    assert env["IMAGE_BACKEND"] == "gemini"
    assert env["GEMINI_API_KEY"] == "sk-gem"


@pytest.mark.asyncio
async def test_includes_model_and_base_url_when_set(clean_image_backend_configs, clean_image_search_configs):
    async with open_db_session() as s:
        s.add(ImageBackendConfig(
            backend="openai",
            api_key_encrypted=b"sk-oai",
            model="gpt-image-2",
            base_url="https://proxy.example.com/v1",
            is_default=True,
        ))
        await s.commit()
    env = await build_image_env()
    assert env["OPENAI_MODEL"] == "gpt-image-2"
    assert env["OPENAI_BASE_URL"] == "https://proxy.example.com/v1"


@pytest.mark.asyncio
async def test_includes_search_providers(clean_image_backend_configs, clean_image_search_configs):
    async with open_db_session() as s:
        s.add(ImageSearchConfig(provider="pexels", api_key_encrypted=b"pxk"))
        s.add(ImageSearchConfig(provider="pixabay", api_key_encrypted=b"pbk"))
        await s.commit()
    env = await build_image_env()
    assert env["PEXELS_API_KEY"] == "pxk"
    assert env["PIXABAY_API_KEY"] == "pbk"
