FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    SERVE_FRONTEND=true \
    FRONTEND_DIR=/app/frontend

WORKDIR /app/backend

# Install only runtime dependencies. The build context is the repository root because
# the app serves the sibling frontend directory from this same container.
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY backend/ ./
COPY frontend/ /app/frontend/

EXPOSE 10000
CMD ["npm", "start"]
