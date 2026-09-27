// ===========================================================================
// Gallery storage: publish, browse, like, report and delete sculptures.
//
// One API, two backends:
//   - the app's REST API (online, shared by everyone)
//   - Demo mode (IndexedDB, this browser only) when it doesn't
//
// There are no accounts. Each browser gets a random private "owner key" kept
// in localStorage; only its SHA-256 hash is published with a sculpture, so
// the same browser can later prove it made the sculpture and delete it.
// ===========================================================================
import { API_BASE_URL } from './config.js';

const PAGE_SIZE = 24;

// --- Per-browser identity & preferences --------------------------------------
const LS = {
  get(k, d = null) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: fine */ } },
};
function ownerToken() {
  let t = LS.get('sculpt.ownerKey');
  if (!t) {
    t = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
    LS.set('sculpt.ownerKey', t);
  }
  return t;
}
async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
}
const ownerHashPromise = sha256Hex(ownerToken());

export const artistName = {
  get: () => LS.get('sculpt.artistName', ''),
  set: name => LS.set('sculpt.artistName', name),
};
// Likes are remembered per browser so the heart stays filled (and one browser
// can't keep liking the same sculpture from the UI).
const liked = new Set(JSON.parse(LS.get('sculpt.liked', '[]')));
export const hasLiked = id => liked.has(id);
function rememberLike(id) { liked.add(id); LS.set('sculpt.liked', JSON.stringify([...liked])); }

// Checks shared by both backends.
function cleanMeta({ title, artist }) {
  title = String(title ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
  artist = String(artist ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!title) throw new Error('Please give your sculpture a title.');
  if (!artist) throw new Error('Please enter your name.');
  return { title, artist };
}
const safeSearch = s => String(s ?? '').replace(/[^\p{L}\p{N} '-]/gu, ' ').trim().slice(0, 40);

// ---------------------------------------------------------------------------
// App API backend
// ---------------------------------------------------------------------------
async function apiStore() {
  const api = path => `${API_BASE_URL}${path}`;
  const headers = () => new Headers({ 'x-owner-token': ownerToken() });
  async function request(path, options = {}) {
    const requestHeaders = headers();
    new Headers(options.headers).forEach((value, key) => requestHeaders.set(key, value));
    const response = await fetch(api(path), { ...options, headers: requestHeaders });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.error || `Gallery request failed (${response.status})`);
    }
    return response.status === 204 ? null : response.json();
  }

  const health = await fetch(api('/health'));
  if (!health.ok || (await health.json()).mode !== 'online') {
    throw new Error('DigitalOcean gallery API is unavailable.');
  }
  const toItem = item => ({ ...item, createdAt: new Date(item.createdAt) });
  return {
    mode: 'online',
    async publish({ title, artist, data, thumb, remixOf = null }) {
      ({ title, artist } = cleanMeta({ title, artist }));
      const form = new FormData();
      form.set('title', title);
      form.set('artist', artist);
      if (remixOf) form.set('remixOf', remixOf);
      form.set('data', new Blob([data], { type: 'application/octet-stream' }), 'sculpture.sclp');
      form.set('thumb', thumb, `thumbnail.${thumb.type === 'image/webp' ? 'webp' : 'png'}`);
      return request('/sculptures', { method: 'POST', body: form });
    },
    async list({ sort = 'new', search = '', page = 0 } = {}) {
      const params = new URLSearchParams({ sort, search: safeSearch(search), page: String(page) });
      const result = await request(`/sculptures?${params}`);
      return { ...result, items: result.items.map(toItem) };
    },
    async get(id) {
      const item = await request(`/sculptures/${encodeURIComponent(id)}`);
      return item ? toItem(item) : null;
    },
    async getData(item) {
      const res = await fetch(api(`/sculptures/${encodeURIComponent(item.id)}/data`));
      if (!res.ok) throw new Error(`Downloading the sculpture failed (${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async like(id) {
      if (liked.has(id)) return null;
      const { likes: count } = await request(`/sculptures/${encodeURIComponent(id)}/like`, { method: 'POST' });
      rememberLike(id);
      return count;
    },
    report: id => request(`/sculptures/${encodeURIComponent(id)}/report`, { method: 'POST' }),
    remove: id => request(`/sculptures/${encodeURIComponent(id)}/delete`, { method: 'POST' }),
  };
}

// ---------------------------------------------------------------------------
// Demo backend: IndexedDB in this browser. Same behaviour, nobody else sees it.
// ---------------------------------------------------------------------------
function demoStore() {
  const dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open('sculpt-gallery-demo', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('sculptures', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const tx = async (mode, fn) => {
    const db = await dbp;
    return new Promise((resolve, reject) => {
      const t = db.transaction('sculptures', mode), st = t.objectStore('sculptures');
      const req = fn(st);
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
    });
  };
  const urls = new Map();                                 // object URLs for thumbnails, made once per id
  const toItem = async row => {
    if (!urls.has(row.id)) urls.set(row.id, URL.createObjectURL(row.thumb));
    return {
      id: row.id, title: row.title, artist: row.artist, likes: row.likes, createdAt: new Date(row.createdAt),
      remixOf: row.remixOf, thumbUrl: urls.get(row.id), mine: row.ownerHash === await ownerHashPromise, _data: row.data,
    };
  };
  const all = async () => (await tx('readonly', st => st.getAll())).filter(r => !r.hidden);

  return {
    mode: 'demo',
    async publish({ title, artist, data, thumb, remixOf = null }) {
      ({ title, artist } = cleanMeta({ title, artist }));
      const id = crypto.randomUUID(), ownerHash = await ownerHashPromise;
      await tx('readwrite', st => st.put({
        id, title, artist, likes: 0, reports: 0, hidden: false, createdAt: Date.now(), remixOf,
        ownerHash, data: new Blob([data]), thumb,
      }));
      return { id };
    },
    async list({ sort = 'new', search = '', page = 0 } = {}) {
      const s = safeSearch(search).toLowerCase();
      let rows = await all();
      if (s) rows = rows.filter(r => r.title.toLowerCase().includes(s) || r.artist.toLowerCase().includes(s));
      rows.sort(sort === 'likes' ? (a, b) => b.likes - a.likes || b.createdAt - a.createdAt : (a, b) => b.createdAt - a.createdAt);
      const slice = rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
      return { items: await Promise.all(slice.map(toItem)), more: rows.length > (page + 1) * PAGE_SIZE };
    },
    async get(id) {
      const row = await tx('readonly', st => st.get(id));
      return row && !row.hidden ? toItem(row) : null;
    },
    async getData(item) { return new Uint8Array(await item._data.arrayBuffer()); },
    async like(id) {
      if (liked.has(id)) return null;
      const row = await tx('readonly', st => st.get(id));
      row.likes++;
      await tx('readwrite', st => st.put(row));
      rememberLike(id);
      return row.likes;
    },
    async report(id) {
      const row = await tx('readonly', st => st.get(id));
      row.reports++; if (row.reports >= 3) row.hidden = true;
      await tx('readwrite', st => st.put(row));
    },
    async remove(id) {
      const row = await tx('readonly', st => st.get(id));
      if (row.ownerHash !== await ownerHashPromise) throw new Error('Only the browser that published a sculpture can delete it.');
      row.hidden = true;
      await tx('readwrite', st => st.put(row));
    },
  };
}

// The static VS Code preview has no API, so it continues to use local demo data.
export const storePromise = apiStore()
  .catch(err => { console.warn('Gallery API unavailable, using demo mode:', err); return demoStore(); });
