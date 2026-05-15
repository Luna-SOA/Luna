FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json ./
COPY backend/gateway/package.json backend/gateway/package.json
COPY backend/services/chat-service/package.json backend/services/chat-service/package.json
COPY backend/services/model-service/package.json backend/services/model-service/package.json
COPY backend/services/activity-service/package.json backend/services/activity-service/package.json
COPY frontend/web/package.json frontend/web/package.json
RUN npm ci

FROM deps AS builder
COPY . .
RUN npm run build

FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY backend/gateway/package.json backend/gateway/package.json
COPY backend/services/chat-service/package.json backend/services/chat-service/package.json
COPY backend/services/model-service/package.json backend/services/model-service/package.json
COPY backend/services/activity-service/package.json backend/services/activity-service/package.json
COPY frontend/web/package.json frontend/web/package.json
RUN npm ci --omit=dev

FROM base AS runner
ENV NODE_ENV=production
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs appuser
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY railway-start.sh /usr/local/bin/railway-start.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /usr/local/bin/railway-start.sh

COPY --from=prod-deps --chown=appuser:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:nodejs /app/backend/proto ./backend/proto
COPY --from=builder --chown=appuser:nodejs /app/backend/gateway/dist ./backend/gateway/dist
COPY --from=builder --chown=appuser:nodejs /app/backend/services/chat-service/dist ./backend/services/chat-service/dist
COPY --from=builder --chown=appuser:nodejs /app/backend/services/model-service/dist ./backend/services/model-service/dist
COPY --from=builder --chown=appuser:nodejs /app/backend/services/activity-service/dist ./backend/services/activity-service/dist
COPY --from=builder --chown=appuser:nodejs /app/frontend/web/.next/standalone ./frontend/web/.next/standalone
COPY --from=builder --chown=appuser:nodejs /app/frontend/web/.next/static ./frontend/web/.next/standalone/frontend/web/.next/static
COPY --from=builder --chown=appuser:nodejs /app/frontend/web/public ./frontend/web/.next/standalone/frontend/web/public

ENTRYPOINT ["docker-entrypoint.sh"]
EXPOSE 3000 8080 4102 4103 4104 5102 5103 5104

CMD ["railway-start.sh"]
