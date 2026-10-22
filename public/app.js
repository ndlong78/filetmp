// Temp Text Store — client. Plain script (no build step); config in config.js.
(() => {
  const DB_NAME = 'tempTextStore';
  const STORE = 'notes';
  const LEGACY_KEY = 'tempTextStore.v1'; // v1 used localStorage (~5 MB cap)
  const MAX_TTL_MIN = 60;
  const PREVIEW_CHARS = 20000; // render cap; full text via Copy / Tải .txt
  const MAX_LINK_CHARS = 2000000; // Chrome URL cap ~2 MB
  // config.js: TEMP_TEXT_API = '' -> same origin (default), URL -> that server, false -> local only
  const API = window.TEMP_TEXT_API === false ? ''
    : String(window.TEMP_TEXT_API || location.origin).replace(/\/+$/, '');
  const EMBED = window.TEMP_TEXT_EMBED === true; // plaintext-in-URL links: off unless enabled
  const $ = (id) => document.getElementById(id);

  // ---- share codec: gzip(JSON) -> [AES-GCM] -> base64url ----
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const pipe = async (bytes, stream) =>
    new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
  const gzip = (b) => pipe(b, new CompressionStream('gzip'));
  const gunzip = (b) => pipe(b, new DecompressionStream('gzip'));
  function b64u(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64u(str) {
    const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const pack = (n) => gzip(enc.encode(JSON.stringify({ t: n.title, c: n.content, a: n.createdAt, e: n.expiresAt })));
  async function unpack(bytes) {
    const o = JSON.parse(dec.decode(await gunzip(bytes)));
    return { title: o.t || '', content: String(o.c), createdAt: o.a, expiresAt: o.e };
  }
  // key omitted -> fresh one-off key, returned as base64url for the link
  async function encrypt(bytes, key) {
    const own = !key;
    if (own) key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv);
    out.set(ct, 12);
    return { blob: out, key: own ? b64u(new Uint8Array(await crypto.subtle.exportKey('raw', key))) : null };
  }
  async function decrypt(buf, key) {
    if (typeof key === 'string') key = await crypto.subtle.importKey('raw', unb64u(key), 'AES-GCM', false, ['decrypt']);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(0, 12) }, key, buf.subarray(12)));
  }
  const pageUrl = () => location.origin + location.pathname;
  const randHex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');

  async function shareToServer(n) {
    const { blob, key } = await encrypt(await pack(n));
    const ttl = Math.ceil((n.expiresAt - Date.now()) / 1000);
    if (ttl < 60) throw new Error('Còn dưới 1 phút — không đủ để chia sẻ');
    const token = randHex(16);
    const res = await fetch(`${API}/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-TTL': String(ttl), 'X-Delete-Token': token },
      body: blob,
    });
    if (!res.ok) throw new Error(`Server trả ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const { id } = await res.json();
    return { kind: 'server', id, token, url: `${pageUrl()}#s=${id}.${key}` };
  }
  function unshareRemote(n) {
    if (!API || !n.share || n.share.kind !== 'server') return Promise.resolve();
    return fetch(`${API}/api/notes/${n.share.id}`, { method: 'DELETE', headers: { 'X-Delete-Token': n.share.token } })
      .catch(() => {}); // best-effort: KV TTL removes it anyway
  }
  async function embedLink(n) {
    const url = `${pageUrl()}#d=${b64u(await pack(n))}`;
    if (url.length > MAX_LINK_CHARS) {
      throw new Error(`Link nhúng quá dài (${fmtNum(url.length)} ký tự)` + (API ? ' — dùng Chia sẻ qua server' : ' — cần cấu hình Worker'));
    }
    return { kind: 'link', url };
  }

  // ---- sync code: same code on every browser -> same encrypted list on the server ----
  // PBKDF2(code) -> 512 bits: [0..32) AES-GCM key (stays in browser), [32..64) room id sent to server.
  // Server (Durable Object) is strongly consistent and assigns versions; pushes "changed" over WebSocket.
  const SYNC_KEY = 'tempTextStore.syncCode';
  const SYNC_FORMAT = 2; // bump when server-side storage changes; older synced marks are re-uploaded
  const SYNC_POLL_MS = 60000; // fallback only, while the WebSocket is down
  const SYNC_CODE_LEN = 20; // 100 bits
  const SYNC_CODE_MIN = 12;
  const SYNC_CODE_WEAK = 16;
  let sync = null; // { code, key, room }
  let syncQueue = Promise.resolve();
  let syncLast = 0;
  let syncError = '';
  let ws = null;
  let wsRetry = 0;
  let wsTimer = null;
  const pendingDeletes = new Set(); // ids deleted here but not yet confirmed by the server

  function newSyncCode() {
    const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32, 5 bits/char
    const s = Array.from(crypto.getRandomValues(new Uint8Array(SYNC_CODE_LEN)), (x) => A[x & 31]).join('');
    return s.match(/.{1,5}/g).join('-');
  }
  // generated codes are case/dash-insensitive; free-form passphrases are used as typed (trimmed)
  const normCode = (c) => (/^[0-9A-Za-z-]+$/.test(c.trim()) ? c.trim().toUpperCase().replace(/-/g, '') : c.trim());

  async function deriveSync(code) {
    const base = await crypto.subtle.importKey('raw', enc.encode(normCode(code)), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('filetmp-sync-v1'), iterations: 200000 }, base, 512));
    const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
    return { code, key, room: b64u(bits.slice(32)) };
  }

  const roomUrl = (id) => `${API}/api/rooms/${sync.room}${id ? '/' + encodeURIComponent(id) : ''}`;
  const isSynced = (n) => !!(n.synced && n.synced.f === SYNC_FORMAT && !n.dirty);

  // every server round-trip goes through one queue so a pull never races a push in this tab
  const enqueue = (fn) => (syncQueue = syncQueue.then(fn, fn));

  async function errorText(res) {
    const body = (await res.text()).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    return `Đồng bộ lỗi ${res.status}` + (body ? ` — ${body}` : '') +
      (res.status === 404 && !body ? ' (deploy thiếu worker script — xem wrangler.toml)' : '');
  }

  async function pushNote(n) {
    const ttl = Math.floor((n.expiresAt - Date.now()) / 1000);
    if (ttl < 60) return; // server minimum; expires locally soon anyway
    const { blob } = await encrypt(await pack(n), sync.key);
    const res = await fetch(roomUrl(n.id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'X-TTL': String(ttl) },
      body: blob,
    });
    if (!res.ok) throw new Error(await errorText(res));
    const { v } = await res.json();
    const cur = await store.get(n.id);
    if (!cur || cur.createdAt !== n.createdAt) return; // edited/deleted meanwhile; next pass handles it
    cur.synced = { f: SYNC_FORMAT, v, at: Date.now() };
    cur.dirty = false;
    await store.put(cur);
  }
  function pushSoon(n) {
    if (!sync) return;
    enqueue(async () => {
      try { await pushNote(n); syncError = ''; } catch (err) { syncError = err.message; }
      notify();
      await reload();
    });
  }
  function deleteRemote(n) {
    if (!sync || !n.synced) return;
    pendingDeletes.add(n.id);
    enqueue(() => fetch(roomUrl(n.id), { method: 'DELETE' }).catch(() => {}).finally(() => pendingDeletes.delete(n.id)));
  }

  // pull the list, fetch newer notes, drop remotely-deleted ones, push local changes
  async function syncOnce() {
    if (!sync) return;
    const room = sync.room;
    let changed = false;
    try {
      const started = Date.now();
      const res = await fetch(roomUrl(), { cache: 'no-store' });
      if (!res.ok) throw new Error(await errorText(res));
      const { notes: remote } = await res.json();
      if (!sync || sync.room !== room) return;
      const local = new Map((await store.all()).map((n) => [n.id, n]));
      const remoteIds = new Set(remote.map((e) => e.id));
      for (const e of remote) {
        if (pendingDeletes.has(e.id)) continue; // don't resurrect what we just deleted
        const n = local.get(e.id);
        if (n && (n.dirty || (isSynced(n) && n.synced.v >= e.v))) continue; // local edit wins / up to date
        const r = await fetch(roomUrl(e.id), { cache: 'no-store' });
        if (!r.ok) continue; // deleted or expired in between
        let note;
        try { note = await unpack(await decrypt(new Uint8Array(await r.arrayBuffer()), sync.key)); }
        catch { continue; } // not ours / corrupted
        const v = Number(r.headers.get('X-Version')) || e.v;
        Object.assign(note, { id: e.id, bytes: new Blob([note.content]).size, synced: { f: SYNC_FORMAT, v, at: Date.now() }, dirty: false });
        await store.put(note);
        local.set(e.id, note);
        changed = true;
      }
      const now = Date.now();
      for (const n of local.values()) {
        if (n.expiresAt <= now) continue;
        if (isSynced(n)) {
          // strongly consistent list: missing = deleted elsewhere (unless we learned of it after this pull began)
          if (!remoteIds.has(n.id) && n.synced.at < started) { await store.del([n.id]); changed = true; }
        } else {
          await pushNote(n);
          changed = true;
        }
      }
      syncLast = Date.now();
      syncError = '';
    } catch (err) {
      syncError = err.message || String(err);
    }
    if (changed) { notify(); await reload(); } else renderSync();
  }
  const syncNow = () => enqueue(syncOnce);

  function connectWs() {
    clearTimeout(wsTimer);
    if (!sync || !API || ws) return;
    const room = sync.room;
    const sock = new WebSocket(`${API.replace(/^http/, 'ws')}/api/rooms/${room}/ws`);
    ws = sock;
    sock.onopen = () => { wsRetry = 0; renderSync(); syncNow(); };
    sock.onmessage = (e) => { if (e.data !== 'pong') syncNow(); };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      renderSync();
      if (sync && sync.room === room) wsTimer = setTimeout(connectWs, Math.min(30000, 1000 * 2 ** wsRetry++));
    };
  }
  function closeWs() {
    clearTimeout(wsTimer);
    if (!ws) return;
    const sock = ws;
    ws = null;
    sock.onclose = null;
    sock.close();
  }
  const wsOpen = () => ws && ws.readyState === WebSocket.OPEN;

  function renderSync() {
    const on = !!sync;
    $('syncOff').hidden = on;
    $('syncOn').hidden = !on;
    if (!API) {
      $('syncCard').hidden = true;
      return;
    }
    if (!on) return;
    $('syncCodeShown').textContent = $('syncCodeShown').dataset.reveal ? sync.code : '•••••-•••••-•••••-•••••';
    const live = wsOpen() ? 'realtime' : `mất kết nối realtime, tự làm mới mỗi ${SYNC_POLL_MS / 1000}s`;
    $('syncStatus').textContent = syncError ? `⚠ ${syncError}`
      : syncLast ? `Đã đồng bộ lúc ${fmtTime(syncLast)} · ${live}`
      : 'Đang đồng bộ…';
  }

  async function connectSync(code, { quiet = false } = {}) {
    code = code.trim();
    if (normCode(code).length < SYNC_CODE_MIN) throw new Error(`Mã đồng bộ tối thiểu ${SYNC_CODE_MIN} ký tự — bấm Tạo mã`);
    if (!quiet && normCode(code).length < SYNC_CODE_WEAK &&
        !confirm(`Mã dưới ${SYNC_CODE_WEAK} ký tự dễ bị dò. Vẫn dùng? (khuyến nghị bấm Tạo mã)`)) return;
    $('syncConnect').disabled = true;
    try {
      closeWs();
      sync = await deriveSync(code);
      try { localStorage.setItem(SYNC_KEY, code); } catch { /* per-tab only */ }
    } finally {
      $('syncConnect').disabled = false;
    }
    syncLast = 0;
    syncError = '';
    renderSync();
    render();
    connectWs();
    await syncNow();
  }
  async function disconnectSync(wipe) {
    closeWs();
    sync = null;
    try { localStorage.removeItem(SYNC_KEY); } catch { /* ignore */ }
    if (wipe) {
      await store.clear();
    } else {
      // keep local copies, but forget they were synced so reconnecting re-uploads them
      for (const n of await store.all()) if (n.synced) { delete n.synced; n.dirty = true; await store.put(n); }
    }
    notify();
    await reload();
  }

  // ---- shared view (#s=id.key | #d=payload) ----
  let shared = null;
  async function openShared() {
    const h = location.hash;
    const m = h.match(/^#s=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/) || h.match(/^#d=([A-Za-z0-9_-]+)$/);
    if (!m) { shared = null; $('shared').hidden = true; return; }
    $('shared').hidden = false;
    $('sharedTitle').textContent = 'Đang tải nội dung chia sẻ…';
    $('sharedPre').textContent = '';
    $('sharedMeta').textContent = '';
    $('sharedTtl').textContent = '';
    try {
      if (h.startsWith('#s=')) {
        if (!API) throw new Error('Trang chưa cấu hình Worker (config.js) — không tải được link server');
        const res = await fetch(`${API}/api/notes/${m[1]}`, { cache: 'no-store' });
        if (res.status === 404) throw new Error('Không tìm thấy — đã hết hạn hoặc đã bị xoá');
        if (!res.ok) throw new Error(`Server trả ${res.status}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        let plain;
        try { plain = await decrypt(buf, m[2]); } catch { throw new Error('Sai khoá hoặc link bị cắt'); }
        shared = { ...(await unpack(plain)), source: 'server' };
      } else {
        shared = { ...(await unpack(unb64u(m[1]))), source: 'link' };
      }
    } catch (err) {
      shared = null;
      $('sharedTitle').textContent = err.message || 'Link không hợp lệ';
      return;
    }
    $('sharedTitle').textContent = `Được chia sẻ: ${shared.title || '(không tiêu đề)'}`;
    $('sharedMeta').textContent = `${shared.source === 'server' ? 'Qua server (mã hoá)' : 'Link nhúng'} · ` +
      `hết hạn ${fmtTime(shared.expiresAt)} · ${fmtNum(shared.content.length)} ký tự`;
    $('sharedPre').textContent = preview(shared.content);
    tickShared();
  }
  function tickShared() {
    if (!shared) return;
    const left = shared.expiresAt - Date.now();
    if (left <= 0) {
      shared = null;
      $('sharedTitle').textContent = 'Nội dung chia sẻ đã hết hạn';
      $('sharedPre').textContent = '';
      $('sharedMeta').textContent = '';
      $('sharedTtl').textContent = '';
      $('sharedBar').firstChild.style.width = '0';
      return;
    }
    const warn = left < 5 * 60 * 1000;
    $('sharedTtl').textContent = `còn ${fmtLeft(left)}`;
    $('sharedTtl').classList.toggle('warn', warn);
    $('sharedBar').classList.toggle('warn', warn);
    $('sharedBar').firstChild.style.width = (left / (shared.expiresAt - shared.createdAt)) * 100 + '%';
  }
  function preview(text) {
    return text.length > PREVIEW_CHARS
      ? text.slice(0, PREVIEW_CHARS) +
        `\n\n… (chỉ hiển thị ${fmtNum(PREVIEW_CHARS)} ký tự đầu — dùng Copy / Tải .txt để lấy đầy đủ)`
      : text;
  }
  function downloadText(title, content) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (title || 'temp-text').replace(/[^\w.-]+/g, '_').replace(/(\.txt)?$/i, '.txt');
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  async function copyText(text, okMsg) {
    try { await navigator.clipboard.writeText(text); toast(okMsg); }
    catch { toast('Trình duyệt chặn clipboard'); }
  }

  // ---- storage: IndexedDB (quota = % of disk), memory fallback ----
  let db = null;
  let mem = [];
  let cache = [];

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function tx(mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = t.onabort = () => reject(t.error);
    });
  }
  const store = {
    all: () => db ? tx('readonly', (s) => s.getAll()) : Promise.resolve(mem.slice()),
    get: (id) => db ? tx('readonly', (s) => s.get(id)) : Promise.resolve(mem.find((x) => x.id === id)),
    put: (n) => db ? tx('readwrite', (s) => s.put(n))
      : Promise.resolve(void (mem = mem.filter((x) => x.id !== n.id).concat(n))),
    del: (ids) => db ? tx('readwrite', (s) => { ids.forEach((id) => s.delete(id)); })
      : Promise.resolve(void (mem = mem.filter((x) => !ids.includes(x.id)))),
    clear: () => db ? tx('readwrite', (s) => s.clear()) : Promise.resolve(void (mem = [])),
  };

  async function migrateLegacy() {
    let raw = null;
    try { raw = localStorage.getItem(LEGACY_KEY); } catch { return; }
    if (!raw) return;
    try {
      const now = Date.now();
      for (const n of JSON.parse(raw)) if (n.expiresAt > now) await store.put(n);
      localStorage.removeItem(LEGACY_KEY);
    } catch { /* keep legacy data if migration fails */ }
  }

  // ---- cross-tab sync ----
  const bc = 'BroadcastChannel' in window ? new BroadcastChannel(DB_NAME) : null;
  const notify = () => bc && bc.postMessage('changed');
  if (bc) bc.onmessage = () => reload();

  async function reload() {
    cache = await store.all();
    const now = Date.now();
    const expired = cache.filter((n) => n.expiresAt <= now).map((n) => n.id);
    if (expired.length) {
      await store.del(expired);
      cache = cache.filter((n) => n.expiresAt > now);
    }
    render();
    showQuota();
  }

  // ---- UI helpers ----
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._h);
    toast._h = setTimeout(() => t.classList.remove('show'), 2200);
  }
  function fmtLeft(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }
  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function fmtBytes(b) {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
  }
  const fmtNum = (n) => n.toLocaleString('vi-VN');

  async function showQuota() {
    if (!db) {
      $('quota').textContent = 'IndexedDB không khả dụng — dữ liệu chỉ giữ trong tab này.';
      return;
    }
    if (!navigator.storage || !navigator.storage.estimate) return;
    try {
      const { usage, quota } = await navigator.storage.estimate();
      $('quota').textContent = `Dung lượng trình duyệt cấp: ~${fmtBytes(quota)} · đã dùng ${fmtBytes(usage)}`;
    } catch { /* ignore */ }
  }

  // ---- render ----
  function render() {
    const items = cache.slice().sort((a, b) => b.createdAt - a.createdAt);
    const list = $('list');
    $('listTitle').textContent = `Bản ghi đang lưu (${items.length})`;
    $('clearAll').disabled = items.length === 0;
    list.innerHTML = '';
    if (!items.length) {
      list.innerHTML = '<div class="card empty">Chưa có bản ghi nào.</div>';
      return;
    }
    for (const n of items) {
      const card = document.createElement('div');
      card.className = 'card';
      card.dataset.id = n.id;

      const head = document.createElement('div');
      head.className = 'note-head';
      const title = document.createElement('span');
      title.className = 'note-title';
      title.textContent = n.title || '(không tiêu đề)';
      const ttl = document.createElement('span');
      ttl.className = 'ttl';
      head.append(title, ttl);

      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.innerHTML = '<span></span>';

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `Tạo lúc ${fmtTime(n.createdAt)} · hết hạn ${fmtTime(n.expiresAt)} · ` +
        `${fmtNum(n.content.length)} ký tự · ${fmtBytes(n.bytes ?? n.content.length)}` +
        (sync ? (isSynced(n) ? ' · ☁ đã đồng bộ' : ' · ⏳ chờ đồng bộ') : '');

      const pre = document.createElement('pre');
      pre.textContent = preview(n.content);

      const actions = document.createElement('div');
      actions.className = 'actions';
      actions.innerHTML =
        '<button type="button" data-act="copy">Copy</button>' +
        '<button type="button" data-act="edit">Sửa</button>' +
        '<button type="button" data-act="download">Tải .txt</button>' +
        (API ? '<button type="button" data-act="share" class="primary">Chia sẻ</button>' : '') +
        (EMBED ? '<button type="button" data-act="embed">Link nhúng</button>' : '') +
        '<button type="button" data-act="del" class="danger">Xoá</button>';

      card.append(head, bar, meta, pre, actions);
      if (n.share) {
        const box = document.createElement('div');
        box.className = 'share-box';
        const input = document.createElement('input');
        input.type = 'text';
        input.readOnly = true;
        input.value = n.share.url;
        input.addEventListener('focus', () => input.select());
        const label = document.createElement('span');
        label.className = 'meta';
        label.textContent = n.share.kind === 'server' ? 'Link server:' : 'Link nhúng:';
        box.append(label, input);
        box.insertAdjacentHTML('beforeend', '<button type="button" data-act="copylink">Copy link</button>');
        card.append(box);
      }
      list.append(card);
    }
    tick();
  }

  // update countdowns from cache without full re-render
  async function tick() {
    tickShared();
    const now = Date.now();
    const expired = cache.filter((n) => n.expiresAt <= now).map((n) => n.id);
    if (expired.length) {
      cache = cache.filter((n) => n.expiresAt > now);
      await store.del(expired).catch(() => {});
      notify();
      render();
      showQuota();
      return;
    }
    for (const card of $('list').querySelectorAll('.card[data-id]')) {
      const n = cache.find((x) => x.id === card.dataset.id);
      if (!n) continue;
      const left = n.expiresAt - now;
      const pct = (left / (n.expiresAt - n.createdAt)) * 100;
      const warn = left < 5 * 60 * 1000;
      const ttl = card.querySelector('.ttl');
      ttl.textContent = `còn ${fmtLeft(left)}`;
      ttl.classList.toggle('warn', warn);
      const bar = card.querySelector('.bar');
      bar.classList.toggle('warn', warn);
      bar.firstChild.style.width = pct + '%';
    }
  }

  // ---- form ----
  function updateCount() {
    $('count').textContent = `${fmtNum($('content').value.length)} ký tự`;
  }
  $('content').addEventListener('input', updateCount);
  $('form').addEventListener('reset', () => {
    setTimeout(() => { updateCount(); delete $('form').dataset.editId; }, 0);
  });

  async function loadFile(file) {
    if (!file) return;
    try {
      $('content').value = await file.text();
      if (!$('title').value) $('title').value = file.name;
      updateCount();
      toast(`Đã nạp ${file.name} (${fmtBytes(file.size)})`);
    } catch { toast('Không đọc được file'); }
  }
  $('openFile').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
  const ta = $('content');
  ta.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); ta.classList.add('drag'); } });
  ta.addEventListener('dragleave', () => ta.classList.remove('drag'));
  ta.addEventListener('drop', (e) => {
    ta.classList.remove('drag');
    if (e.dataTransfer.files.length) { e.preventDefault(); loadFile(e.dataTransfer.files[0]); }
  });

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const content = $('content').value;
    if (!content.trim()) return;
    const minutes = Math.min(MAX_TTL_MIN, Number($('ttl').value) || MAX_TTL_MIN);
    const now = Date.now();
    const editId = $('form').dataset.editId;
    const existing = editId && cache.find((x) => x.id === editId);
    const note = {
      id: existing ? existing.id
        : (crypto.randomUUID && crypto.randomUUID()) || String(now) + Math.random(),
      title: $('title').value.trim(),
      content,
      bytes: new Blob([content]).size,
      createdAt: now,
      expiresAt: now + minutes * 60000,
      dirty: true, // local change not yet on the sync server
    };
    try {
      await store.put(note);
      if (existing && existing.share) unshareRemote(existing); // old link would show stale text
    } catch (err) {
      toast(err && err.name === 'QuotaExceededError'
        ? 'Vượt dung lượng trình duyệt cho phép — xoá bớt bản ghi cũ'
        : 'Lưu thất bại: ' + (err && err.message || err));
      return;
    }
    $('form').reset();
    notify();
    await reload();
    pushSoon(note);
    toast(existing ? (existing.share ? 'Đã cập nhật — link cũ đã huỷ, bấm Chia sẻ lại' : 'Đã cập nhật')
      : `Đã lưu ${fmtBytes(note.bytes)}, hết hạn sau ${minutes} phút`);
  });

  // ---- list actions ----
  $('list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('.card').dataset.id;
    const n = cache.find((x) => x.id === id);
    if (!n || n.expiresAt <= Date.now()) return tick();
    switch (btn.dataset.act) {
      case 'copy':
        await copyText(n.content, 'Đã copy');
        break;
      case 'copylink':
        await copyText(n.share.url, 'Đã copy link');
        break;
      case 'share':
      case 'embed': {
        btn.disabled = true;
        try {
          const share = btn.dataset.act === 'share' ? await shareToServer(n) : await embedLink(n);
          await unshareRemote(n);
          n.share = share;
          await store.put(n);
          render();
          await copyText(share.url, `Đã tạo & copy link — hết hạn ${fmtTime(n.expiresAt)}`);
        } catch (err) {
          toast(err.message || String(err));
          btn.disabled = false;
        }
        break;
      }
      case 'edit':
        $('title').value = n.title;
        $('content').value = n.content;
        updateCount();
        $('form').dataset.editId = n.id;
        $('content').focus();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        toast('Đang sửa — Lưu sẽ reset thời gian hết hạn');
        break;
      case 'download':
        downloadText(n.title, n.content);
        break;
      case 'del':
        unshareRemote(n);
        deleteRemote(n);
        await store.del([id]);
        notify();
        await reload();
        toast('Đã xoá');
        break;
    }
  });

  $('clearAll').addEventListener('click', async () => {
    if (!confirm(sync ? 'Xoá toàn bộ bản ghi trên MỌI trình duyệt đang dùng mã đồng bộ này?'
      : 'Xoá toàn bộ bản ghi (kèm link server đã chia sẻ)?')) return;
    cache.forEach(unshareRemote);
    cache.forEach(deleteRemote);
    await store.clear();
    notify();
    await reload();
  });

  $('sharedActions').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-sact]');
    if (!btn) return;
    if (btn.dataset.sact === 'close') {
      history.replaceState(null, '', location.pathname + location.search);
      return openShared();
    }
    if (!shared) return;
    switch (btn.dataset.sact) {
      case 'copy': await copyText(shared.content, 'Đã copy'); break;
      case 'download': downloadText(shared.title, shared.content); break;
      case 'save': {
        const content = shared.content;
        const note = {
          id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random(),
          title: shared.title, content, bytes: new Blob([content]).size,
          createdAt: shared.createdAt, expiresAt: shared.expiresAt, dirty: true,
        };
        try { await store.put(note); } catch (err) { return toast('Lưu thất bại: ' + (err && err.message || err)); }
        notify();
        await reload();
        pushSoon(note);
        toast('Đã lưu vào máy này (giữ nguyên giờ hết hạn)');
        break;
      }
    }
  });
  window.addEventListener('hashchange', () => { takeSyncHash(); openShared(); });

  // ---- sync card ----
  $('syncGen').addEventListener('click', () => { $('syncInput').value = newSyncCode(); $('syncInput').type = 'text'; });
  $('syncForm').addEventListener('submit', (e) => { e.preventDefault(); connectSync($('syncInput').value).catch((err) => toast(err.message)); });
  $('syncOn').addEventListener('click', async (e) => {
    const act = e.target.closest('button') && e.target.closest('button').dataset.sync;
    if (!act || !sync) return;
    if (act === 'reveal') {
      const el = $('syncCodeShown');
      if (el.dataset.reveal) delete el.dataset.reveal; else el.dataset.reveal = '1';
      renderSync();
    } else if (act === 'copy') {
      await copyText(sync.code, 'Đã copy mã đồng bộ');
    } else if (act === 'link') {
      await copyText(`${pageUrl()}#sync=${encodeURIComponent(sync.code)}`, 'Đã copy link kết nối — mở ở trình duyệt khác');
    } else if (act === 'refresh') {
      await syncNow();
      toast(syncError ? syncError : 'Đã làm mới');
    } else if (act === 'off') {
      if (!confirm('Ngắt đồng bộ trên trình duyệt này? (bản ghi trên server và máy khác vẫn giữ)')) return;
      await disconnectSync(confirm('Xoá luôn mọi bản ghi đang lưu trên máy này?\nOK = xoá · Cancel = giữ lại'));
    }
  });
  // #sync=<code>: one-tap connect from another device; strip it from the address bar right away
  function takeSyncHash() {
    const m = location.hash.match(/^#sync=(.+)$/);
    if (!m) return false;
    history.replaceState(null, '', location.pathname + location.search);
    if (API) connectSync(decodeURIComponent(m[1]), { quiet: true }).then(() => toast('Đã kết nối mã đồng bộ'), (err) => toast(err.message));
    return true;
  }

  // ---- init ----
  (async () => {
    try {
      if (!('indexedDB' in window)) throw new Error('no indexedDB');
      db = await openDb();
    } catch { db = null; }
    if (db) await migrateLegacy();
    await reload();
    renderSync();
    if (!takeSyncHash() && API) {
      let saved = null;
      try { saved = localStorage.getItem(SYNC_KEY); } catch { /* ignore */ }
      if (saved) connectSync(saved, { quiet: true }).catch(() => {});
    }
    openShared();
    setInterval(tick, 1000);
    setInterval(() => { if (document.visibilityState === 'visible' && !wsOpen()) syncNow(); }, SYNC_POLL_MS);
    setInterval(() => { if (wsOpen()) ws.send('ping'); }, 30000); // keep NAT/proxies from idling the socket out
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
  })();
})();
