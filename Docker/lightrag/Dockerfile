FROM --platform=$BUILDPLATFORM oven/bun:1 AS frontend-builder

WORKDIR /app
COPY LightRAG/lightrag_webui/ ./lightrag_webui/
RUN --mount=type=cache,target=/root/.bun/install/cache \
    cd lightrag_webui \
    && bun install --frozen-lockfile \
    && bun run build

FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS builder

ENV DEBIAN_FRONTEND=noninteractive
ENV UV_SYSTEM_PYTHON=1
ENV UV_COMPILE_BYTECODE=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        build-essential \
        pkg-config \
    && rm -rf /var/lib/apt/lists/* \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

ENV PATH="/root/.cargo/bin:/root/.local/bin:${PATH}"
RUN mkdir -p /root/.local/share/uv

COPY LightRAG/pyproject.toml .
COPY LightRAG/setup.py .
COPY LightRAG/uv.lock .

RUN --mount=type=cache,target=/root/.local/share/uv \
    uv sync --frozen --no-dev --extra api --extra offline --no-install-project --no-editable

COPY LightRAG/lightrag/ ./lightrag/
COPY --from=frontend-builder /app/lightrag/api/webui/ ./lightrag/api/webui/

RUN --mount=type=cache,target=/root/.local/share/uv \
    uv sync --frozen --no-dev --extra api --extra offline --no-editable \
    && /app/.venv/bin/python -m ensurepip --upgrade

RUN mkdir -p /app/data/tiktoken \
    && uv run lightrag-download-cache --cache-dir /app/data/tiktoken || status=$?; \
    if [ -n "${status:-}" ] && [ "$status" -ne 0 ] && [ "$status" -ne 2 ]; then exit "$status"; fi

FROM python:3.12.10-slim

WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

ENV UV_SYSTEM_PYTHON=1

COPY --from=builder /root/.local /root/.local
COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app/lightrag ./lightrag
COPY LightRAG/pyproject.toml .
COPY LightRAG/setup.py .
COPY LightRAG/uv.lock .

ENV PATH=/app/.venv/bin:/root/.local/bin:$PATH

RUN --mount=type=cache,target=/root/.local/share/uv \
    uv sync --frozen --no-dev --extra api --extra offline --no-editable \
    && /app/.venv/bin/python -m ensurepip --upgrade

RUN mkdir -p /app/data/rag_storage /app/data/inputs /app/data/tiktoken

COPY --from=builder /app/data/tiktoken /app/data/tiktoken

ENV TIKTOKEN_CACHE_DIR=/app/data/tiktoken
ENV WORKING_DIR=/app/data/rag_storage
ENV INPUT_DIR=/app/data/inputs

EXPOSE 9621
ENTRYPOINT ["python", "-m", "lightrag.api.lightrag_server"]
