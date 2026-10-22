/**
 * #1737 — the embeddable chat widget, served as one dependency-free script.
 *
 *   <script async src="https://API/api/public/webchat/widget.js"
 *           data-token="<embed token>"></script>
 *
 * Design notes:
 *  - Renders inside a Shadow DOM so the host page's CSS cannot break it and it
 *    cannot restyle the host page.
 *  - Requests are `Content-Type: text/plain` JSON POSTs: a "simple" CORS
 *    request, so no preflight is needed and the API's per-tenant allowed-origin
 *    check is the only gate. The script holds no secrets — the embed token is a
 *    public id.
 *  - Optional bot-protection: a site that uses Turnstile can supply the
 *    challenge token through `window.serviceosWebchatBotToken` (a function
 *    returning a string or Promise<string>).
 *  - Touch-friendly: every control is at least 44px tall, the input is 16px
 *    (no iOS zoom), and the panel is full-screen below 480px.
 */
export const WIDGET_SCRIPT = String.raw`(function () {
  'use strict';
  if (window.__serviceosWebchat) return;
  var script = document.currentScript;
  if (!script) return;
  var token = script.getAttribute('data-token');
  if (!token) return;
  window.__serviceosWebchat = true;
  var base = new URL(script.src).origin + '/api/public/webchat';
  var state = { sessionId: null, bookingUrl: null, max: 500, busy: false, capped: false };

  function post(path, body) {
    return fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(Object.assign({ token: token }, body)),
      keepalive: path === '/end',
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok) { var e = new Error(json.message || 'Request failed'); e.status = res.status; throw e; }
        return json;
      });
    });
  }

  var host = document.createElement('div');
  host.setAttribute('data-serviceos-webchat', '');
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '*{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}' +
    '.fab{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:56px;height:56px;border-radius:28px;border:0;background:#0f172a;color:#fff;font-size:24px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.25)}' +
    '.panel{position:fixed;right:16px;bottom:84px;z-index:2147483000;width:360px;max-width:calc(100vw - 32px);height:520px;max-height:calc(100vh - 100px);background:#fff;color:#0f172a;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.28);display:none;flex-direction:column;overflow:hidden}' +
    '.panel.open{display:flex}' +
    '@media(max-width:480px){.panel{inset:0;right:0;bottom:0;width:100vw;max-width:100vw;height:100%;max-height:100%;border-radius:0}}' +
    '.head{display:flex;align-items:center;justify-content:space-between;padding:8px 8px 8px 16px;background:#0f172a;color:#fff;font-weight:600}' +
    '.head button{min-height:44px;min-width:44px;background:none;border:0;color:#fff;font-size:20px;cursor:pointer}' +
    '.log{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f8fafc}' +
    '.msg{max-width:85%;padding:8px 12px;border-radius:12px;font-size:15px;line-height:1.35;white-space:pre-wrap;word-break:break-word}' +
    '.msg.bot{background:#fff;border:1px solid #e2e8f0;align-self:flex-start}' +
    '.msg.me{background:#0f172a;color:#fff;align-self:flex-end}' +
    '.row{display:flex;gap:8px;padding:8px;border-top:1px solid #e2e8f0;background:#fff}' +
    '.row input,.form input,.form textarea{flex:1;min-height:44px;font-size:16px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;width:100%}' +
    '.btn{min-height:44px;min-width:44px;padding:0 16px;border:0;border-radius:8px;background:#0f172a;color:#fff;font-size:15px;cursor:pointer}' +
    '.btn.alt{background:#fff;color:#0f172a;border:1px solid #cbd5e1}' +
    '.btn:disabled{opacity:.5;cursor:default}' +
    '.links{display:flex;gap:8px;padding:0 8px 8px;background:#fff}' +
    '.links .btn{flex:1;display:flex;align-items:center;justify-content:center;text-decoration:none;font-size:14px}' +
    '.form{display:none;flex-direction:column;gap:8px;padding:12px;background:#fff;border-top:1px solid #e2e8f0;overflow-y:auto;max-height:60%}' +
    '.form.open{display:flex}' +
    '.form label.chk{display:flex;align-items:center;gap:8px;min-height:44px;font-size:14px}' +
    '.form label.chk input{flex:none;width:20px;min-height:20px}' +
    '.note{font-size:12px;color:#64748b;padding:0 12px 8px;background:#fff}' +
    '</style>' +
    '<button class="fab" aria-label="Open chat" type="button">&#128172;</button>' +
    '<section class="panel" role="dialog" aria-label="Chat">' +
    '<div class="head"><span class="title">Chat</span><button class="close" aria-label="Close chat" type="button">&#10005;</button></div>' +
    '<div class="log" aria-live="polite"></div>' +
    '<form class="form" novalidate>' +
    '<input name="name" placeholder="Your name" autocomplete="name" aria-label="Your name">' +
    '<input name="phone" type="tel" placeholder="Phone" autocomplete="tel" aria-label="Phone">' +
    '<input name="email" type="email" placeholder="Email" autocomplete="email" aria-label="Email">' +
    '<textarea name="note" rows="2" placeholder="Anything we should know?" aria-label="Note"></textarea>' +
    '<label class="chk"><input name="owner" type="checkbox"> Ask the owner to contact me</label>' +
    '<button class="btn" type="submit">Send my details</button>' +
    '</form>' +
    '<form class="row chat"><input name="text" placeholder="Type a message" autocomplete="off" aria-label="Message">' +
    '<button class="btn" type="submit">Send</button></form>' +
    '<div class="links"><button class="btn alt details" type="button">Leave details</button>' +
    '<a class="btn alt book" target="_blank" rel="noopener" style="display:none">Book online</a></div>' +
    '<div class="note">Automated assistant. Do not share card numbers.</div>' +
    '</section>';
  var q = function (s) { return root.querySelector(s); };
  var fab = q('.fab'), panel = q('.panel'), log = q('.log'), chat = q('.chat'),
      form = q('.form'), book = q('.book');

  function add(who, text) {
    var d = document.createElement('div');
    d.className = 'msg ' + who;
    d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }
  function setBusy(b) { state.busy = b; chat.querySelector('button').disabled = b || state.capped; }

  function botToken() {
    var fn = window.serviceosWebchatBotToken;
    if (typeof fn !== 'function') return Promise.resolve(undefined);
    return Promise.resolve().then(fn).catch(function () { return undefined; });
  }

  function start() {
    if (state.sessionId || state.starting) return;
    state.starting = true;
    botToken().then(function (bot) {
      return post('/session', { botToken: bot });
    }).then(function (s) {
      state.sessionId = s.sessionId; state.bookingUrl = s.bookingUrl; state.max = s.maxMessageChars || 500;
      q('.title').textContent = s.businessName || 'Chat';
      chat.elements.text.maxLength = state.max;
      if (s.bookingUrl) { book.href = s.bookingUrl; book.style.display = 'flex'; }
      add('bot', s.greeting);
    }).catch(function () {
      add('bot', 'Chat is not available right now. Please call us instead.');
      chat.style.display = 'none';
    }).then(function () { state.starting = false; });
  }

  function toggle(open) {
    panel.classList.toggle('open', open);
    fab.style.display = open && window.innerWidth <= 480 ? 'none' : 'block';
    if (open) start();
  }
  fab.addEventListener('click', function () { toggle(true); });
  q('.close').addEventListener('click', function () { toggle(false); });
  q('.details').addEventListener('click', function () { form.classList.toggle('open'); });

  chat.addEventListener('submit', function (e) {
    e.preventDefault();
    var input = chat.elements.text, text = input.value.trim();
    if (!text || state.busy || !state.sessionId) return;
    input.value = ''; add('me', text); setBusy(true);
    post('/message', { sessionId: state.sessionId, text: text }).then(function (r) {
      (r.replies || []).forEach(function (t) { add('bot', t); });
      if (r.capped) { state.capped = true; form.classList.add('open'); }
      if (r.escalated) form.classList.add('open');
    }).catch(function (err) {
      add('bot', err.status === 429 ? 'One moment, please slow down a little.' : 'Sorry, something went wrong. You can leave your details instead.');
    }).then(function () { setBusy(false); });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = form.elements;
    if (!state.sessionId) return;
    if (!f.phone.value.trim() && !f.email.value.trim()) { add('bot', 'Please add a phone number or email so we can reach you.'); return; }
    post('/handoff', {
      sessionId: state.sessionId, name: f.name.value, phone: f.phone.value, email: f.email.value,
      note: f.note.value, requestOwner: f.owner.checked,
    }).then(function () {
      add('bot', 'Thanks! We have your details and will be in touch.');
      form.classList.remove('open');
    }).catch(function () { add('bot', 'Sorry, we could not save your details. Please call us.'); });
  });

  window.addEventListener('pagehide', function () {
    if (state.sessionId) post('/end', { sessionId: state.sessionId }).catch(function () {});
  });

  document.body.appendChild(host);
})();
`;
