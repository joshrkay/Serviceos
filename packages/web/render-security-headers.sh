#!/bin/sh
# #1481 — add the API's public origin to the CSP connect-src.
#
# On a deployed environment without S3 credentials the API's dev storage
# provider presigns uploads on its own public host
# (${PUBLIC_API_URL}/storage-dev/...), which is a different origin from this
# web edge, so the browser PUT needs connect-src to allow it. API_URL is the
# API's public URL (the /api proxy target in nginx.conf.template). Only its
# scheme://host[:port] origin is added — never a wildcard.
#
# Usage: render-security-headers.sh /etc/nginx/security-headers.conf
set -eu

conf="$1"
api_url="${API_URL:-}"

origin=$(printf '%s' "$api_url" | sed -n -E 's|^(https?://[^/?#]+).*$|\1|p')
if [ -z "$origin" ]; then
  echo "render-security-headers: API_URL is not an http(s) URL; connect-src unchanged" >&2
  exit 0
fi

# Idempotent across container restarts.
if grep -q "connect-src 'self' $origin[ ;]" "$conf"; then
  exit 0
fi

tmp="$conf.tmp"
sed "s#connect-src 'self'#connect-src 'self' $origin#" "$conf" > "$tmp"
mv "$tmp" "$conf"
