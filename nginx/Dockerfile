# ─────────────────────────────────────────────────────────────
# Nginx Reverse Proxy for Labo-Flow
#
# Serves as the main entry point for the Labo-Flow platform.
# Routes traffic to:
#   - Clawith frontend (React)
#   - Clawith backend (FastAPI)
#   - RAGFlow (knowledge base)
#   - AIPPT (presentation generator)
# ─────────────────────────────────────────────────────────────

FROM nginx:1.27.1-alpine

# Remove default nginx config
RUN rm /etc/nginx/nginx.conf

# Copy custom nginx config
COPY docker.conf /etc/nginx/nginx.conf

# Create log directories
RUN mkdir -p /var/log/nginx && \
    chown -R nginx:nginx /var/log/nginx && \
    chmod 755 /var/log/nginx

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost/healthz || exit 1

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
