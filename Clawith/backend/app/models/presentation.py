import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSON, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Presentation(Base):
    __tablename__ = "presentations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String(500), nullable=False, default="未命名演示文稿")
    description: Mapped[str | None] = mapped_column(Text, default="")
    content: Mapped[dict | None] = mapped_column(JSON, default=None)
    thumbnail: Mapped[str | None] = mapped_column(String(1000), default=None)
    is_public: Mapped[bool] = mapped_column(Boolean, default=False)

    page_settings: Mapped[dict | None] = mapped_column(JSON, default=None)

    creator_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("tenants.id"))

    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    versions: Mapped[list["PresentationVersion"]] = relationship(back_populates="presentation", cascade="all, delete-orphan")


class PresentationVersion(Base):
    __tablename__ = "presentation_versions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    presentation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("presentations.id", ondelete="CASCADE"), nullable=False)

    content: Mapped[dict | None] = mapped_column(JSON, default=None)
    title: Mapped[str | None] = mapped_column(String(500))
    description: Mapped[str | None] = mapped_column(Text, default="")
    is_auto_save: Mapped[bool] = mapped_column(Boolean, default=False)
    author: Mapped[str | None] = mapped_column(String(200), default=None)
    size: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    presentation: Mapped["Presentation"] = relationship(back_populates="versions")
