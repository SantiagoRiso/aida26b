FROM node:25-alpine

WORKDIR /app/backend

# Copy package files first for better layer caching
COPY backend/package.json backend/package-lock.json* ./

RUN npm ci

COPY backend/src ./src
COPY backend/tsconfig.json ./
COPY tsconfig.base.json /app/tsconfig.base.json
COPY shared/src /app/shared/src
COPY database/migrations /app/database/migrations

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations and admin seed run before the API starts.
# `npm run dev` (tsx watch) is deliberate: this image backs the development compose stack, which
# mounts the host source over the copies above. A deployment builds with `npm run build` and runs
# the compiled entry directly instead of this image's default command.
CMD ["sh", "-c", "npm run migrate && npm run seed-admin && npm run dev"]
