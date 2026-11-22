# Game server (apps/server) for Railway or any container host. Build from my-project/.
FROM node:22-slim
WORKDIR /app

# manifests first, so dependency layers are cached between code changes
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/chain/package.json packages/chain/
COPY apps/server/package.json apps/server/
RUN npm ci -w apps/server -w packages/chain -w packages/protocol --include-workspace-root=false --no-audit --no-fund

COPY packages/protocol packages/protocol
COPY packages/chain packages/chain
COPY apps/server apps/server

ENV NODE_ENV=production \
    TRUST_PROXY=1
WORKDIR /app/apps/server
# tsx runs the TypeScript sources of the server and the shared packages directly
CMD ["npx", "tsx", "src/main.ts"]
