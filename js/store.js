// ===========================================================================
// Gallery storage: publish, browse, like, report and delete sculptures.
//
// One API, two backends:
//   - Supabase (online, shared by everyone) when js/config.js has keys
//   - Demo mode (IndexedDB, this browser only) when it doesn't
//
// There are no accounts. Each browser gets a random private "owner key" kept
// in localStorage; only its SHA-256 hash is published with a sculpture, so
// the same browser can later prove it made the sculpture and delete it.
// ===========================================================================
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const BUCKET = 'sculptures';
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
// Supabase backend
// ---------------------------------------------------------------------------
async function supabaseStore() {
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const publicUrl = path => sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  const COLS = 'id,title,artist,likes,created_at,owner_hash,remix_of,data_path,thumb_path';
  const toItem = async row => ({
    id: row.id, title: row.title, artist: row.artist, likes: row.likes,
    createdAt: new Date(row.created_at), remixOf: row.remix_of,
    thumbUrl: publicUrl(row.thumb_path), dataUrl: publicUrl(row.data_path),
    mine: row.owner_hash === await ownerHashPromise,
  });
  const fail = (what, error) => { throw new Error(`${what} failed: ${error.message || error}`); };

  return {
    mode: 'online',
    async publish({ title, artist, data, thumb, remixOf = null }) {
      ({ title, artist } = cleanMeta({ title, artist }));
      const id = crypto.randomUUID();
      const thumbExt = thumb.type === 'image/webp' ? 'webp' : 'png';
      const dataPath = `${id}.sclp`, thumbPath = `${id}.${thumbExt}`;
      let r = await sb.storage.from(BUCKET).upload(dataPath, new Blob([data], { type: 'application/octet-stream' }),
        { contentType: 'application/octet-stream', upsert: false });
      if (r.error) fail('Uploading the sculpture', r.error);
      r = await sb.storage.from(BUCKET).upload(thumbPath, thumb, { contentType: thumb.type, upsert: false });
      if (r.error) fail('Uploading the picture', r.error);
      r = await sb.from('sculptures').insert({
        id, title, artist, remix_of: remixOf, owner_hash: await ownerHashPromise, data_path: dataPath, thumb_path: thumbPath,
      });
      if (r.error) fail('Saving to the gallery', r.error);
      return { id };
    },
    async list({ sort = 'new', search = '', page = 0 } = {}) {
      let q = sb.from('sculptures').select(COLS);
      const s = safeSearch(search);
      if (s) q = q.or(`title.ilike.*${s}*,artist.ilike.*${s}*`);
      q = sort === 'likes' ? q.order('likes', { ascending: false }).order('created_at', { ascending: false })
                           : q.order('created_at', { ascending: false });
      const { data, error } = await q.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      if (error) fail('Loading the gallery', error);
      return { items: await Promise.all(data.map(toItem)), more: data.length === PAGE_SIZE };
    },
    async get(id) {
      const { data, error } = await sb.from('sculptures').select(COLS).eq('id', id).maybeSingle();
      if (error) fail('Loading the sculpture', error);
      return data ? toItem(data) : null;
    },
    async getData(item) {
      const res = await fetch(item.dataUrl);
      if (!res.ok) throw new Error(`Downloading the sculpture failed (${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async like(id) {
      if (liked.has(id)) return null;
      const { data, error } = await sb.rpc('like_sculpture', { sid: id });
      if (error) fail('Liking', error);
      rememberLike(id);
      return data;                                       // new like count
    },
    async report(id) {
      const { error } = await sb.rpc('report_sculpture', { sid: id });
      if (error) fail('Reporting', error);
    },
    async remove(id) {
      const { data, error } = await sb.rpc('delete_sculpture', { sid: id, owner_token: ownerToken() });
      if (error) fail('Deleting', error);
      if (!data) throw new Error('Only the browser that published a sculpture can delete it.');
    },
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

// The store the pages use. Falls back to demo mode if Supabase isn't set up.
export const storePromise = (SUPABASE_URL && SUPABASE_ANON_KEY)
  ? supabaseStore().catch(err => { console.error('Supabase unavailable, using demo mode:', err); return demoStore(); })
  : Promise.resolve(demoStore());
