import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.security import get_current_user
from app.database import get_db
from app.models.agent import Agent
from app.models.user import User

router = APIRouter(prefix="/users", tags=["users"])


class UserQuotaUpdate(BaseModel):
    quota_message_limit: int | None = None
    quota_message_period: str | None = None
    quota_max_agents: int | None = None
    quota_agent_ttl_hours: int | None = None


class UserOut(BaseModel):
    id: uuid.UUID
    # username/email/display_name can be None for SSO-created users whose Identity
    # was created without explicit values (e.g., DingTalk/Feishu OAuth flow).
    # The frontend should handle None gracefully.
    username: str | None = None
    email: str | None = None
    display_name: str | None = None
    role: str
    is_active: bool
    # Quota fields
    quota_message_limit: int
    quota_message_period: str
    quota_messages_used: int
    quota_max_agents: int
    quota_agent_ttl_hours: int
    # Computed
    agents_count: int = 0
    # Source info
    created_at: str | None = None
    source: str = 'registered'  # 'registered' | 'feishu' | 'dingtalk' | 'wecom' | etc.

    model_config = {"from_attributes": True}


@router.get("/", response_model=list[UserOut])
async def list_users(
    tenant_id: str | None = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List all users in the specified tenant (admin only)."""
    if current_user.role not in ("platform_admin", "org_admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")

    # Platform admins can view any tenant; org_admins only their own
    tid = tenant_id if tenant_id and current_user.role == "platform_admin" else str(current_user.tenant_id)

    # Filter users by tenant — platform_admins only shown in their own tenant
    result = await db.execute(
        select(User).options(selectinload(User.identity)).where(
            User.tenant_id == tid
        ).order_by(User.created_at.asc())
    )
    users = result.scalars().all()

    out = []
    for u in users:
        # Count non-expired agents
        count_result = await db.execute(
            select(func.count()).select_from(Agent).where(
                Agent.creator_id == u.id,
                Agent.is_expired == False,
            )
        )
        agents_count = count_result.scalar() or 0

        user_dict = {
            "id": u.id,
            # Fallback to empty string if username/email/display_name is None to prevent
            # serialization errors for SSO-created users with incomplete Identity records.
            "username": u.username or u.email or f"{u.registration_source or 'user'}_{str(u.id)[:8]}",
            "email": u.email or "",
            "display_name": u.display_name or u.username or "",
            "role": u.role,
            "is_active": u.is_active,
            "quota_message_limit": u.quota_message_limit,
            "quota_message_period": u.quota_message_period,
            "quota_messages_used": u.quota_messages_used,
            "quota_max_agents": u.quota_max_agents,
            "quota_agent_ttl_hours": u.quota_agent_ttl_hours,
            "agents_count": agents_count,
            "created_at": u.created_at.isoformat() if u.created_at else None,
            "source": (u.registration_source or 'registered'),
        }
        out.append(UserOut(**user_dict))
    return out


@router.patch("/{user_id}/quota", response_model=UserOut)
async def update_user_quota(
    user_id: uuid.UUID,
    data: UserQuotaUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update a user's quota settings (admin only)."""
    if current_user.role not in ("platform_admin", "org_admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")

    result = await db.execute(
        select(User).options(selectinload(User.identity)).where(User.id == user_id)
    )
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if user.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=403, detail="Cannot modify users outside your organization")

    if data.quota_message_limit is not None:
        user.quota_message_limit = data.quota_message_limit
    if data.quota_message_period is not None:
        if data.quota_message_period not in ("permanent", "daily", "weekly", "monthly"):
            raise HTTPException(status_code=400, detail="Invalid period. Use: permanent, daily, weekly, monthly")
        user.quota_message_period = data.quota_message_period
    if data.quota_max_agents is not None:
        user.quota_max_agents = data.quota_max_agents
    if data.quota_agent_ttl_hours is not None:
        user.quota_agent_ttl_hours = data.quota_agent_ttl_hours

    await db.commit()
    await db.refresh(user)

    # Count agents
    count_result = await db.execute(
        select(func.count()).select_from(Agent).where(
            Agent.creator_id == user.id,
            Agent.is_expired == False,
        )
    )
    agents_count = count_result.scalar() or 0

    return UserOut(
        id=user.id, username=user.username, email=user.email,
        display_name=user.display_name, role=user.role, is_active=user.is_active,
        quota_message_limit=user.quota_message_limit,
        quota_message_period=user.quota_message_period,
        quota_messages_used=user.quota_messages_used,
        quota_max_agents=user.quota_max_agents,
        quota_agent_ttl_hours=user.quota_agent_ttl_hours,
        agents_count=agents_count,
    )


# ─── Role Management ───────────────────────────────────

class RoleUpdate(BaseModel):
    role: str


@router.patch("/{user_id}/role")
async def update_user_role(
    user_id: uuid.UUID,
    data: RoleUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Change a user's role within the same company.

    Permissions:
    - org_admin: can set roles to org_admin / member within own tenant.
      Cannot assign platform_admin.
    - platform_admin: can set any valid role.

    Safety:
    - If the target is the ONLY remaining org_admin in the company,
      demoting them is blocked to prevent orphaned companies.
    """
    if current_user.role not in ("platform_admin", "org_admin"):
        raise HTTPException(status_code=403, detail="Admin access required")

    # Validate target role value
    allowed_roles = ("org_admin", "member")
    if current_user.role == "platform_admin":
        allowed_roles = ("platform_admin", "org_admin", "member")
    if data.role not in allowed_roles:
        raise HTTPException(status_code=400, detail=f"Invalid role. Allowed: {', '.join(allowed_roles)}")

    # Find target user
    result = await db.execute(
        select(User).options(selectinload(User.identity)).where(User.id == user_id)
    )
    target_user = result.scalar_one_or_none()
    if not target_user:
        raise HTTPException(status_code=404, detail="User not found")

    # org_admin can only modify users in the same tenant
    if current_user.role == "org_admin" and target_user.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=403, detail="Cannot modify users outside your organization")

    # No-op shortcut
    if target_user.role == data.role:
        return {"status": "ok", "user_id": str(user_id), "role": data.role}

    # Last-admin protection: if demoting an org_admin, check they are not the only one
    if target_user.role in ("org_admin", "platform_admin") and data.role not in ("org_admin", "platform_admin"):
        admin_count_result = await db.execute(
            select(func.count()).select_from(User).where(
                User.tenant_id == target_user.tenant_id,
                User.role.in_(["org_admin", "platform_admin"]),
            )
        )
        admin_count = admin_count_result.scalar() or 0
        if admin_count <= 1:
            raise HTTPException(
                status_code=400,
                detail="Cannot demote the only administrator. Promote another user first."
            )

    target_user.role = data.role
    await db.commit()
    return {"status": "ok", "user_id": str(user_id), "role": data.role}


# ─── Delete User ───────────────────────────────────────


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    user_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Remove a user from the organization.

    Hard-deletes the User (tenant membership) row and all tenant-scoped data
    owned by that user (agents, org-member channel mappings).
    If the underlying Identity has no remaining tenant memberships it is also
    deleted, effectively removing the account from the platform.

    Permissions:
    - Caller must be org_admin or platform_admin.
    - Cannot delete admins (org_admin / platform_admin).
    - Cannot delete self.
    - org_admin can only delete users in their own tenant.
    """
    if current_user.role not in ("platform_admin", "org_admin"):
        raise HTTPException(status_code=403, detail="Admin access required")

    if current_user.id == user_id:
        raise HTTPException(status_code=400, detail="Cannot delete your own account")

    result = await db.execute(
        select(User).options(selectinload(User.identity)).where(User.id == user_id)
    )
    target = result.scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    if current_user.role == "org_admin" and target.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=403, detail="Cannot delete users outside your organization")

    if target.role in ("org_admin", "platform_admin"):
        raise HTTPException(status_code=400, detail="Cannot delete admin accounts")

    # 1. Delete agents created by this user
    agents_result = await db.execute(
        select(Agent).where(Agent.creator_id == target.id)
    )
    for agent in agents_result.scalars().all():
        await db.delete(agent)
    await db.flush()

    # 2. Delete org-member channel mappings for this user in this tenant
    from app.models.org import OrgMember
    org_members_result = await db.execute(
        select(OrgMember).where(
            OrgMember.user_id == target.id,
            OrgMember.tenant_id == target.tenant_id,
        )
    )
    for om in org_members_result.scalars().all():
        await db.delete(om)
    await db.flush()

    # 3. Delete chat messages sent by this user
    from app.models.audit import ChatMessage
    chat_msgs_result = await db.execute(
        select(ChatMessage).where(ChatMessage.user_id == target.id)
    )
    for msg in chat_msgs_result.scalars().all():
        await db.delete(msg)
    await db.flush()

    # 4. Delete chat sessions owned by this user
    from app.models.chat_session import ChatSession
    chat_sessions_result = await db.execute(
        select(ChatSession).where(ChatSession.user_id == target.id)
    )
    for session in chat_sessions_result.scalars().all():
        await db.delete(session)
    await db.flush()

    # 5. Delete workspace edit locks held by this user
    from app.models.workspace import WorkspaceEditLock
    locks_result = await db.execute(
        select(WorkspaceEditLock).where(WorkspaceEditLock.user_id == target.id)
    )
    for lock in locks_result.scalars().all():
        await db.delete(lock)
    await db.flush()

    # 6. Delete tasks created by this user
    from app.models.task import Task
    tasks_result = await db.execute(
        select(Task).where(Task.created_by == target.id)
    )
    for task in tasks_result.scalars().all():
        await db.delete(task)
    await db.flush()

    # 7. Delete agent schedules created by this user
    from app.models.schedule import AgentSchedule
    schedules_result = await db.execute(
        select(AgentSchedule).where(AgentSchedule.created_by == target.id)
    )
    for sched in schedules_result.scalars().all():
        await db.delete(sched)
    await db.flush()

    # 8. Delete published pages owned by this user
    from app.models.published_page import PublishedPage
    pages_result = await db.execute(
        select(PublishedPage).where(PublishedPage.user_id == target.id)
    )
    for page in pages_result.scalars().all():
        await db.delete(page)
    await db.flush()

    # 9. Delete export jobs created by this user (must precede presentations)
    from app.models.export_job import ExportJob
    export_jobs_result = await db.execute(
        select(ExportJob).where(ExportJob.creator_id == target.id)
    )
    for job in export_jobs_result.scalars().all():
        await db.delete(job)
    await db.flush()

    # 10. Delete presentations created by this user
    from app.models.presentation import Presentation
    presentations_result = await db.execute(
        select(Presentation).where(Presentation.creator_id == target.id)
    )
    for pres in presentations_result.scalars().all():
        await db.delete(pres)
    await db.flush()

    # 11. Nullify supervision references to this user in tasks created by others
    from app.models.task import Task as _Task
    from sqlalchemy import update as _update
    await db.execute(
        _update(_Task)
        .where(_Task.supervision_target_user_id == target.id)
        .values(supervision_target_user_id=None)
    )
    await db.flush()

    # 12. Decide whether to also remove the Identity
    identity_id = target.identity_id
    await db.delete(target)
    await db.flush()

    if identity_id:
        other_result = await db.execute(
            select(func.count()).select_from(User).where(
                User.identity_id == identity_id,
            )
        )
        remaining = other_result.scalar() or 0
        if remaining == 0:
            from app.models.user import Identity
            identity = await db.get(Identity, identity_id)
            if identity:
                await db.delete(identity)

    await db.commit()
