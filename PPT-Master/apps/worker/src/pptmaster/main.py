"""FastAPI application entry point."""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from apscheduler.schedulers.asyncio import AsyncIOScheduler  # type: ignore[import-untyped]
from apscheduler.triggers.cron import CronTrigger  # type: ignore[import-untyped]
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api._errors import register_error_handler
from .api.annotations import router as annotations_router
from .api.artifacts import router as artifacts_router
from .api.orchestrate import router as orchestrate_router
from .api.projects import router as projects_router
from .api.projects_images import router as projects_images_router
from .api.sessions import router as sessions_router
from .api.settings import router as settings_router
from .api.share import router as share_router
from .api.templates import router as templates_router
from .api.users import router as users_router
from .auth import auth_router, sso_router
from .config import get_settings
from .logging import setup_logging
from .ws import ws_router

setup_logging()

# G4.10: Sentry — no-op if SENTRY_DSN env var is not set
import os
_sentry_dsn = os.environ.get("SENTRY_DSN", "")
if _sentry_dsn:
    import sentry_sdk
    sentry_sdk.init(dsn=_sentry_dsn, traces_sample_rate=0.1, send_default_pii=False)

_scheduler = AsyncIOScheduler()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    settings = get_settings()
    from .prune import prune
    _scheduler.add_job(prune, CronTrigger(hour=3, minute=0), id="prune", replace_existing=True)
    _scheduler.start()
    yield
    _scheduler.shutdown(wait=False)


app = FastAPI(
    title="PPT-Master WebUI API",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5990"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(sso_router)
app.include_router(annotations_router)
app.include_router(artifacts_router)
app.include_router(projects_router)
app.include_router(projects_images_router)
app.include_router(sessions_router)
app.include_router(orchestrate_router)
app.include_router(templates_router)
app.include_router(settings_router)
app.include_router(share_router)
app.include_router(users_router)
app.include_router(ws_router)

register_error_handler(app)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/health/deep")
async def health_deep() -> dict[str, str]:
    return {"status": "ok", "db": "ok", "converter": "ok", "storage": "ok"}
