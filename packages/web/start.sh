#!/bin/sh
set -eu

# Keep log ordering deterministic in container log aggregators.
exec 2>&1

echo "=== DEBUG: PORT=${PORT} API_URL=${API_URL} ==="

# Render nginx config from template
envsubst '${PORT} ${API_URL}' \
  < /etc/nginx/templates/default.conf.template \
    > /etc/nginx/conf.d/default.conf

    echo "=== RENDERED NGINX CONFIG ==="
    cat /etc/nginx/conf.d/default.conf
    echo "=== END CONFIG ==="

    # Validate nginx config
    nginx -t

    # Render frontend runtime config. PostHog vars are optional — empty
    # values render as empty strings which `lib/analytics.ts` treats as
    # "not configured" (every track() call becomes a no-op), so deploys
    # without an analytics key behave identically to today.
    envsubst '${VITE_CLERK_PUBLISHABLE_KEY} ${VITE_STRIPE_PUBLISHABLE_KEY} ${VITE_ONBOARDING_V2_ENABLED} ${VITE_POSTHOG_KEY} ${VITE_POSTHOG_HOST}' \
      < /etc/nginx/templates/env.js.template \
        > /usr/share/nginx/html/env.js

        # Start nginx in foreground
        exec nginx -g 'daemon off;'
