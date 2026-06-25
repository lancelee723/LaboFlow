"""add image_backend_configs and image_search_configs

Support user-configurable AI image-generation backends (Gemini/OpenAI/Zhipu/…)
and web image-search provider credentials (Pexels/Pixabay) at the system level.

Revision ID: f1a2b3c4d5e6
Revises: e1f2a3b4c5d6
Create Date: 2026-06-07

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "f1a2b3c4d5e6"
down_revision: str | None = "e1f2a3b4c5d6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "image_backend_configs",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("created_by", sa.String(), sa.ForeignKey("pptmaster.users.id", ondelete="SET NULL"), index=True),
        sa.Column("backend", sa.String(), nullable=False),
        sa.Column("model", sa.String(), nullable=True),
        sa.Column("api_key_encrypted", sa.LargeBinary(), nullable=False),
        sa.Column("base_url", sa.Text(), nullable=True),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("display_name", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        schema="pptmaster",
    )
    # Partial unique index — at most one is_default=true row across the table.
    # Uses raw SQL because Alembic's op.create_index() does not expose the
    # WHERE clause needed for a partial index.
    op.execute(
        "CREATE UNIQUE INDEX ix_image_backend_configs_default_unique "
        "ON pptmaster.image_backend_configs (is_default) "
        "WHERE is_default = true"
    )

    op.create_table(
        "image_search_configs",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("created_by", sa.String(), sa.ForeignKey("pptmaster.users.id", ondelete="SET NULL"), index=True),
        sa.Column("provider", sa.String(), nullable=False),
        sa.Column("api_key_encrypted", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("provider", name="uq_image_search_configs_provider"),
        schema="pptmaster",
    )


def downgrade() -> None:
    op.drop_table("image_search_configs", schema="pptmaster")
    op.execute("DROP INDEX IF EXISTS pptmaster.ix_image_backend_configs_default_unique")
    op.drop_table("image_backend_configs", schema="pptmaster")
