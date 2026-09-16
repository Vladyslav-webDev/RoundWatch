FROM node:24.14.0-bookworm-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@12.3.4 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/client/package.json apps/client/package.json

RUN pnpm install --frozen-lockfile

COPY apps/server apps/server

ENV NODE_ENV=production
EXPOSE 4021

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '4021') + '/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["pnpm", "-C", "apps/server", "start"]
