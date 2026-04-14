#!/bin/bash
set -e

if [ "$(id -u)" = '0' ]; then
    echo "[entrypoint] Detected root user, fixing permissions..."
    chown -R clawith:clawith ${AGENT_DATA_DIR:-/data/agents}
    echo "[entrypoint] Dropping privileges to 'clawith' and re-executing..."
    exec gosu clawith /bin/bash "$0" "$@"
fi

echo "[entrypoint] Step 1: Creating/verifying database tables..."

python << 'PYEOF'
import asyncio, sys

async def main():
    from app.database import Base, engine
    import app.models.user
    import app.models.agent
    import app.models.task
    import app.models.llm
    import app.models.tool
    import app.models.audit
    import app.models.skill
    import app.models.channel_config
    import app.models.schedule
    import app.models.plaza
    import app.models.activity_log
    import app.models.org
    import app.models.system_settings
    import app.models.invitation_code
    import app.models.tenant
    import app.models.participant
    import app.models.chat_session
    import app.models.trigger
    import app.models.notification
    import app.models.gateway_message

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    print("[entrypoint] Tables created/verified")

    patches = [
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS quota_message_limit INTEGER DEFAULT 50",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS quota_message_period VARCHAR(20) DEFAULT 'permanent'",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS quota_messages_used INTEGER DEFAULT 0",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS quota_period_start TIMESTAMPTZ",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS quota_max_agents INTEGER DEFAULT 2",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS quota_agent_ttl_hours INTEGER DEFAULT 48",
        "ALTER TABLE agents ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ",
        "ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_expired BOOLEAN DEFAULT FALSE",
        "ALTER TABLE agents ADD COLUMN IF NOT EXISTS llm_calls_today INTEGER DEFAULT 0",
        "ALTER TABLE agents ADD COLUMN IF NOT EXISTS max_llm_calls_per_day INTEGER DEFAULT 100",
        "ALTER TABLE agents ADD COLUMN IF NOT EXISTS llm_calls_reset_at TIMESTAMPTZ",
        "ALTER TABLE agent_tools ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'system'",
        "ALTER TABLE agent_tools ADD COLUMN IF NOT EXISTS installed_by_agent_id UUID",
        "ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS source_channel VARCHAR(20) NOT NULL DEFAULT 'web'",
        "ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_daily_reset TIMESTAMPTZ",
        "ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_monthly_reset TIMESTAMPTZ",
        "ALTER TABLE agents ADD COLUMN IF NOT EXISTS tokens_used_total INTEGER DEFAULT 0",
        "ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_type VARCHAR(20) NOT NULL DEFAULT 'native'",
        "ALTER TABLE agents ADD COLUMN IF NOT EXISTS api_key_hash VARCHAR(128)",
        "ALTER TABLE agents ADD COLUMN IF NOT EXISTS openclaw_last_seen TIMESTAMPTZ",
        "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS sso_enabled BOOLEAN DEFAULT FALSE",
        "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS sso_domain VARCHAR(255)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_tenants_sso_domain ON tenants(sso_domain) WHERE sso_domain IS NOT NULL",
    ]

    from sqlalchemy import text
    async with engine.begin() as conn:
        for sql in patches:
            try:
                await conn.execute(text(sql))
            except Exception as e:
                print(f"[entrypoint] Patch skipped ({e})")

    await engine.dispose()
    print("[entrypoint] Column patches applied")

asyncio.run(main())
PYEOF

echo "[entrypoint] Step 2: Running alembic migrations..."
set +e
ALEMBIC_OUTPUT=$(alembic upgrade head 2>&1)
ALEMBIC_EXIT=$?
set -e

if [ $ALEMBIC_EXIT -ne 0 ]; then
    echo "[entrypoint] WARNING: Alembic migration FAILED (exit code $ALEMBIC_EXIT)"
    echo "$ALEMBIC_OUTPUT"
    echo "[entrypoint] Continuing startup despite migration failure..."
else
    echo "[entrypoint] Alembic migrations completed successfully."
fi

echo "[entrypoint] Step 3: Starting uvicorn..."
exec uvicorn app.main:app --host 0.0.0.0 --port 8000
