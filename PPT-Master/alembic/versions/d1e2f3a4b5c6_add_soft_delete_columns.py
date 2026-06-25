"""add_soft_delete_columns

Revision ID: d1e2f3a4b5c6
Revises: c7d8e9f0a1b2
Create Date: 2026-06-06

Track D — Data lifecycle: soft delete + 30-day prune.

Adds two columns to pptmaster.projects:
  - soft_deleted_at: timestamp when DELETE was called (NULL = not deleted)
  - soft_deleted_by: user_id who issued the delete

An index on soft_deleted_at supports both the default-query exclusion
filter and the prune CLI's cutoff scan.

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d1e2f3a4b5c6"
down_revision: Union[str, None] = "c7d8e9f0a1b2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column("soft_deleted_at", sa.DateTime(timezone=True), nullable=True),
        schema="pptmaster",
    )
    op.add_column(
        "projects",
        sa.Column("soft_deleted_by", sa.String(), nullable=True),
        schema="pptmaster",
    )
    op.create_index(
        "ix_projects_soft_deleted_at",
        "projects",
        ["soft_deleted_at"],
        schema="pptmaster",
    )


def downgrade() -> None:
    op.drop_index("ix_projects_soft_deleted_at", table_name="projects", schema="pptmaster")
    op.drop_column("projects", "soft_deleted_by", schema="pptmaster")
    op.drop_column("projects", "soft_deleted_at", schema="pptmaster")
