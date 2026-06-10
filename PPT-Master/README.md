# PPT-Master WebUI

Web application for AI-driven PPT generation. Wraps the PPT-Master skill into a multi-user web product with project management, live SVG preview, and template/brand workflows.

## Quick Start

```bash
cp .env.local.example .env.local
./scripts/dev.sh
```

For production deployment, see `docker/` and `production.docker-compose.yml`.

## Architecture

- `apps/worker/` — FastAPI + LangGraph backend (Python 3.12+)
- `apps/webui/` — React + Vite frontend (TypeScript)
- `alembic/` — Database migrations
- `docker/` — Production Docker images
- `scripts/` — Dev tooling (start/stop/health-check/backup/restore)
