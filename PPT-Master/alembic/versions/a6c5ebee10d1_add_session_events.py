"""add_session_events

Revision ID: a6c5ebee10d1
Revises: 0001
Create Date: 2026-06-03 00:11:46.044767

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'a6c5ebee10d1'
down_revision: Union[str, None] = '0001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "session_events",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("session_id", sa.String(length=36),
                  sa.ForeignKey("pptmaster.sessions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("event_type", sa.Text, nullable=False),
        sa.Column("payload", postgresql.JSONB, nullable=False),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True),
                  server_default=sa.text("NOW()"), nullable=False),
        schema="pptmaster",
    )
    op.create_index(
        "ix_session_events_session_created",
        "session_events", ["session_id", "created_at"],
        schema="pptmaster",
    )


def downgrade() -> None:
    op.drop_index("ix_session_events_session_created", "session_events", schema="pptmaster")
    op.drop_table("session_events", schema="pptmaster")
