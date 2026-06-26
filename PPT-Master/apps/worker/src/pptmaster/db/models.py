"""SQLAlchemy ORM models for PPT-Master WebUI."""

from datetime import datetime
from typing import Optional
from uuid import uuid4

from sqlalchemy import (
    ARRAY,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    __table_args__ = {"schema": "pptmaster"}

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    email: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    name: Mapped[Optional[str]] = mapped_column(Text)
    password_hash: Mapped[Optional[str]] = mapped_column(Text)
    external_id: Mapped[Optional[str]] = mapped_column(Text, unique=True)
    locale: Mapped[str] = mapped_column(String(2), default="en", server_default="en")
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False)
    is_server_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_login_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


class Project(Base):
    __tablename__ = "projects"
    __table_args__ = (
        Index("ix_projects_owner_updated", "owner_id", "updated_at"),
        Index("ix_projects_soft_deleted_at", "soft_deleted_at"),
        {"schema": "pptmaster"},
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    owner_id: Mapped[str] = mapped_column(String, ForeignKey("pptmaster.users.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    format: Mapped[str] = mapped_column(String, default="ppt169")
    template_id: Mapped[Optional[str]] = mapped_column(String)
    brand_id: Mapped[Optional[str]] = mapped_column(String)
    storage_path: Mapped[str] = mapped_column(Text, nullable=False)
    current_step: Mapped[int] = mapped_column(default=1)
    status: Mapped[str] = mapped_column(String, default="draft")
    ai_summary: Mapped[Optional[str]] = mapped_column(Text)
    user_summary: Mapped[Optional[str]] = mapped_column(Text)
    ai_tags: Mapped[Optional[list[str]]] = mapped_column(ARRAY(Text))
    user_tags: Mapped[Optional[list[str]]] = mapped_column(ARRAY(Text))
    cover_artifact_id: Mapped[Optional[str]] = mapped_column(String)
    generation_duration_sec: Mapped[Optional[int]] = mapped_column()
    llm_providers_used: Mapped[Optional[dict]] = mapped_column(JSONB)
    soft_deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    soft_deleted_by: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    sessions: Mapped[list["Session"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    artifacts: Mapped[list["Artifact"]] = relationship(back_populates="project", cascade="all, delete-orphan")


class Session(Base):
    __tablename__ = "sessions"
    __table_args__ = (
        Index("ix_sessions_project_activity", "project_id", "last_activity_at"),
        {"schema": "pptmaster"},
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    project_id: Mapped[str] = mapped_column(String, ForeignKey("pptmaster.projects.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("pptmaster.users.id"))
    thread_id: Mapped[str] = mapped_column(Text, nullable=False)
    current_step: Mapped[Optional[int]] = mapped_column()
    current_node: Mapped[Optional[str]] = mapped_column(Text)
    is_interrupted: Mapped[bool] = mapped_column(Boolean, default=False)
    interrupt_prompt: Mapped[Optional[dict]] = mapped_column(JSONB)
    status_locked: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    abort_reason: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    llm_config_id: Mapped[Optional[str]] = mapped_column(
        String, ForeignKey("pptmaster.llm_configs.id", ondelete="SET NULL"), nullable=True,
    )
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    ended_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    last_activity_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    project: Mapped["Project"] = relationship(back_populates="sessions")
    messages: Mapped[list["ChatMessage"]] = relationship(back_populates="session", cascade="all, delete-orphan")


class ChatMessage(Base):
    __tablename__ = "chat_messages"
    __table_args__ = (
        Index("ix_chat_messages_session_created", "session_id", "created_at"),
        {"schema": "pptmaster"},
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    session_id: Mapped[str] = mapped_column(String, ForeignKey("pptmaster.sessions.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String, nullable=False)
    agent: Mapped[Optional[str]] = mapped_column(Text)
    content: Mapped[dict] = mapped_column(JSONB, nullable=False)
    tool_calls: Mapped[Optional[dict]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    session: Mapped["Session"] = relationship(back_populates="messages")


class Artifact(Base):
    __tablename__ = "artifacts"
    __table_args__ = (
        Index("ix_artifacts_project_kind", "project_id", "kind"),
        {"schema": "pptmaster"},
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    project_id: Mapped[str] = mapped_column(String, ForeignKey("pptmaster.projects.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String, nullable=False)
    filename: Mapped[str] = mapped_column(Text, nullable=False)
    relative_path: Mapped[str] = mapped_column(Text, nullable=False)
    meta: Mapped[Optional[dict]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    project: Mapped["Project"] = relationship(back_populates="artifacts")


class LLMConfig(Base):
    __tablename__ = "llm_configs"
    __table_args__ = {"schema": "pptmaster"}

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    created_by: Mapped[Optional[str]] = mapped_column(String, ForeignKey("pptmaster.users.id", ondelete="SET NULL"), index=True)
    provider: Mapped[str] = mapped_column(String, nullable=False)
    model: Mapped[str] = mapped_column(String, nullable=False)
    endpoint: Mapped[Optional[str]] = mapped_column(Text)
    api_key_encrypted: Mapped[Optional[bytes]] = mapped_column(LargeBinary)
    role_preference: Mapped[Optional[str]] = mapped_column(String)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    display_name: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ImageBackendConfig(Base):
    __tablename__ = "image_backend_configs"
    __table_args__ = {"schema": "pptmaster"}

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    created_by: Mapped[Optional[str]] = mapped_column(
        String, ForeignKey("pptmaster.users.id", ondelete="SET NULL"), index=True
    )
    backend: Mapped[str] = mapped_column(String, nullable=False)
    model: Mapped[Optional[str]] = mapped_column(String)
    api_key_encrypted: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    base_url: Mapped[Optional[str]] = mapped_column(Text)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    display_name: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ImageSearchConfig(Base):
    __tablename__ = "image_search_configs"
    __table_args__ = (
        UniqueConstraint("provider", name="uq_image_search_configs_provider"),
        {"schema": "pptmaster"},
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    created_by: Mapped[Optional[str]] = mapped_column(
        String, ForeignKey("pptmaster.users.id", ondelete="SET NULL"), index=True
    )
    provider: Mapped[str] = mapped_column(String, nullable=False)
    api_key_encrypted: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class LLMUsage(Base):
    __tablename__ = "llm_usage"
    __table_args__ = (
        Index("ix_llm_usage_user_created", "user_id", "created_at"),
        {"schema": "pptmaster"},
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    user_id: Mapped[Optional[str]] = mapped_column(String, index=True)
    project_id: Mapped[Optional[str]] = mapped_column(String, index=True)
    session_id: Mapped[Optional[str]] = mapped_column(String)
    agent_role: Mapped[str] = mapped_column(String, nullable=False)
    provider: Mapped[str] = mapped_column(String, nullable=False)
    model: Mapped[str] = mapped_column(String, nullable=False)
    input_tokens: Mapped[int] = mapped_column(nullable=False)
    output_tokens: Mapped[int] = mapped_column(nullable=False)
    cost_usd: Mapped[Optional[float]] = mapped_column(Numeric(10, 6))
    latency_ms: Mapped[Optional[int]] = mapped_column()
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Template(Base):
    __tablename__ = "templates"
    __table_args__ = (
        UniqueConstraint("template_id", name="uq_template_id"),
        Index("ix_templates_kind", "kind"),
        {"schema": "pptmaster"},
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    template_id: Mapped[str] = mapped_column(String, nullable=False)
    kind: Mapped[str] = mapped_column(String, nullable=False)
    uploaded_by: Mapped[Optional[str]] = mapped_column(String)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    canvas_format: Mapped[str] = mapped_column(String, nullable=False)
    primary_color: Mapped[Optional[str]] = mapped_column(String)
    page_count: Mapped[Optional[int]] = mapped_column()
    page_types: Mapped[Optional[list[str]]] = mapped_column(ARRAY(Text))
    preview_paths: Mapped[Optional[list[str]]] = mapped_column(ARRAY(Text))
    storage_path: Mapped[str] = mapped_column(Text, nullable=False)
    json_meta: Mapped[Optional[dict]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class TemplateUpload(Base):
    __tablename__ = "template_uploads"
    __table_args__ = {"schema": "pptmaster"}

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    uploaded_by: Mapped[str] = mapped_column(String, nullable=False)
    original_filename: Mapped[str] = mapped_column(Text, nullable=False)
    staging_path: Mapped[str] = mapped_column(Text, nullable=False)
    parse_status: Mapped[str] = mapped_column(String, nullable=False)
    parse_result: Mapped[Optional[dict]] = mapped_column(JSONB)
    parse_error: Mapped[Optional[str]] = mapped_column(Text)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ShareLink(Base):
    __tablename__ = "share_links"
    __table_args__ = (
        Index("ix_share_links_project_revoked_expires", "project_id", "revoked", "expires_at"),
        {"schema": "pptmaster"},
    )

    token: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(String, ForeignKey("pptmaster.projects.id", ondelete="CASCADE"), nullable=False)
    created_by: Mapped[str] = mapped_column(String, nullable=False)
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    allowed_pages: Mapped[Optional[list[int]]] = mapped_column(ARRAY(Integer))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AuditLog(Base):
    __tablename__ = "audit_log"
    __table_args__ = (
        Index("ix_audit_log_user_created", "user_id", "created_at"),
        {"schema": "pptmaster"},
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    user_id: Mapped[Optional[str]] = mapped_column(String, index=True)
    project_id: Mapped[Optional[str]] = mapped_column(String)
    action: Mapped[str] = mapped_column(String, nullable=False)
    meta: Mapped[Optional[dict]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Invitation(Base):
    __tablename__ = "invitations"
    __table_args__ = {"schema": "pptmaster"}

    token: Mapped[str] = mapped_column(String, primary_key=True)
    email: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(String, nullable=False)
    invited_by: Mapped[str] = mapped_column(String, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    accepted: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class SessionEvent(Base):
    __tablename__ = "session_events"
    __table_args__ = {"schema": "pptmaster"}

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    session_id: Mapped[str] = mapped_column(String(36), ForeignKey("pptmaster.sessions.id", ondelete="CASCADE"), nullable=False)
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
