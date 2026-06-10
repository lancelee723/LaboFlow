"""add_user_locale

Revision ID: e1f2a3b4c5d6
Revises: d1e2f3a4b5c6
Create Date: 2026-06-06

G4 — i18n: Add locale column to pptmaster.users (VARCHAR(2), default "en").
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "e1f2a3b4c5d6"
down_revision: str | None = "d1e2f3a4b5c6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("locale", sa.String(2), nullable=False, server_default="en"),
        schema="pptmaster",
    )


def downgrade() -> None:
    op.drop_column("users", "locale", schema="pptmaster")
