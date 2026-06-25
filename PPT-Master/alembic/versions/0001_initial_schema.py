"""initial_schema

Revision ID: 0001
Revises:
Create Date: 2026-05-31

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("CREATE SCHEMA IF NOT EXISTS pptmaster")

    op.create_table(
        "users",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("email", sa.Text(), nullable=False),
        sa.Column("name", sa.Text()),
        sa.Column("password_hash", sa.Text()),
        sa.Column("external_id", sa.Text()),
        sa.Column("must_change_password", sa.Boolean(), default=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("last_login_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("email"),
        sa.UniqueConstraint("external_id"),
        schema="pptmaster",
    )
    op.create_index("ix_users_email", "users", ["email"], schema="pptmaster")

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

    op.create_table(
        "projects",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("pptmaster.organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("owner_id", sa.String(), sa.ForeignKey("pptmaster.users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("format", sa.String(), default="ppt169"),
        sa.Column("template_id", sa.String()),
        sa.Column("brand_id", sa.String()),
        sa.Column("storage_path", sa.Text(), nullable=False),
        sa.Column("current_step", sa.Integer(), default=1),
        sa.Column("status", sa.String(), default="draft"),
        sa.Column("ai_summary", sa.Text()),
        sa.Column("user_summary", sa.Text()),
        sa.Column("ai_tags", sa.ARRAY(sa.Text())),
        sa.Column("user_tags", sa.ARRAY(sa.Text())),
        sa.Column("cover_artifact_id", sa.String()),
        sa.Column("generation_duration_sec", sa.Integer()),
        sa.Column("llm_providers_used", JSONB()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        schema="pptmaster",
    )
    op.create_index("ix_projects_org", "projects", ["org_id"], schema="pptmaster")
    op.create_index("ix_projects_owner", "projects", ["owner_id"], schema="pptmaster")
    op.create_index("ix_projects_org_updated", "projects", ["org_id", "updated_at"], schema="pptmaster")

    op.create_table(
        "sessions",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), sa.ForeignKey("pptmaster.projects.id", ondelete="CASCADE")),
        sa.Column("user_id", sa.String(), sa.ForeignKey("pptmaster.users.id")),
        sa.Column("thread_id", sa.Text(), nullable=False),
        sa.Column("current_step", sa.Integer()),
        sa.Column("current_node", sa.Text()),
        sa.Column("is_interrupted", sa.Boolean(), default=False),
        sa.Column("interrupt_prompt", JSONB()),
        sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("ended_at", sa.DateTime(timezone=True)),
        sa.Column("last_activity_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        schema="pptmaster",
    )
    op.create_index("ix_sessions_project", "sessions", ["project_id"], schema="pptmaster")
    op.create_index("ix_sessions_project_activity", "sessions", ["project_id", "last_activity_at"], schema="pptmaster")

    op.create_table(
        "chat_messages",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("session_id", sa.String(), sa.ForeignKey("pptmaster.sessions.id", ondelete="CASCADE")),
        sa.Column("role", sa.String(), nullable=False),
        sa.Column("agent", sa.Text()),
        sa.Column("content", JSONB(), nullable=False),
        sa.Column("tool_calls", JSONB()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        schema="pptmaster",
    )
    op.create_index("ix_chat_messages_session", "chat_messages", ["session_id"], schema="pptmaster")
    op.create_index("ix_chat_messages_session_created", "chat_messages", ["session_id", "created_at"], schema="pptmaster")

    op.create_table(
        "artifacts",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), sa.ForeignKey("pptmaster.projects.id", ondelete="CASCADE")),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("filename", sa.Text(), nullable=False),
        sa.Column("relative_path", sa.Text(), nullable=False),
        sa.Column("meta", JSONB()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        schema="pptmaster",
    )
    op.create_index("ix_artifacts_project", "artifacts", ["project_id"], schema="pptmaster")
    op.create_index("ix_artifacts_project_kind", "artifacts", ["project_id", "kind"], schema="pptmaster")

    op.create_table(
        "llm_configs",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("pptmaster.organizations.id", ondelete="CASCADE")),
        sa.Column("provider", sa.String(), nullable=False),
        sa.Column("model", sa.String(), nullable=False),
        sa.Column("endpoint", sa.Text()),
        sa.Column("api_key_encrypted", sa.LargeBinary()),
        sa.Column("role_preference", sa.String()),
        sa.Column("is_default", sa.Boolean(), default=False),
        sa.Column("display_name", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        schema="pptmaster",
    )
    op.create_index("ix_llm_configs_org", "llm_configs", ["org_id"], schema="pptmaster")

    op.create_table(
        "llm_usage",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("org_id", sa.String()),
        sa.Column("project_id", sa.String()),
        sa.Column("session_id", sa.String()),
        sa.Column("agent_role", sa.String(), nullable=False),
        sa.Column("provider", sa.String(), nullable=False),
        sa.Column("model", sa.String(), nullable=False),
        sa.Column("input_tokens", sa.Integer(), nullable=False),
        sa.Column("output_tokens", sa.Integer(), nullable=False),
        sa.Column("cost_usd", sa.Numeric(10, 6)),
        sa.Column("latency_ms", sa.Integer()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        schema="pptmaster",
    )
    op.create_index("ix_llm_usage_org", "llm_usage", ["org_id"], schema="pptmaster")
    op.create_index("ix_llm_usage_project", "llm_usage", ["project_id"], schema="pptmaster")
    op.create_index("ix_llm_usage_org_created", "llm_usage", ["org_id", "created_at"], schema="pptmaster")

    op.create_table(
        "templates",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("template_id", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("org_id", sa.String()),
        sa.Column("uploaded_by", sa.String()),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("canvas_format", sa.String(), nullable=False),
        sa.Column("primary_color", sa.String()),
        sa.Column("page_count", sa.Integer()),
        sa.Column("page_types", sa.ARRAY(sa.Text())),
        sa.Column("preview_paths", sa.ARRAY(sa.Text())),
        sa.Column("storage_path", sa.Text(), nullable=False),
        sa.Column("json_meta", JSONB()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("org_id", "template_id", name="uq_template_org_id"),
        schema="pptmaster",
    )
    op.create_index("ix_templates_org", "templates", ["org_id"], schema="pptmaster")
    op.create_index("ix_templates_org_kind", "templates", ["org_id", "kind"], schema="pptmaster")

    op.create_table(
        "template_uploads",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("org_id", sa.String(), nullable=False),
        sa.Column("uploaded_by", sa.String(), nullable=False),
        sa.Column("original_filename", sa.Text(), nullable=False),
        sa.Column("staging_path", sa.Text(), nullable=False),
        sa.Column("parse_status", sa.String(), nullable=False),
        sa.Column("parse_result", JSONB()),
        sa.Column("parse_error", sa.Text()),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        schema="pptmaster",
    )
    op.create_index("ix_template_uploads_org", "template_uploads", ["org_id"], schema="pptmaster")

    op.create_table(
        "share_links",
        sa.Column("token", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), sa.ForeignKey("pptmaster.projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_by", sa.String(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True)),
        sa.Column("revoked", sa.Boolean(), default=False),
        sa.Column("allowed_pages", sa.ARRAY(sa.Integer())),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        schema="pptmaster",
    )
    op.create_index("ix_share_links_project_revoked_expires", "share_links", ["project_id", "revoked", "expires_at"], schema="pptmaster")

    op.create_table(
        "audit_log",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("org_id", sa.String()),
        sa.Column("user_id", sa.String()),
        sa.Column("project_id", sa.String()),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("meta", JSONB()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        schema="pptmaster",
    )
    op.create_index("ix_audit_log_org", "audit_log", ["org_id"], schema="pptmaster")
    op.create_index("ix_audit_log_org_created", "audit_log", ["org_id", "created_at"], schema="pptmaster")

    op.create_table(
        "invitations",
        sa.Column("token", sa.String(), primary_key=True),
        sa.Column("org_id", sa.String(), nullable=False),
        sa.Column("email", sa.Text(), nullable=False),
        sa.Column("role", sa.String(), nullable=False),
        sa.Column("invited_by", sa.String(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("accepted", sa.Boolean(), default=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        schema="pptmaster",
    )


def downgrade() -> None:
    op.drop_table("invitations", schema="pptmaster")
    op.drop_table("audit_log", schema="pptmaster")
    op.drop_table("share_links", schema="pptmaster")
    op.drop_table("template_uploads", schema="pptmaster")
    op.drop_table("templates", schema="pptmaster")
    op.drop_table("llm_usage", schema="pptmaster")
    op.drop_table("llm_configs", schema="pptmaster")
    op.drop_table("artifacts", schema="pptmaster")
    op.drop_table("chat_messages", schema="pptmaster")
    op.drop_table("sessions", schema="pptmaster")
    op.drop_table("projects", schema="pptmaster")
    op.drop_table("org_members", schema="pptmaster")
    op.drop_table("organizations", schema="pptmaster")
    op.drop_table("users", schema="pptmaster")
    op.execute("DROP SCHEMA IF EXISTS pptmaster CASCADE")
