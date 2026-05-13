#!/bin/sh
set -e

# Render nginx config from template
envsubst '${PORT} ${API_URL}' \
  < /etc/nginx/templates/default.conf.template \
    > /etc/nginx/conf.d/default.conf

    # Render frontend runtime config
    envsubst '${VITE_CLERK_PUBLISHABLE_KEY} ${VITE_STRIPE_PUBLISHABLE_KEY}' \
      < /etc/nginx/templates/env.js.template \
        > /usr/share/nginx/html/env.js

        # Start nginx in foreground
        exec nginx -g 'daemon off;'
