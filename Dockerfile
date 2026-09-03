FROM node:20-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM dependencies AS tests

COPY package.json package-lock.json app.mjs app.test.mjs asset-liability-analysis.mjs asset-liability-analysis.test.mjs permission-center.test.mjs platform-auth.mjs platform-auth.test.mjs Dockerfile ./
COPY public ./public
COPY data/raw-reports-demo.json ./data/raw-reports-demo.json
COPY deploy ./deploy
RUN npm test

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
ARG APP_UID=20117
ARG APP_GID=20117
WORKDIR /app

RUN groupadd --gid ${APP_GID} financeapp \
  && useradd --uid ${APP_UID} --gid ${APP_GID} --no-create-home --no-log-init --shell /usr/sbin/nologin financeapp

COPY --from=dependencies /app/node_modules ./node_modules
COPY --chown=${APP_UID}:${APP_GID} package.json package-lock.json app.mjs asset-liability-analysis.mjs platform-auth.mjs ./
COPY --chown=${APP_UID}:${APP_GID} public ./public
COPY --chown=${APP_UID}:${APP_GID} deploy/database-summary.mjs deploy/backup-database.mjs ./deploy/

USER ${APP_UID}:${APP_GID}
EXPOSE 3180
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3180/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "app.mjs"]
