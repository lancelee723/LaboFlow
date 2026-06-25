"""add_status_locked_abort_reason

Revision ID: c7d8e9f0a1b2
Revises: b1e2f3a4c5d6
Create Date: 2026-06-06

Track B — Session lifecycle state machine.

Adds two columns to pptmaster.sessions:
  - status_locked: cached terminal status ("aborted" / "failed" / "completed")
    so _classify_status does not re-infer terminal state from runtime signals.
  - abort_reason: human-readable reason for aborted / failed sessions (shown
    in the FE error overlay).

Backfills existing rows using the linked project.status value:
  - sessions joined to projects where project.status = 'completed' → status_locked = 'completed'
  - sessions with ended_at set but project.status != 'completed'   → status_locked = 'aborted'
    (pre-B rows only have completed/aborted distinction; no failed rows exist yet)

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c7d8e9f0a1b2"
down_revision: Union[str, None] = "b1e2f3a4c5d6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── Add status_locked and abort_reason to sessions ───────────────────────
    op.add_column(
        "sessions",
        sa.Column("status_locked", sa.String(), nullable=True),
        schema="pptmaster",
    )
    op.add_column(
        "sessions",
        sa.Column("abort_reason", sa.String(), nullable=True),
        schema="pptmaster",
    )

    # ── Backfill: mark completed sessions ─────────────────────────────────────
    # completed_steps lives in LangGraph graph state (not the DB); use the
    # joined project.status = 'completed' as the authoritative signal instead.
    op.execute("""
        UPDATE pptmaster.sessions AS s
        SET status_locked = 'completed'
        FROM pptmaster.projects AS p
        WHERE s.project_id = p.id
          AND s.ended_at IS NOT NULL
          AND p.status = 'completed'
    """)

    # ── Backfill: mark all other ended sessions as aborted ───────────────────
    # Any row that ended but is not completed was either cancelled or lost;
    # treat as aborted for display purposes (no failed rows exist pre-Track B).
    op.execute("""
        UPDATE pptmaster.sessions
        SET status_locked = 'aborted'
        WHERE ended_at IS NOT NULL
          AND status_locked IS NULL
    """)


def downgrade() -> None:
    op.drop_column("sessions", "abort_reason", schema="pptmaster")
    op.drop_column("sessions", "status_locked", schema="pptmaster")
