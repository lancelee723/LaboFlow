"""drop_org_id

Revision ID: b1e2f3a4c5d6
Revises: a6c5ebee10d1
Create Date: 2026-06-06

Single-user model migration: drop org_id scoping columns from all tables
that used them for multi-tenant scoping. Organization and OrgMember tables
are kept as structural scaffolding. User.is_server_admin column added to
replace role-string-based admin detection.

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "b1e2f3a4c5d6"
down_revision: Union[str, None] = "a6c5ebee10d1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── users: add is_server_admin ──────────────────────────────────────────
    op.add_column(
        "users",
        sa.Column("is_server_admin", sa.Boolean(), nullable=False, server_default=sa.false()),
        schema="pptmaster",
    )

    # ── projects: drop org_id FK + indexes ──────────────────────────────────
    op.drop_index("ix_projects_org", table_name="projects", schema="pptmaster", if_exists=True)
    op.drop_index("ix_projects_org_updated", table_name="projects", schema="pptmaster", if_exists=True)

    # Drop FK constraint explicitly (Postgres names it deterministically)
    op.drop_constraint("projects_org_id_fkey", "projects", schema="pptmaster", type_="foreignkey")
    op.drop_column("projects", "org_id", schema="pptmaster")

    # Add a replacement composite index on owner_id + updated_at
    op.create_index(
        "ix_projects_owner_updated", "projects", ["owner_id", "updated_at"], schema="pptmaster"
    )

    # ── llm_configs: swap org_id FK for created_by ───────────────────────────
    op.drop_index("ix_llm_configs_org", table_name="llm_configs", schema="pptmaster", if_exists=True)
    op.drop_constraint("llm_configs_org_id_fkey", "llm_configs", schema="pptmaster", type_="foreignkey")
    op.drop_column("llm_configs", "org_id", schema="pptmaster")

    op.add_column(
        "llm_configs",
        sa.Column(
            "created_by",
            sa.String(),
            sa.ForeignKey("pptmaster.users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        schema="pptmaster",
    )
    op.create_index("ix_llm_configs_created_by", "llm_configs", ["created_by"], schema="pptmaster")

    # ── llm_usage: rename org_id → user_id ──────────────────────────────────
    op.drop_index("ix_llm_usage_org", table_name="llm_usage", schema="pptmaster", if_exists=True)
    op.drop_index("ix_llm_usage_org_created", table_name="llm_usage", schema="pptmaster", if_exists=True)
    op.alter_column("llm_usage", "org_id", new_column_name="user_id", schema="pptmaster")
    op.create_index("ix_llm_usage_user", "llm_usage", ["user_id"], schema="pptmaster")
    op.create_index("ix_llm_usage_user_created", "llm_usage", ["user_id", "created_at"], schema="pptmaster")

    # ── templates: drop org_id, replace uniqueness + indexes ─────────────────
    op.drop_index("ix_templates_org", table_name="templates", schema="pptmaster", if_exists=True)
    op.drop_index("ix_templates_org_kind", table_name="templates", schema="pptmaster", if_exists=True)
    op.drop_constraint("uq_template_org_id", "templates", schema="pptmaster", type_="unique")
    op.drop_column("templates", "org_id", schema="pptmaster")

    op.create_unique_constraint("uq_template_id", "templates", ["template_id"], schema="pptmaster")
    op.create_index("ix_templates_kind", "templates", ["kind"], schema="pptmaster")

    # ── template_uploads: drop org_id ────────────────────────────────────────
    op.drop_index("ix_template_uploads_org", table_name="template_uploads", schema="pptmaster", if_exists=True)
    op.drop_column("template_uploads", "org_id", schema="pptmaster")

    # ── audit_log: drop org_id, add user_id index ────────────────────────────
    op.drop_index("ix_audit_log_org", table_name="audit_log", schema="pptmaster", if_exists=True)
    op.drop_index("ix_audit_log_org_created", table_name="audit_log", schema="pptmaster", if_exists=True)
    op.drop_column("audit_log", "org_id", schema="pptmaster")

    op.create_index("ix_audit_log_user_created", "audit_log", ["user_id", "created_at"], schema="pptmaster")

    # ── invitations: drop org_id ─────────────────────────────────────────────
    op.drop_column("invitations", "org_id", schema="pptmaster")


def downgrade() -> None:
    # ── invitations: restore org_id ──────────────────────────────────────────
    op.add_column(
        "invitations",
        sa.Column("org_id", sa.String(), nullable=True),
        schema="pptmaster",
    )

    # ── audit_log: restore org_id ────────────────────────────────────────────
    op.drop_index("ix_audit_log_user_created", "audit_log", schema="pptmaster", if_exists=True)
    op.add_column(
        "audit_log",
        sa.Column("org_id", sa.String(), nullable=True),
        schema="pptmaster",
    )
    op.create_index("ix_audit_log_org", "audit_log", ["org_id"], schema="pptmaster")
    op.create_index("ix_audit_log_org_created", "audit_log", ["org_id", "created_at"], schema="pptmaster")

    # ── template_uploads: restore org_id ─────────────────────────────────────
    op.add_column(
        "template_uploads",
        sa.Column("org_id", sa.String(), nullable=True),
        schema="pptmaster",
    )
    op.create_index("ix_template_uploads_org", "template_uploads", ["org_id"], schema="pptmaster")

    # ── templates: restore org_id ────────────────────────────────────────────
    op.drop_constraint("uq_template_id", "templates", schema="pptmaster", type_="unique")
    op.drop_index("ix_templates_kind", "templates", schema="pptmaster", if_exists=True)
    op.add_column(
        "templates",
        sa.Column("org_id", sa.String(), nullable=True),
        schema="pptmaster",
    )
    op.create_index("ix_templates_org", "templates", ["org_id"], schema="pptmaster")
    op.create_index("ix_templates_org_kind", "templates", ["org_id", "kind"], schema="pptmaster")
    op.create_unique_constraint("uq_template_org_id", "templates", ["org_id", "template_id"], schema="pptmaster")

    # ── llm_usage: restore org_id ────────────────────────────────────────────
    op.drop_index("ix_llm_usage_user", "llm_usage", schema="pptmaster", if_exists=True)
    op.drop_index("ix_llm_usage_user_created", "llm_usage", schema="pptmaster", if_exists=True)
    op.alter_column("llm_usage", "user_id", new_column_name="org_id", schema="pptmaster")
    op.create_index("ix_llm_usage_org", "llm_usage", ["org_id"], schema="pptmaster")
    op.create_index("ix_llm_usage_org_created", "llm_usage", ["org_id", "created_at"], schema="pptmaster")

    # ── llm_configs: restore org_id ──────────────────────────────────────────
    op.drop_index("ix_llm_configs_created_by", "llm_configs", schema="pptmaster", if_exists=True)
    op.drop_column("llm_configs", "created_by", schema="pptmaster")
    op.add_column(
        "llm_configs",
        sa.Column(
            "org_id",
            sa.String(),
            sa.ForeignKey("pptmaster.organizations.id", ondelete="CASCADE"),
            nullable=True,
        ),
        schema="pptmaster",
    )
    op.create_index("ix_llm_configs_org", "llm_configs", ["org_id"], schema="pptmaster")

    # ── projects: restore org_id ─────────────────────────────────────────────
    op.drop_index("ix_projects_owner_updated", "projects", schema="pptmaster", if_exists=True)
    op.add_column(
        "projects",
        sa.Column(
            "org_id",
            sa.String(),
            sa.ForeignKey("pptmaster.organizations.id", ondelete="CASCADE"),
            nullable=True,
        ),
        schema="pptmaster",
    )
    op.create_index("ix_projects_org", "projects", ["org_id"], schema="pptmaster")
    op.create_index("ix_projects_org_updated", "projects", ["org_id", "updated_at"], schema="pptmaster")

    # ── users: drop is_server_admin ──────────────────────────────────────────
    op.drop_column("users", "is_server_admin", schema="pptmaster")
