#!/bin/sh
set -eu

envsubst '${VITE_CLERK_PUBLISHABLE_KEY} ${VITE_STRIPE_PUBLISHABLE_KEY}' \
  < /etc/nginx/templates/env.js.template \
  > /usr/share/nginx/html/env.js
