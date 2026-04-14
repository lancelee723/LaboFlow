FROM python:3.12.10-slim AS deps

WORKDIR /app
RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc libpq-dev && \
    rm -rf /var/lib/apt/lists/*

COPY Clawith/backend/pyproject.toml ./
ARG CLAWITH_PIP_INDEX_URL
ARG CLAWITH_PIP_TRUSTED_HOST
RUN if [ -n "$CLAWITH_PIP_INDEX_URL" ] && [ -n "$CLAWITH_PIP_TRUSTED_HOST" ]; then \
        pip install --no-cache-dir --index-url "$CLAWITH_PIP_INDEX_URL" --trusted-host "$CLAWITH_PIP_TRUSTED_HOST" .; \
    elif [ -n "$CLAWITH_PIP_INDEX_URL" ]; then \
        pip install --no-cache-dir --index-url "$CLAWITH_PIP_INDEX_URL" .; \
    else \
        pip install --no-cache-dir .; \
    fi

FROM python:3.12.10-slim AS production

WORKDIR /app
RUN apt-get update && \
    apt-get install -y --no-install-recommends libpq5 curl gosu && \
    rm -rf /var/lib/apt/lists/*

COPY --from=deps /usr/local/lib/python3.12/site-packages/ /usr/local/lib/python3.12/site-packages/
COPY --from=deps /usr/local/bin/ /usr/local/bin/

COPY Clawith/backend/ .

RUN useradd --create-home clawith && \
    mkdir -p /data/agents && \
    chmod +x /app/entrypoint.sh && \
    chown -R clawith:clawith /app /data

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:8000/api/health || exit 1

EXPOSE 8000
ENTRYPOINT ["/bin/bash", "/app/entrypoint.sh"]
