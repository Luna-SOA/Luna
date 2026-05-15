#!/bin/sh
set -e

target="${SERVICE_NAME:-${RAILWAY_SERVICE_NAME:-api-gateway}}"

case "$target" in
  web-gateway)
    export API_GATEWAY_PORT="${API_GATEWAY_PORT:-8080}"
    node backend/gateway/dist/index.js &
    gateway_pid="$!"
    trap 'kill "$gateway_pid" 2>/dev/null || true' INT TERM EXIT
    export HOSTNAME="${HOSTNAME:-0.0.0.0}"
    export PORT="${PORT:-3000}"
    node frontend/web/.next/standalone/frontend/web/server.js
    status="$?"
    kill "$gateway_pid" 2>/dev/null || true
    exit "$status"
    ;;
  web)
    export HOSTNAME="${HOSTNAME:-0.0.0.0}"
    export PORT="${PORT:-3000}"
    exec node frontend/web/.next/standalone/frontend/web/server.js
    ;;
  api-gateway|gateway)
    exec node backend/gateway/dist/index.js
    ;;
  chat-service|chat)
    exec node backend/services/chat-service/dist/index.js
    ;;
  model-service|model)
    exec node backend/services/model-service/dist/index.js
    ;;
  activity-service|activity)
    exec node backend/services/activity-service/dist/index.js
    ;;
  *)
    echo "Unknown SERVICE_NAME: $target" >&2
    echo "Expected one of: web, api-gateway, chat-service, model-service, activity-service" >&2
    exit 1
    ;;
esac
