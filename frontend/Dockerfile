FROM node:25-alpine

WORKDIR /app/frontend

# Install dependencies from the lockfile first for better layer caching
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci

# Baked-in copy so the image runs standalone; compose bind-mounts these back over
# the copy in dev so host edits hot-reload.
COPY frontend/src ./src
COPY frontend/styles ./styles
COPY frontend/index.html ./
COPY frontend/tsconfig.json ./
COPY frontend/vite.config.ts ./
COPY tsconfig.base.json /app/tsconfig.base.json
COPY shared/src /app/shared/src

# Vite dev server: host/port come from vite.config.ts (0.0.0.0:8080)
EXPOSE 8080
CMD ["npm", "run", "dev"]
