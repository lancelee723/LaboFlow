"""Add bridge_mode column to agents for local-agent bridge integration.

Revision ID: add_bridge_mode
Revises: f1a2b3c4d5e6
Create Date: 2026-04-21
"""
from alembic import op


revision = "add_bridge_mode"
down_revision = "f1a2b3c4d5e6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE agents ADD COLUMN IF NOT EXISTS bridge_mode "
        "VARCHAR(16) NOT NULL DEFAULT 'disabled'"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE agents DROP COLUMN IF EXISTS bridge_mode")
