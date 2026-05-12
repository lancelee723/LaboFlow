"""Merge alembic heads: add_user_tenant_onboarding + ff5c0ddf5d13

Revision ID: merge_heads_user_onboarding_bridge
Revises: add_user_tenant_onboarding, ff5c0ddf5d13
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "merge_heads_user_onboarding_bridge"
down_revision: Union[str, Sequence[str], None] = ("add_user_tenant_onboarding", "ff5c0ddf5d13")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
