"""Application configuration loaded from environment."""

from functools import lru_cache
from pathlib import Path as _Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Deployment
    deployment_mode: str = "standalone"
    path_prefix: str = ""

    # Auth
    jwt_secret_key: str = "dev-not-secure-change-in-production-min-32-chars"
    jwt_algorithm: str = "HS256"
    jwt_exp_minutes: int = 1440
    pptmaster_sso_audience: str = Field(
        default="ppt-master",
        alias="PPTMASTER_SSO_AUDIENCE",
    )
    system_aes_key: str = "dev-32-bytes-aes-key-for-local-dev!"

    # Database
    database_url: str = "postgresql+asyncpg://pptmaster:pptmaster_dev@localhost:5992/pptmaster"
    database_schema: str = "pptmaster"

    # Storage
    storage_backend: str = "volume"  # volume | s3
    storage_root: str = "/data"
    storage_s3_bucket: str = ""
    storage_s3_endpoint: str = ""

    # Services
    pptmaster_converter_url: str = "http://localhost:5993"
    public_base_url: str = "http://localhost:3009"

    # Initial admin (standalone only)
    initial_admin_email: str = "admin@local.dev"
    initial_admin_password: str = "123456"

    # Sentry (optional)
    sentry_dsn: str = Field(default="", alias="SENTRY_DSN")

    # LLM defaults (optional)
    anthropic_api_key: str = ""
    openai_api_key: str = ""

    # Built-in template source (path to ppt-master skill repo's templates/ dir).
    # Empty = skip built-in template sync at bootstrap.
    skill_templates_root: str = Field(
        default="",
        alias="PPTMASTER_SKILL_TEMPLATES_ROOT",
    )

    # Path to PPT-Master's scripts directory (for subprocess calls).
    pptmaster_scripts_dir: str = Field(
        default="/opt/pptmaster-skill/scripts",
        alias="PPTMASTER_SCRIPTS_DIR",
    )

    # Path to PPT-Master's templates directory.
    pptmaster_templates_dir: str = Field(
        default="/opt/pptmaster-skill/templates",
        alias="PPTMASTER_TEMPLATES_DIR",
    )

    @property
    def pptmaster_references_dir(self) -> str:
        """References directory is a sibling of pptmaster_scripts_dir."""
        return str(_Path(self.pptmaster_scripts_dir).parent / "references")


@lru_cache
def get_settings() -> Settings:
    return Settings()
