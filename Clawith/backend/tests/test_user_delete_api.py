"""Unit tests for DELETE /api/users/{user_id} (delete_user handler).

Uses a purely in-memory _RecordingDB — no real database, no I/O.
The _RecordingDB.execute() pops pre-loaded _FakeResult objects in order,
mirroring the exact sequence of db.execute() calls inside delete_user.
"""
import uuid
from types import SimpleNamespace

import pytest

from app.api import users as users_api


# ── helpers ──────────────────────────────────────────────────────────────────

def _make_user(*, id=None, role="member", tenant_id=None, identity_id=None, is_active=True):
    tid = tenant_id or uuid.uuid4()
    iid = identity_id or uuid.uuid4()
    return SimpleNamespace(
        id=id or uuid.uuid4(), role=role, tenant_id=tid,
        identity_id=iid, is_active=is_active,
        identity=SimpleNamespace(id=iid),
    )


class _FakeResult:
    def __init__(self, rows):
        self._rows = rows

    def scalar_one_or_none(self):
        return self._rows[0] if self._rows else None

    def scalar(self):
        return self._rows[0] if self._rows else 0

    def scalars(self):
        return SimpleNamespace(all=lambda: self._rows)


class _RecordingDB:
    def __init__(self, execute_side_effects):
        self._effects = iter(execute_side_effects)
        self.deleted = []
        self.flushed = 0
        self.committed = False

    async def execute(self, *args, **kwargs):
        return next(self._effects)

    async def get(self, model, pk):
        return SimpleNamespace(id=pk)

    async def delete(self, obj):
        self.deleted.append(obj)

    async def flush(self):
        self.flushed += 1

    async def commit(self):
        self.committed = True


def _full_success_effects(target, *, remaining_identities):
    """Return the ordered list of _FakeResult objects for the full 13-execute path."""
    return [
        _FakeResult([target]),              # 1.  SELECT User (fetch target)
        _FakeResult([]),                    # 2.  SELECT Agent
        _FakeResult([]),                    # 3.  SELECT OrgMember
        _FakeResult([]),                    # 4.  SELECT ChatMessage
        _FakeResult([]),                    # 5.  SELECT ChatSession
        _FakeResult([]),                    # 6.  SELECT WorkspaceEditLock
        _FakeResult([]),                    # 7.  SELECT Task (created_by)
        _FakeResult([]),                    # 8.  SELECT AgentSchedule
        _FakeResult([]),                    # 9.  SELECT PublishedPage
        _FakeResult([]),                    # 10. SELECT ExportJob
        _FakeResult([]),                    # 11. SELECT Presentation
        _FakeResult([]),                    # 12. UPDATE Task supervision ref
        _FakeResult([remaining_identities]),# 13. SELECT COUNT User (identity)
    ]


# ── test cases ────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_delete_user_success_single_tenant():
    """Member in a single tenant: User + Identity both deleted and committed."""
    tid = uuid.uuid4()
    iid = uuid.uuid4()
    current_user = _make_user(role="org_admin", tenant_id=tid)
    target = _make_user(role="member", tenant_id=tid, identity_id=iid)

    db = _RecordingDB(_full_success_effects(target, remaining_identities=0))

    await users_api.delete_user(
        user_id=target.id,
        current_user=current_user,
        db=db,
    )

    assert db.committed is True
    assert target in db.deleted
    # Identity object (returned by db.get) should also be in db.deleted
    identity_deletions = [obj for obj in db.deleted if getattr(obj, "id", None) == iid]
    assert len(identity_deletions) == 1


@pytest.mark.asyncio
async def test_delete_user_success_multi_tenant():
    """Identity shared across tenants: only User deleted, Identity kept."""
    tid = uuid.uuid4()
    iid = uuid.uuid4()
    current_user = _make_user(role="org_admin", tenant_id=tid)
    target = _make_user(role="member", tenant_id=tid, identity_id=iid)

    # remaining_identities=2 means other memberships exist
    db = _RecordingDB(_full_success_effects(target, remaining_identities=2))

    await users_api.delete_user(
        user_id=target.id,
        current_user=current_user,
        db=db,
    )

    assert db.committed is True
    assert target in db.deleted
    # Identity should NOT be deleted
    identity_deletions = [obj for obj in db.deleted if getattr(obj, "id", None) == iid]
    assert len(identity_deletions) == 0


@pytest.mark.asyncio
async def test_delete_user_forbidden_non_admin():
    """Non-admin caller is rejected before any DB calls (403)."""
    from fastapi import HTTPException

    tid = uuid.uuid4()
    current_user = _make_user(role="member", tenant_id=tid)
    target = _make_user(role="member", tenant_id=tid)

    db = _RecordingDB([])  # no execute calls expected

    with pytest.raises(HTTPException) as exc_info:
        await users_api.delete_user(
            user_id=target.id,
            current_user=current_user,
            db=db,
        )

    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_delete_user_cannot_delete_self():
    """Caller attempting self-deletion is rejected before any DB calls (400)."""
    from fastapi import HTTPException

    tid = uuid.uuid4()
    uid = uuid.uuid4()
    current_user = _make_user(id=uid, role="org_admin", tenant_id=tid)

    db = _RecordingDB([])  # no execute calls expected

    with pytest.raises(HTTPException) as exc_info:
        await users_api.delete_user(
            user_id=uid,
            current_user=current_user,
            db=db,
        )

    assert exc_info.value.status_code == 400


@pytest.mark.asyncio
async def test_delete_user_cannot_delete_admin():
    """Target is an org_admin: 400 after exactly 1 execute (SELECT User)."""
    from fastapi import HTTPException

    tid = uuid.uuid4()
    current_user = _make_user(role="org_admin", tenant_id=tid)
    admin_target = _make_user(role="org_admin", tenant_id=tid)

    db = _RecordingDB([
        _FakeResult([admin_target]),  # 1. SELECT User → returns admin
    ])

    with pytest.raises(HTTPException) as exc_info:
        await users_api.delete_user(
            user_id=admin_target.id,
            current_user=current_user,
            db=db,
        )

    assert exc_info.value.status_code == 400


@pytest.mark.asyncio
async def test_delete_user_not_found():
    """No matching User row: 404 after exactly 1 execute (SELECT User → None)."""
    from fastapi import HTTPException

    tid = uuid.uuid4()
    current_user = _make_user(role="org_admin", tenant_id=tid)

    db = _RecordingDB([
        _FakeResult([]),  # 1. SELECT User → None
    ])

    with pytest.raises(HTTPException) as exc_info:
        await users_api.delete_user(
            user_id=uuid.uuid4(),
            current_user=current_user,
            db=db,
        )

    assert exc_info.value.status_code == 404


@pytest.mark.asyncio
async def test_delete_user_cross_tenant_blocked():
    """org_admin trying to delete a user from another tenant gets 403."""
    from fastapi import HTTPException

    tid_a = uuid.uuid4()
    tid_b = uuid.uuid4()
    current_user = _make_user(role="org_admin", tenant_id=tid_a)
    other_tenant_user = _make_user(role="member", tenant_id=tid_b)

    db = _RecordingDB([
        _FakeResult([other_tenant_user]),  # 1. SELECT User → user in different tenant
    ])

    with pytest.raises(HTTPException) as exc_info:
        await users_api.delete_user(
            user_id=other_tenant_user.id,
            current_user=current_user,
            db=db,
        )

    assert exc_info.value.status_code == 403
