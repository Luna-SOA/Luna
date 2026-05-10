#!/bin/sh
set -e

if [ "$(id -u)" = "0" ]; then
  if [ -d /data ]; then
    chown -R appuser:nodejs /data 2>/dev/null || true
  fi
  exec runuser -u appuser -- "$@"
fi

exec "$@"
