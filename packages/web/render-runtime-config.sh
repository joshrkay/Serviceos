#!/bin/sh
set -eu

envsubst '${VITE_CLERK_PUBLISHABLE_KEY} ${VITE_STRIPE_PUBLISHABLE_KEY} ${VITE_ONBOARDING_V2_ENABLED}' \
  < /etc/nginx/templates/env.js.template \
  > /usr/share/nginx/html/env.js
