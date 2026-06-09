"""Build subprocess environment variables for image_gen.py / image_search.py.

Reads system-level configuration from image_backend_configs +
image_search_configs and produces a dict suitable for passing as
`extra_env` to `run_script`.

Returns {} when nothing is configured — Step 5 callers should treat this
as "no AI backend → degrade to placeholder" rather than an error.
"""

from sqlalchemy import select

from pptmaster.db.models import ImageBackendConfig, ImageSearchConfig
from pptmaster.db.session import open_db_session


async def build_image_env() -> dict[str, str]:
    env: dict[str, str] = {}

    async with open_db_session() as session:
        backend_cfg = (await session.execute(
            select(ImageBackendConfig).where(ImageBackendConfig.is_default == True)
        )).scalar_one_or_none()

        if backend_cfg:
            env["IMAGE_BACKEND"] = backend_cfg.backend
            upper = backend_cfg.backend.upper()
            env[f"{upper}_API_KEY"] = backend_cfg.api_key_encrypted.decode("utf-8")
            if backend_cfg.model:
                env[f"{upper}_MODEL"] = backend_cfg.model
            if backend_cfg.base_url:
                env[f"{upper}_BASE_URL"] = backend_cfg.base_url

        search_cfgs = (await session.execute(select(ImageSearchConfig))).scalars().all()
        for cfg in search_cfgs:
            env[f"{cfg.provider.upper()}_API_KEY"] = cfg.api_key_encrypted.decode("utf-8")

    return env
