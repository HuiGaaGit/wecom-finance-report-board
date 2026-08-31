FROM node:20-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM dependencies AS tests

COPY package.json package-lock.json app.mjs app.test.mjs platform-auth.mjs platform-auth.test.mjs ./
COPY public ./public
COPY data/raw-reports-demo.json ./data/raw-reports-demo.json
COPY deploy/check-readiness.mjs deploy/.env.production.example ./deploy/
RUN npm test

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json app.mjs platform-auth.mjs ./
COPY --chown=node:node public ./public
COPY --chown=node:node deploy/database-summary.mjs deploy/backup-database.mjs ./deploy/

USER node
EXPOSE 3180
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3180/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "app.mjs"]
