"""Add Session.generate_notes column.

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e7f8
Create Date: 2026-06-28
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "b2c3d4e5f6a7"
down_revision: str | None = "a1b2c3d4e7f8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column(
            "generate_notes",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
        schema="pptmaster",
    )


def downgrade() -> None:
    op.drop_column("sessions", "generate_notes", schema="pptmaster")
