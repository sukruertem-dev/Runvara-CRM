# Builds one Node service of the monorepo (api or worker) into a minimal runtime image.
#   docker build -f infra/docker/node-app.Dockerfile --build-arg APP=api .
ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS build
ARG APP
RUN npm install -g pnpm@10.34.9
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/${APP} ./apps/${APP}
COPY docs/enterprise/permission-matrix.yaml ./docs/enterprise/permission-matrix.yaml
RUN pnpm install --frozen-lockfile --filter "@runvara/${APP}..." --ignore-scripts=false
RUN pnpm exec turbo run build --filter="@runvara/${APP}..."
RUN pnpm --filter "@runvara/${APP}" deploy --legacy --prod /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache wget && addgroup -S runvara && adduser -S runvara -G runvara
COPY --from=build --chown=runvara:runvara /out ./
USER runvara
CMD ["node", "--enable-source-maps", "dist/main.js"]
