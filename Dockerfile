# syntax=docker/dockerfile:1.7

FROM oven/bun:1.2.8-alpine AS deps
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

FROM deps AS check
RUN bun run check

FROM oven/bun:1.2.8-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

USER bun
CMD ["bun", "run", "src/index.ts"]
