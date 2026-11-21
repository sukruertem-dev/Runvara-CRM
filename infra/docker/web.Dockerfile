# Next.js standalone build of apps/web.
ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS build
RUN npm install -g pnpm@10.34.9
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1
# Dependencies first (lockfile-only layer, reused across source changes and CI runs).
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch --frozen-lockfile
COPY package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
COPY docs/enterprise/permission-matrix.yaml ./docs/enterprise/permission-matrix.yaml
RUN pnpm install --frozen-lockfile --offline --filter "@flexa/web..."
# API_INTERNAL_URL is read by next.config rewrites at build time and baked into the routes manifest.
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=${API_INTERNAL_URL}
RUN pnpm exec turbo run build --filter="@flexa/web..."

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN apk add --no-cache wget && addgroup -S flexa && adduser -S flexa -G flexa
COPY --from=build --chown=flexa:flexa /repo/apps/web/.next/standalone ./
COPY --from=build --chown=flexa:flexa /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=flexa:flexa /repo/apps/web/public ./apps/web/public
USER flexa
CMD ["node", "apps/web/server.js"]
