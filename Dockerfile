FROM clamav/clamav@sha256:7054e3f34308c384ea43cd786ea17abf899bd44af40af9f1b099853d7a5c214e AS signatures

FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    SERVE_FRONTEND=true \
    FRONTEND_DIR=/app/frontend

RUN apt-get update \
    && apt-get install -y --no-install-recommends clamav clamav-freshclam \
    && rm -rf /var/lib/apt/lists/*
COPY --from=signatures /var/lib/clamav/ /var/lib/clamav/
RUN chown -R root:root /var/lib/clamav

WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY backend/ ./
COPY frontend/ /app/frontend/
RUN sed -i 's/\r$//' scripts/container-start.sh && chmod 755 scripts/container-start.sh

EXPOSE 10000
ENTRYPOINT ["/app/backend/scripts/container-start.sh"]
