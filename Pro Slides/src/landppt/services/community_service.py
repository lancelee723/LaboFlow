"""
Community operations service:
- daily check-in
- sponsor thank-you page
- site notice banner
"""

from __future__ import annotations

import logging
import random
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Tuple

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from ..database.database import AsyncSessionLocal
from ..database.models import (
    CreditTransaction,
    DailyCheckIn,
    SponsorProfile,
    UserConfig,
    User,
)
from ..database.repositories import UserConfigRepository

logger = logging.getLogger(__name__)


class CommunityService:
    SETTINGS_CATEGORY = "community_ops"
    CHECKIN_RESET_HOUR = 8
    CHECKIN_TIMEZONE = timezone(timedelta(hours=8))
    CHECKIN_TIMEZONE_NAME = "Asia/Shanghai"
    SETTINGS_SCHEMA = {
        "daily_checkin_enabled": {"type": "boolean", "default": False},
        "daily_checkin_reward_mode": {"type": "text", "default": "fixed"},
        "daily_checkin_reward_fixed": {"type": "number", "default": 5},
        "daily_checkin_reward_min": {"type": "number", "default": 2},
        "daily_checkin_reward_max": {"type": "number", "default": 8},
        "sponsor_page_enabled": {"type": "boolean", "default": False},
        "site_notice_enabled": {"type": "boolean", "default": False},
        "site_notice_level": {"type": "text", "default": "info"},
        "site_notice_title": {"type": "text", "default": ""},
        "site_notice_message": {"type": "text", "default": ""},
        "site_notice_start_at": {"type": "number", "default": 0},
        "site_notice_end_at": {"type": "number", "default": 0},
    }

    def _convert_setting_value(self, value: Any, value_type: str) -> Any:
        if value is None:
            return None
        if value_type == "boolean":
            if isinstance(value, bool):
                return value
            return str(value).strip().lower() in {"1", "true", "yes", "on"}
        if value_type == "number":
            try:
                if "." in str(value):
                    return float(value)
                return int(value)
            except Exception:
                return 0
        return str(value).strip()

    def _serialize_setting_value(self, value: Any, value_type: str) -> str:
        if value is None:
            return ""
        if value_type == "boolean":
            return "true" if bool(value) else "false"
        return str(value)

    def _normalize_settings(self, settings: Dict[str, Any]) -> Dict[str, Any]:
        result: Dict[str, Any] = {}
        for key, meta in self.SETTINGS_SCHEMA.items():
            raw_value = settings.get(key, meta["default"])
            result[key] = self._convert_setting_value(raw_value, meta["type"])

        reward_mode = str(result["daily_checkin_reward_mode"] or "fixed").strip().lower()
        if reward_mode not in {"fixed", "random"}:
            reward_mode = "fixed"
        result["daily_checkin_reward_mode"] = reward_mode

        result["daily_checkin_reward_fixed"] = max(0, int(result["daily_checkin_reward_fixed"] or 0))
        result["daily_checkin_reward_min"] = max(0, int(result["daily_checkin_reward_min"] or 0))
        result["daily_checkin_reward_max"] = max(0, int(result["daily_checkin_reward_max"] or 0))
        if result["daily_checkin_reward_min"] > result["daily_checkin_reward_max"]:
            result["daily_checkin_reward_min"], result["daily_checkin_reward_max"] = (
                result["daily_checkin_reward_max"],
                result["daily_checkin_reward_min"],
            )

        notice_level = str(result["site_notice_level"] or "info").strip().lower()
        if notice_level not in {"info", "success", "warning", "danger"}:
            notice_level = "info"
        result["site_notice_level"] = notice_level
        result["site_notice_title"] = str(result["site_notice_title"] or "").strip()
        result["site_notice_message"] = str(result["site_notice_message"] or "").strip()

        for key in ("site_notice_start_at", "site_notice_end_at"):
            value = result.get(key)
            try:
                ts_value = float(value or 0)
            except Exception:
                ts_value = 0.0
            result[key] = ts_value if ts_value > 0 else None

        if (
            result["site_notice_start_at"] is not None
            and result["site_notice_end_at"] is not None
            and result["site_notice_start_at"] > result["site_notice_end_at"]
        ):
            result["site_notice_start_at"], result["site_notice_end_at"] = (
                result["site_notice_end_at"],
                result["site_notice_start_at"],
            )
        return result

    def build_public_site_notice(
        self,
        settings: Dict[str, Any],
        *,
        now_ts: Optional[float] = None,
    ) -> Optional[Dict[str, Any]]:
        normalized = self._normalize_settings(settings or {})
        if not normalized["site_notice_enabled"]:
            return None

        title = normalized["site_notice_title"]
        message = normalized["site_notice_message"]
        if not title and not message:
            return None

        current_ts = float(time.time() if now_ts is None else now_ts)
        start_at = normalized["site_notice_start_at"]
        end_at = normalized["site_notice_end_at"]

        if start_at is not None and current_ts < float(start_at):
            return None
        if end_at is not None and current_ts > float(end_at):
            return None

        return {
            "active": True,
            "level": normalized["site_notice_level"],
            "title": title,
            "message": message,
            "start_at": start_at,
            "end_at": end_at,
        }

    def build_public_settings_payload(
        self,
        settings: Dict[str, Any],
        *,
        now_ts: Optional[float] = None,
    ) -> Dict[str, Any]:
        normalized = self._normalize_settings(settings or {})
        return {
            "sponsor_page_enabled": bool(normalized.get("sponsor_page_enabled")),
            "sponsor_page_url": "/sponsors",
            "site_notice": self.build_public_site_notice(normalized, now_ts=now_ts),
        }

    async def _get_settings_with_session(self, session: AsyncSession) -> Dict[str, Any]:
        repo = UserConfigRepository(session)
        loaded: Dict[str, Any] = {}
        for key, meta in self.SETTINGS_SCHEMA.items():
            value = await repo.get_config(None, key)
            if value is None:
                value = meta["default"]
            loaded[key] = value
        return self._normalize_settings(loaded)

    async def get_settings(self) -> Dict[str, Any]:
        async with AsyncSessionLocal() as session:
            return await self._get_settings_with_session(session)

    async def update_settings(self, updates: Dict[str, Any]) -> Dict[str, Any]:
        async with AsyncSessionLocal() as session:
            repo = UserConfigRepository(session)
            current = await self._get_settings_with_session(session)
            merged = {**current, **(updates or {})}
            normalized = self._normalize_settings(merged)

            for key, meta in self.SETTINGS_SCHEMA.items():
                await repo.set_config(
                    user_id=None,
                    key=key,
                    value=self._serialize_setting_value(normalized[key], meta["type"]),
                    config_type=meta["type"],
                    category=self.SETTINGS_CATEGORY,
                )

            await session.commit()
            return normalized

    def _get_setting_with_sync_db(self, db: Session, key: str) -> Any:
        meta = self.SETTINGS_SCHEMA.get(key)
        if not meta:
            raise KeyError(f"Unknown community setting: {key}")

        if db is None:
            return meta["default"]

        record = (
            db.query(UserConfig)
            .filter(
                UserConfig.user_id.is_(None),
                UserConfig.category == self.SETTINGS_CATEGORY,
                UserConfig.config_key == key,
            )
            .order_by(UserConfig.updated_at.desc(), UserConfig.id.desc())
            .first()
        )
        if not record:
            return meta["default"]

        value_type = str(record.config_type or meta["type"]).strip() or meta["type"]
        return self._convert_setting_value(record.config_value, value_type)

    @classmethod
    def _checkin_window(cls, now_ts: Optional[float] = None) -> tuple[str, float]:
        ts = time.time() if now_ts is None else float(now_ts)
        current = datetime.fromtimestamp(ts, tz=cls.CHECKIN_TIMEZONE)
        reset_point = current.replace(hour=cls.CHECKIN_RESET_HOUR, minute=0, second=0, microsecond=0)

        if current < reset_point:
            checkin_date = (current - timedelta(days=1)).date().isoformat()
            next_reset = reset_point
        else:
            checkin_date = current.date().isoformat()
            next_reset = reset_point + timedelta(days=1)

        return checkin_date, next_reset.timestamp()

    @classmethod
    def _today_key(cls, now_ts: Optional[float] = None) -> str:
        checkin_date, _ = cls._checkin_window(now_ts)
        return checkin_date

    def _build_checkin_payload(self, settings: Dict[str, Any], today: str, *, enabled: Optional[bool] = None) -> Dict[str, Any]:
        _, next_reset_at = self._checkin_window()
        return {
            "enabled": bool(settings["daily_checkin_enabled"]) if enabled is None else bool(enabled),
            "today": today,
            "reward_preview": self._checkin_reward_preview(settings),
            "next_reset_at": next_reset_at,
            "reset_hour": self.CHECKIN_RESET_HOUR,
            "reset_timezone": self.CHECKIN_TIMEZONE_NAME,
            "reset_description": f"每日 {self.CHECKIN_RESET_HOUR:02d}:00 重置签到状态",
        }

    def _checkin_reward_preview(self, settings: Dict[str, Any]) -> str:
        if settings["daily_checkin_reward_mode"] == "random":
            return f"{settings['daily_checkin_reward_min']} ~ {settings['daily_checkin_reward_max']} 积分"
        return f"{settings['daily_checkin_reward_fixed']} 积分"

    def _resolve_checkin_reward(self, settings: Dict[str, Any]) -> int:
        if settings["daily_checkin_reward_mode"] == "random":
            low = int(settings["daily_checkin_reward_min"] or 0)
            high = int(settings["daily_checkin_reward_max"] or 0)
            if high < low:
                low, high = high, low
            if low == high:
                return low
            return random.SystemRandom().randint(low, high)
        return int(settings["daily_checkin_reward_fixed"] or 0)

    async def get_checkin_status(self, user_id: int) -> Dict[str, Any]:
        async with AsyncSessionLocal() as session:
            settings = await self._get_settings_with_session(session)
            today = self._today_key()
            stmt = select(DailyCheckIn).where(
                DailyCheckIn.user_id == user_id,
                DailyCheckIn.checkin_date == today,
            )
            result = await session.execute(stmt)
            record = result.scalar_one_or_none()
            return {
                **self._build_checkin_payload(settings, today),
                "already_checked_in": record is not None,
                "today_reward": record.reward_points if record else None,
            }

    async def perform_checkin(self, user_id: int) -> Tuple[bool, str, Dict[str, Any]]:
        async with AsyncSessionLocal() as session:
            settings = await self._get_settings_with_session(session)
            today = self._today_key()
            if not settings["daily_checkin_enabled"]:
                return False, "签到功能未开启", {
                    **self._build_checkin_payload(settings, today, enabled=False),
                    "already_checked_in": False,
                    "today_reward": None,
                }

            existing_stmt = select(DailyCheckIn).where(
                DailyCheckIn.user_id == user_id,
                DailyCheckIn.checkin_date == today,
            )
            existing_result = await session.execute(existing_stmt)
            existing = existing_result.scalar_one_or_none()
            if existing:
                return False, "今天已经签到过了", {
                    **self._build_checkin_payload(settings, today, enabled=True),
                    "already_checked_in": True,
                    "today_reward": existing.reward_points,
                }

            user = await session.get(User, user_id)
            if not user:
                return False, "用户不存在", {
                    **self._build_checkin_payload(settings, today, enabled=True),
                    "already_checked_in": False,
                    "today_reward": None,
                }

            reward = self._resolve_checkin_reward(settings)
            new_balance = int(user.credits_balance or 0) + reward
            user.credits_balance = new_balance

            session.add(
                DailyCheckIn(
                    user_id=user_id,
                    checkin_date=today,
                    reward_points=reward,
                )
            )
            session.add(
                CreditTransaction(
                    user_id=user_id,
                    amount=reward,
                    balance_after=new_balance,
                    transaction_type="daily_checkin",
                    description=f"每日签到奖励 ({today})",
                    reference_id=today,
                )
            )

            try:
                await session.commit()
            except IntegrityError:
                await session.rollback()
                return False, "今天已经签到过了", {
                    **self._build_checkin_payload(settings, today, enabled=True),
                    "already_checked_in": True,
                    "today_reward": None,
                }

            return True, f"签到成功，获得 {reward} 积分", {
                **self._build_checkin_payload(settings, today, enabled=True),
                "already_checked_in": True,
                "today_reward": reward,
                "new_balance": new_balance,
            }

    async def list_sponsors(self, include_inactive: bool = True) -> list[Dict[str, Any]]:
        async with AsyncSessionLocal() as session:
            stmt = select(SponsorProfile)
            if not include_inactive:
                stmt = stmt.where(SponsorProfile.is_active == True)  # noqa: E712
            stmt = stmt.order_by(SponsorProfile.sort_order.asc(), SponsorProfile.created_at.desc())
            result = await session.execute(stmt)
            return [item.to_dict() for item in result.scalars().all()]

    async def create_sponsor(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        async with AsyncSessionLocal() as session:
            sponsor = SponsorProfile(
                nickname=str(payload.get("nickname") or "").strip(),
                avatar_url=(str(payload.get("avatar_url") or "").strip() or None),
                bio=(str(payload.get("bio") or "").strip() or None),
                link_url=(str(payload.get("link_url") or "").strip() or None),
                amount=(str(payload.get("amount") or "").strip() or None),
                note=(str(payload.get("note") or "").strip() or None),
                sort_order=int(payload.get("sort_order") or 0),
                is_active=bool(payload.get("is_active", True)),
            )
            if not sponsor.nickname:
                raise ValueError("赞助人昵称不能为空")
            session.add(sponsor)
            await session.commit()
            await session.refresh(sponsor)
            return sponsor.to_dict()

    async def update_sponsor(self, sponsor_id: int, payload: Dict[str, Any]) -> Dict[str, Any]:
        async with AsyncSessionLocal() as session:
            sponsor = await session.get(SponsorProfile, sponsor_id)
            if not sponsor:
                raise ValueError("赞助人不存在")

            if "nickname" in payload:
                sponsor.nickname = str(payload.get("nickname") or "").strip()
            if "avatar_url" in payload:
                sponsor.avatar_url = (str(payload.get("avatar_url") or "").strip() or None)
            if "bio" in payload:
                sponsor.bio = (str(payload.get("bio") or "").strip() or None)
            if "link_url" in payload:
                sponsor.link_url = (str(payload.get("link_url") or "").strip() or None)
            if "amount" in payload:
                sponsor.amount = (str(payload.get("amount") or "").strip() or None)
            if "note" in payload:
                sponsor.note = (str(payload.get("note") or "").strip() or None)
            if "sort_order" in payload and payload.get("sort_order") is not None:
                sponsor.sort_order = int(payload.get("sort_order") or 0)
            if "is_active" in payload and payload.get("is_active") is not None:
                sponsor.is_active = bool(payload.get("is_active"))

            if not sponsor.nickname:
                raise ValueError("赞助人昵称不能为空")

            await session.commit()
            await session.refresh(sponsor)
            return sponsor.to_dict()

    async def delete_sponsor(self, sponsor_id: int) -> bool:
        async with AsyncSessionLocal() as session:
            sponsor = await session.get(SponsorProfile, sponsor_id)
            if not sponsor:
                return False
            await session.delete(sponsor)
            await session.commit()
            return True

    async def get_public_sponsors(self) -> list[Dict[str, Any]]:
        return await self.list_sponsors(include_inactive=False)


community_service = CommunityService()
