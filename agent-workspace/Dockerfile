FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm install --no-save typescript tsx && npx tsc -p tsconfig.json

ENV HOST=0.0.0.0
ENV PORT=8899
ENV WORKSPACE_FILES_ROOT=/data/files
VOLUME /data

# Fail-closed: startup refuses 0.0.0.0 without WORKSPACE_PASSWORD.
CMD ["npx", "tsx", "scripts/serve.ts"]
