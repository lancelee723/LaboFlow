"""Alembic environment configuration for async SQLAlchemy."""

import asyncio
import logging
from logging.config import fileConfig

from alembic import context
from alembic.script import ScriptDirectory
from sqlalchemy import inspect, pool
from sqlalchemy.ext.asyncio import async_engine_from_config

from app.database import Base
from app.config import get_settings

logger = logging.getLogger("alembic.bootstrap")

# Import all models so they are registered with Base.metadata
from app.models.identity import IdentityProvider, SSOScanSession  # noqa: F401
from app.models.user import User  # noqa: F401
from app.models.agent import Agent, AgentPermission, AgentTemplate  # noqa: F401
from app.models.task import Task, TaskLog  # noqa: F401
from app.models.channel_config import ChannelConfig  # noqa: F401
from app.models.llm import LLMModel  # noqa: F401
from app.models.audit import AuditLog, ApprovalRequest, ChatMessage, EnterpriseInfo  # noqa: F401
from app.models.skill import Skill, SkillFile  # noqa: F401
from app.models.chat_session import ChatSession  # noqa: F401
from app.models.participant import Participant  # noqa: F401
from app.models.activity_log import AgentActivityLog  # noqa: F401
from app.models.invitation_code import InvitationCode  # noqa: F401
from app.models.org import OrgDepartment, OrgMember, AgentRelationship, AgentAgentRelationship  # noqa: F401
from app.models.plaza import PlazaPost, PlazaComment, PlazaLike  # noqa: F401
from app.models.schedule import AgentSchedule  # noqa: F401
from app.models.system_settings import SystemSetting  # noqa: F401
from app.models.tenant import Tenant  # noqa: F401
from app.models.tool import Tool  # noqa: F401
from app.models.trigger import AgentTrigger  # noqa: F401
from app.models.agent_credential import AgentCredential  # noqa: F401
from app.models.onboarding import UserTenantOnboarding  # noqa: F401

config = context.config
settings = get_settings()

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata

config.set_main_option("sqlalchemy.url", settings.DATABASE_URL)


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection):
    """Bootstrap path-aware migration runner.

    Two distinct flows depending on whether the DB has ever been touched
    by Clawith before. We detect this by the presence of `alembic_version`:

    1. **Fresh DB** (table absent): build the entire current schema in one
       shot via ``Base.metadata.create_all`` and stamp ``alembic_version``
       to the current head(s). Skips the migration chain entirely.

       Rationale: we accumulated 60+ migrations over time and *each* is a
       potential failure point for a fresh deploy. One transactional
       CREATE-from-models is strictly faster and strictly safer — no
       chain of long-named merge revisions risking VARCHAR(32) overflow,
       no batched rollback wiping prior steps' DDL on a mid-chain crash,
       no historical data backfills (irrelevant for empty tables anyway).

       Source of truth: the models imported above into ``target_metadata``.
       This is exactly what ``alembic autogenerate`` already trusts, so
       if the models drift from migrations the project has bigger problems.

    2. **Existing DB** (table present): traditional migration path, with
       two safety nets bolted on:
       a. Widen ``alembic_version.version_num`` proactively to absorb
          long descriptive revision ids (defaults to VARCHAR(32) which
          we've already overflowed once).
       b. ``transaction_per_migration=True`` so a failure in step N
          doesn't roll back steps 1..N-1 — leaving a stuck-mid-chain
          DB instead of an invisible "DDL gone, alembic_version reset"
          ghost state that's painful to diagnose.
    """
    inspector = inspect(connection)
    is_fresh = not inspector.has_table("alembic_version")

    if is_fresh:
        logger.info("[alembic] Fresh DB detected — bootstrapping via Base.metadata.create_all()")
        Base.metadata.create_all(connection)

        # Create alembic_version with the right width upfront so future
        # upgrades never trip on the VARCHAR(32) default. Stamp it to
        # the current head(s) of the migration tree so subsequent runs
        # treat this DB as "already at latest" and use the upgrade path.
        connection.exec_driver_sql(
            "CREATE TABLE alembic_version ("
            "version_num VARCHAR(255) NOT NULL, "
            "CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num))"
        )
        script = ScriptDirectory.from_config(context.config)
        heads = script.get_heads()
        for head in heads:
            connection.exec_driver_sql(
                "INSERT INTO alembic_version (version_num) VALUES (:v)",
                {"v": head},
            )
        logger.info(f"[alembic] Stamped alembic_version to head(s): {heads}")
        return

    # Existing DB: safety nets + traditional migration chain.
    connection.exec_driver_sql(
        "ALTER TABLE alembic_version ALTER COLUMN version_num TYPE VARCHAR(255)"
    )
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        transaction_per_migration=True,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    """Run migrations in 'online' mode with async engine."""
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode."""
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
