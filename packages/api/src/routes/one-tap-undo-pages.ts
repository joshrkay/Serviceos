/**
 * D-015 — the one-tap UNDO confirm page (GET / HEAD on the undo link).
 *
 * Dependency-free so the 320px Playwright viewport test renders the exact
 * HTML the route serves (e2e/one-tap-undo-confirm-mobile.spec.ts).
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The interstitial: the button POSTs the same token. ≥44px tap target, and
 * a long unbroken customer name wraps instead of overflowing a 320px screen.
 */
export function undoConfirmPage(description: string, token: string, action: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Undo this booking?</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:48px 24px;text-align:center;color:#111}
h1{font-size:1.4rem}p{color:#555;overflow-wrap:anywhere}
button{min-height:44px;padding:12px 32px;font-size:1rem;border:0;border-radius:8px;
background:#111;color:#fff;cursor:pointer}</style></head>
<body><h1>Undo this booking?</h1>
<p>${escapeHtml(description)}</p>
<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<button type="submit">Undo booking</button>
</form></body></html>`;
}
