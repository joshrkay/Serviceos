#!/bin/sh
set -e

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

    # Render frontend runtime config
    envsubst '${VITE_CLERK_PUBLISHABLE_KEY} ${VITE_STRIPE_PUBLISHABLE_KEY} ${VITE_ONBOARDING_V2_ENABLED}' \
      < /etc/nginx/templates/env.js.template \
        > /usr/share/nginx/html/env.js

        # Start nginx in foreground
        exec nginx -g 'daemon off;'
