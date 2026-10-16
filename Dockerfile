FROM node:24.22.0-bookworm-slim AS build
WORKDIR /source
RUN npm install --global pnpm@12.11.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY packages/client/package.json packages/client/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
RUN pnpm --filter @kanvil/server deploy --prod --no-optional --legacy /runtime/server

FROM node:24.22.0-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=5180
ARG KANVIL_VERSION=0.0.0
ARG KANVIL_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/MaudeCode/kanvil" \
      org.opencontainers.image.version=$KANVIL_VERSION \
      org.opencontainers.image.revision=$KANVIL_REVISION
WORKDIR /app/apps/server
COPY --from=build --chown=node:node /runtime/server ./
COPY --from=build --chown=node:node /source/apps/web/dist /app/apps/web/dist
COPY --chown=node:node LICENSE /app/LICENSE
USER node
EXPOSE 5180
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz',{signal:AbortSignal.timeout(2500)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/index.mjs"]
