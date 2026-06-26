"""add llm_config_id to sessions

Lets users pick a specific LLM for a single pipeline run from the project
setup page. When set, this overrides role_preference and is_default routing
in pptmaster.llm.provider.get_chat_model for that session only.

Revision ID: a1b2c3d4e7f8
Revises: f1a2b3c4d5e6
Create Date: 2026-06-25

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "a1b2c3d4e7f8"
down_revision: str | None = "a1b2c3d4e5f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column(
            "llm_config_id",
            sa.String(),
            sa.ForeignKey("pptmaster.llm_configs.id", ondelete="SET NULL"),
            nullable=True,
        ),
        schema="pptmaster",
    )


def downgrade() -> None:
    op.drop_column("sessions", "llm_config_id", schema="pptmaster")
