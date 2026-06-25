"""drop organizations and org_members

The product is locked as single-user (Sprint 1 F-track). The `organizations`
and `org_members` tables have not been queried by application code since that
migration; only `bootstrap.py` was still creating a placeholder default
organization. This migration removes the dead scaffolding.

Revision ID: a1b2c3d4e5f6
Revises: f1a2b3c4d5e6
Create Date: 2026-06-08

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "a1b2c3d4e5f6"
down_revision: str | None = "f1a2b3c4d5e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # org_members has FKs to both organizations and users; drop first.
    op.drop_table("org_members", schema="pptmaster")
    op.drop_table("organizations", schema="pptmaster")


def downgrade() -> None:
    op.create_table(
        "organizations",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("external_id", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("external_id"),
        schema="pptmaster",
    )
    op.create_table(
        "org_members",
        sa.Column("org_id", sa.String(), sa.ForeignKey("pptmaster.organizations.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", sa.String(), sa.ForeignKey("pptmaster.users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("role", sa.String(), nullable=False),
        sa.Column("joined_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        schema="pptmaster",
    )
