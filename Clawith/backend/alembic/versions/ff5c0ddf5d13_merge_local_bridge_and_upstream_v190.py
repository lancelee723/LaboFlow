"""merge_local_bridge_and_upstream_v190

Revision ID: ff5c0ddf5d13
Revises: add_agent_api_key, rm_agent_credential_secrets
Create Date: 2026-04-29 23:39:13.049462
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'ff5c0ddf5d13'
down_revision: Union[str, None] = ('add_agent_api_key', 'rm_agent_credential_secrets')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
