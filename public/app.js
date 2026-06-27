/* global state */
let currentTokenId = null;
let currentSSE = null;
let requestCount = 0;
let selectedRequestId = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function methodClass(m) {
  const map = { GET: 'm-get', POST: 'm-post', PUT: 'm-put', PATCH: 'm-patch', DELETE: 'm-delete' };
  return map[m.toUpperCase()] || 'm-other';
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5)   return 'just now';
  if (s < 60)  return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function formatTs(ts) {
  return new Date(ts).toLocaleString();
}

function tryJSON(str) {
  try { return JSON.stringify(JSON.parse(str), null, 2); } catch { return str; }
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (res.status === 401) { location.href = '/login'; return null; }
  return res.json();
}

// ── Token List ────────────────────────────────────────────────────────────────

async function loadTokens() {
  const tokens = await api('GET', '/api/tokens');
  renderTokenList(tokens);
  return tokens;
}

function renderTokenList(tokens) {
  const el = document.getElementById('token-list');
  if (tokens.length === 0) {
    el.innerHTML = '<p class="sidebar-empty">No webhooks yet.<br>Click "+ New" to create one.</p>';
    return;
  }
  el.innerHTML = tokens.map(t => `
    <div class="token-item ${t.id === currentTokenId ? 'active' : ''}" data-id="${t.id}">
      <span class="token-item-id">${t.id.slice(0, 8)}…</span>
    </div>
  `).join('');
  el.querySelectorAll('.token-item').forEach(item => {
    item.addEventListener('click', () => selectToken(item.dataset.id));
  });
}

// ── Select / Deselect Token ───────────────────────────────────────────────────

async function selectToken(id) {
  currentTokenId = id;
  selectedRequestId = null;

  document.getElementById('welcome-screen').style.display = 'none';
  const detail = document.getElementById('token-detail');
  detail.style.display = 'flex';

  const [token, requests] = await Promise.all([
    api('GET', `/api/tokens/${id}`),
    api('GET', `/api/tokens/${id}/requests`),
  ]);

  document.getElementById('token-url-text').textContent = `${location.origin}/hook/${id}`;
  document.getElementById('forward-url-input').value = token.forward_url || '';

  renderRequestList(requests);
  connectSSE(id);
  refreshTokenList();
  showDetailEmpty();
}

async function refreshTokenList() {
  const tokens = await api('GET', '/api/tokens');
  renderTokenList(tokens);
}

// ── Request List ──────────────────────────────────────────────────────────────

function renderRequestList(requests) {
  requestCount = requests.length;
  updateCountBadge();

  const el = document.getElementById('request-list');
  if (requests.length === 0) {
    el.innerHTML = '<div class="list-empty"><span class="dot"></span>Waiting for requests…</div>';
    return;
  }
  el.innerHTML = requests.map(r => requestItemHtml(r)).join('');
  el.querySelectorAll('.request-item').forEach(item => {
    item.addEventListener('click', () => showRequestDetail(JSON.parse(item.dataset.req)));
  });
}

function requestItemHtml(r) {
  const pathDisplay = r.path.length > 40 ? r.path.slice(0, 40) + '…' : r.path;
  return `<div class="request-item ${r.id === selectedRequestId ? 'active' : ''}" data-id="${r.id}" data-req='${JSON.stringify(r).replace(/'/g, '&#39;')}'>
    <span class="method-badge ${methodClass(r.method)}">${escHtml(r.method)}</span>
    <div class="request-meta">
      <div class="request-path">${escHtml(pathDisplay)}</div>
      <div class="request-time">${timeAgo(r.received_at)} · ${escHtml(r.ip || '—')}</div>
    </div>
  </div>`;
}

function prependRequest(r) {
  const list = document.getElementById('request-list');
  const empty = list.querySelector('.list-empty');
  if (empty) list.innerHTML = '';

  const div = document.createElement('div');
  div.innerHTML = requestItemHtml(r);
  const item = div.firstElementChild;
  item.addEventListener('click', () => showRequestDetail(r));
  list.insertBefore(item, list.firstChild);

  requestCount++;
  updateCountBadge();
}

function updateCountBadge() {
  document.getElementById('requests-count-num').textContent = requestCount;
}

// ── Request Detail ────────────────────────────────────────────────────────────

function showDetailEmpty() {
  document.getElementById('detail-empty').style.display = 'flex';
  document.getElementById('request-detail').style.display = 'none';
}

function showRequestDetail(r) {
  selectedRequestId = r.id;

  document.querySelectorAll('.request-item').forEach(el => {
    el.classList.toggle('active', Number(el.dataset.id) === r.id);
  });

  const headers = typeof r.headers === 'string' ? JSON.parse(r.headers) : r.headers;
  const query   = typeof r.query   === 'string' ? JSON.parse(r.query)   : r.query;

  const headerRows = Object.entries(headers)
    .map(([k, v]) => `<tr><td>${escHtml(k)}</td><td>${escHtml(String(v))}</td></tr>`)
    .join('');

  const queryKeys = Object.keys(query);
  const querySection = queryKeys.length > 0
    ? `<div class="detail-row">
        <div class="detail-label">Query Params</div>
        <table class="kv-table">${
          queryKeys.map(k => `<tr><td>${escHtml(k)}</td><td>${escHtml(String(query[k]))}</td></tr>`).join('')
        }</table>
       </div>`
    : '';

  const bodyHtml = r.body
    ? `<div class="detail-row">
        <div class="detail-label">Body</div>
        <div class="code-block">${escHtml(tryJSON(r.body))}</div>
       </div>`
    : '<div class="detail-row"><div class="detail-label">Body</div><span style="color:var(--muted);font-size:12px;">— empty —</span></div>';

  document.getElementById('detail-empty').style.display = 'none';
  const el = document.getElementById('request-detail');
  el.style.display = 'block';
  el.innerHTML = `
    <div class="detail-row">
      <div class="detail-method-path">
        <span class="method-badge ${methodClass(r.method)}" style="font-size:12px;padding:3px 7px">${escHtml(r.method)}</span>
        <span class="detail-path">${escHtml(r.path)}</span>
      </div>
    </div>
    <div class="detail-row">
      <div class="detail-info-grid">
        <span class="detail-info-key">Received</span><span class="detail-info-val">${formatTs(r.received_at)}</span>
        <span class="detail-info-key">From IP</span><span class="detail-info-val">${escHtml(r.ip || '—')}</span>
        <span class="detail-info-key">Request ID</span><span class="detail-info-val">#${r.id}</span>
      </div>
    </div>
    ${querySection}
    <div class="detail-row">
      <div class="detail-label">Headers</div>
      <table class="kv-table">${headerRows}</table>
    </div>
    ${bodyHtml}
  `;
}

// ── SSE ───────────────────────────────────────────────────────────────────────

function connectSSE(tokenId) {
  if (currentSSE) { currentSSE.close(); currentSSE = null; }

  const dot = document.getElementById('sse-dot');
  dot.className = 'sse-dot';

  const sse = new EventSource(`/api/tokens/${tokenId}/stream`);
  currentSSE = sse;

  sse.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'connected') {
      dot.className = 'sse-dot connected';
    } else if (data.type === 'request' && data.token_id === currentTokenId) {
      prependRequest(data);
      maybeNotify(data);
    } else if (data.type === 'cleared') {
      requestCount = 0;
      updateCountBadge();
      document.getElementById('request-list').innerHTML =
        '<div class="list-empty"><span class="dot"></span>Waiting for requests…</div>';
      showDetailEmpty();
    }
  };

  sse.onerror = () => {
    dot.className = 'sse-dot';
    sse.close();
    if (currentSSE === sse) {
      setTimeout(() => { if (currentTokenId === tokenId) connectSSE(tokenId); }, 3000);
    }
  };
}

// ── Notifications ─────────────────────────────────────────────────────────────

let notifyEnabled = localStorage.getItem('notify') === 'true';

function updateNotifyBtn() {
  const btn = document.getElementById('btn-notify');
  if (!('Notification' in window)) {
    btn.textContent = '🔕 N/A';
    btn.disabled = true;
    btn.classList.add('btn-notify-blocked');
    return;
  }
  if (Notification.permission === 'denied') {
    btn.textContent = '🔕 Blocked';
    btn.disabled = true;
    btn.className = 'btn btn-sm btn-notify-blocked';
    btn.title = 'Notifications blocked by browser. Allow in browser settings to enable.';
    return;
  }
  btn.disabled = false;
  if (notifyEnabled && Notification.permission === 'granted') {
    btn.textContent = '🔔 Notify: On';
    btn.className = 'btn btn-sm btn-notify-on';
    btn.title = 'Click to disable desktop notifications';
  } else {
    btn.textContent = '🔔 Notify: Off';
    btn.className = 'btn btn-sm';
    btn.title = 'Click to enable desktop notifications';
  }
}

async function toggleNotify() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'denied') return;

  if (Notification.permission === 'default') {
    const perm = await Notification.requestPermission();
    notifyEnabled = perm === 'granted';
  } else {
    notifyEnabled = !notifyEnabled;
  }

  localStorage.setItem('notify', notifyEnabled);
  updateNotifyBtn();

  if (notifyEnabled) {
    new Notification('my-webhook', { body: 'Notifications enabled. You will be alerted on new requests.', tag: 'wh-meta' });
  }
}

function maybeNotify(r) {
  if (!notifyEnabled || Notification.permission !== 'granted') return;
  const body = `${r.method}  ${r.path}\nFrom: ${r.ip || '—'}`;
  const n = new Notification('New webhook request', { body, tag: 'wh-request', renotify: true });
  n.onclick = () => { window.focus(); n.close(); };
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function createToken() {
  const data = await api('POST', '/api/tokens');
  await refreshTokenList();
  await selectToken(data.id);
}

document.getElementById('btn-notify').addEventListener('click', toggleNotify);
updateNotifyBtn();

document.getElementById('btn-new-token').addEventListener('click', createToken);
document.getElementById('btn-new-token-welcome').addEventListener('click', createToken);

document.getElementById('btn-copy-url').addEventListener('click', () => {
  const url = document.getElementById('token-url-text').textContent;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById('btn-copy-url');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
});

document.getElementById('btn-save-forward').addEventListener('click', async () => {
  if (!currentTokenId) return;
  const url = document.getElementById('forward-url-input').value.trim() || null;
  await api('PATCH', `/api/tokens/${currentTokenId}`, { forward_url: url });
  const btn = document.getElementById('btn-save-forward');
  btn.textContent = 'Saved!';
  setTimeout(() => { btn.textContent = 'Save'; }, 1500);
});

document.getElementById('btn-clear').addEventListener('click', async () => {
  if (!currentTokenId) return;
  if (!confirm('Clear all requests for this webhook?')) return;
  await api('DELETE', `/api/tokens/${currentTokenId}/requests`);
});

document.getElementById('btn-delete-token').addEventListener('click', async () => {
  if (!currentTokenId) return;
  if (!confirm('Delete this webhook and all its requests? This cannot be undone.')) return;
  await api('DELETE', `/api/tokens/${currentTokenId}`);
  currentTokenId = null;
  if (currentSSE) { currentSSE.close(); currentSSE = null; }
  document.getElementById('token-detail').style.display = 'none';
  document.getElementById('welcome-screen').style.display = 'flex';
  showDetailEmpty();
  await refreshTokenList();
});

// ── Init ──────────────────────────────────────────────────────────────────────

(async () => {
  const [me, tokens] = await Promise.all([
    api('GET', '/api/me'),
    loadTokens(),
  ]);
  if (me) {
    document.getElementById('user-display').innerHTML = `Logged in as <strong>${escHtml(me.username)}</strong>`;
  }
  if (tokens && tokens.length > 0) {
    await selectToken(tokens[0].id);
  }
})();
