import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPool } from './db.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const app = express();
const port = Number(process.env.PORT) || 3001;
const pool = createPool({ required: false });
const spacesReady = Boolean(
  process.env.SPACES_ENDPOINT && process.env.SPACES_BUCKET
  && process.env.SPACES_ACCESS_KEY_ID && process.env.SPACES_SECRET_ACCESS_KEY,
);
const bucket = process.env.SPACES_BUCKET;
const spaces = spacesReady ? new S3Client({
  endpoint: process.env.SPACES_ENDPOINT,
  region: process.env.SPACES_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.SPACES_ACCESS_KEY_ID,
    secretAccessKey: process.env.SPACES_SECRET_ACCESS_KEY,
  },
}) : null;
const online = Boolean(pool && spaces);
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024, files: 2, fields: 3 },
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function ownerHash(req) {
  const token = req.get('x-owner-token') || '';
  if (!/^[0-9a-f]{64}$/i.test(token)) throw new HttpError(401, 'Missing browser owner key.');
  return createHash('sha256').update(token).digest('hex');
}

function cleanMeta(value, maxLength, label) {
  const result = String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
  if (!result) throw new HttpError(400, `Please enter ${label}.`);
  return result;
}

function safeSearch(value) {
  return String(value ?? '').replace(/[^\p{L}\p{N} '-]/gu, ' ').trim().slice(0, 40);
}

function itemFromRow(row, mineHash) {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    likes: row.likes,
    createdAt: row.created_at,
    remixOf: row.remix_of,
    thumbUrl: `/api/sculptures/${row.id}/thumbnail`,
    mine: row.owner_hash.trim() === mineHash,
  };
}

function requireOnline(_req, _res, next) {
  if (!online) return next(new HttpError(503, 'DigitalOcean storage is not configured.'));
  next();
}

async function visibleSculpture(id) {
  if (!idPattern.test(id)) throw new HttpError(400, 'Invalid sculpture id.');
  const { rows } = await pool.query('SELECT * FROM sculptures WHERE id = $1 AND NOT hidden', [id]);
  if (!rows[0]) throw new HttpError(404, 'This sculpture is no longer in the gallery.');
  return rows[0];
}

async function streamObject(key, contentType, res) {
  const result = await spaces.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!result.Body) throw new HttpError(404, 'Sculpture file not found.');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  if (result.ContentLength != null) res.setHeader('Content-Length', result.ContentLength);
  result.Body.on('error', () => res.destroy());
  result.Body.pipe(res);
}

app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 300 }));

app.get('/api/health', (_req, res) => {
  res.json({ mode: online ? 'online' : 'demo' });
});

app.get('/api/sculptures', requireOnline, async (req, res) => {
  const mineHash = ownerHash(req);
  const page = Math.max(0, Math.min(10000, Number.parseInt(req.query.page, 10) || 0));
  const sort = req.query.sort === 'likes' ? 'likes' : 'new';
  const search = safeSearch(req.query.search);
  const values = [];
  let where = 'NOT hidden';
  if (search) {
    values.push(`%${search.replace(/[\\%_]/g, '\\$&')}%`);
    where += ` AND (title ILIKE $${values.length} ESCAPE '\\' OR artist ILIKE $${values.length} ESCAPE '\\')`;
  }
  values.push(25, page * 24);
  const order = sort === 'likes' ? 'likes DESC, created_at DESC' : 'created_at DESC';
  const { rows } = await pool.query(
    `SELECT * FROM sculptures WHERE ${where} ORDER BY ${order} LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  res.json({
    items: rows.slice(0, 24).map(row => itemFromRow(row, mineHash)),
    more: rows.length > 24,
  });
});

app.get('/api/sculptures/:id', requireOnline, async (req, res) => {
  const row = await visibleSculpture(req.params.id);
  res.json(itemFromRow(row, ownerHash(req)));
});

app.get('/api/sculptures/:id/thumbnail', requireOnline, async (req, res) => {
  const row = await visibleSculpture(req.params.id);
  await streamObject(row.thumb_key, row.thumb_type, res);
});

app.get('/api/sculptures/:id/data', requireOnline, async (req, res) => {
  const row = await visibleSculpture(req.params.id);
  await streamObject(row.data_key, 'application/octet-stream', res);
});

app.post('/api/sculptures', requireOnline, upload.fields([
  { name: 'data', maxCount: 1 },
  { name: 'thumb', maxCount: 1 },
]), async (req, res) => {
  const title = cleanMeta(req.body.title, 60, 'a title');
  const artist = cleanMeta(req.body.artist, 40, 'your name');
  const data = req.files?.data?.[0];
  const thumb = req.files?.thumb?.[0];
  if (!data || data.mimetype !== 'application/octet-stream') {
    throw new HttpError(400, 'A valid sculpture file is required.');
  }
  if (!thumb || !['image/webp', 'image/png'].includes(thumb.mimetype)) {
    throw new HttpError(400, 'A WebP or PNG thumbnail is required.');
  }
  const remixOf = req.body.remixOf || null;
  if (remixOf && !idPattern.test(remixOf)) throw new HttpError(400, 'Invalid remix source.');

  const id = randomUUID();
  const dataKey = `${id}.sclp`;
  const thumbKey = `${id}.${thumb.mimetype === 'image/webp' ? 'webp' : 'png'}`;
  const uploaded = [];
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await spaces.send(new PutObjectCommand({
      Bucket: bucket, Key: dataKey, Body: data.buffer, ContentType: data.mimetype,
    }));
    uploaded.push(dataKey);
    await spaces.send(new PutObjectCommand({
      Bucket: bucket, Key: thumbKey, Body: thumb.buffer, ContentType: thumb.mimetype,
    }));
    uploaded.push(thumbKey);

    await client.query('BEGIN');
    transactionStarted = true;
    if (remixOf) {
      const source = await client.query('SELECT id FROM sculptures WHERE id = $1 AND NOT hidden', [remixOf]);
      if (!source.rows[0]) throw new HttpError(404, 'The original sculpture is no longer available.');
    }
    const owner = ownerHash(req);
    const { rows } = await client.query(
      `INSERT INTO sculptures
         (id, title, artist, owner_hash, remix_of, data_key, thumb_key, thumb_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [id, title, artist, owner, remixOf, dataKey, thumbKey, thumb.mimetype],
    );
    await client.query('COMMIT');
    transactionStarted = false;
    res.status(201).json({ id: rows[0].id });
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK').catch(() => {});
    await Promise.allSettled(uploaded.map(Key => spaces.send(new DeleteObjectCommand({ Bucket: bucket, Key }))));
    throw error;
  } finally {
    client.release();
  }
});

app.post('/api/sculptures/:id/like', requireOnline, async (req, res) => {
  const id = req.params.id;
  if (!idPattern.test(id)) throw new HttpError(400, 'Invalid sculpture id.');
  const mineHash = ownerHash(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sculpture = await client.query('SELECT likes FROM sculptures WHERE id = $1 AND NOT hidden FOR UPDATE', [id]);
    if (!sculpture.rows[0]) throw new HttpError(404, 'This sculpture is no longer in the gallery.');
    const inserted = await client.query(
      'INSERT INTO sculpture_likes (sculpture_id, owner_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING sculpture_id',
      [id, mineHash],
    );
    const result = inserted.rowCount
      ? await client.query('UPDATE sculptures SET likes = likes + 1 WHERE id = $1 RETURNING likes', [id])
      : sculpture;
    await client.query('COMMIT');
    res.json({ likes: result.rows[0].likes });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});

app.post('/api/sculptures/:id/report', requireOnline, async (req, res) => {
  const id = req.params.id;
  if (!idPattern.test(id)) throw new HttpError(400, 'Invalid sculpture id.');
  const mineHash = ownerHash(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sculpture = await client.query('SELECT reports FROM sculptures WHERE id = $1 AND NOT hidden FOR UPDATE', [id]);
    if (!sculpture.rows[0]) throw new HttpError(404, 'This sculpture is no longer in the gallery.');
    const inserted = await client.query(
      'INSERT INTO sculpture_reports (sculpture_id, owner_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING sculpture_id',
      [id, mineHash],
    );
    if (inserted.rowCount) {
      await client.query(
        'UPDATE sculptures SET reports = reports + 1, hidden = reports + 1 >= 3 WHERE id = $1',
        [id],
      );
    }
    await client.query('COMMIT');
    res.status(204).end();
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});

app.post('/api/sculptures/:id/delete', requireOnline, async (req, res) => {
  const id = req.params.id;
  if (!idPattern.test(id)) throw new HttpError(400, 'Invalid sculpture id.');
  const result = await pool.query(
    'UPDATE sculptures SET hidden = true WHERE id = $1 AND owner_hash = $2 RETURNING id',
    [id, ownerHash(req)],
  );
  if (!result.rows[0]) throw new HttpError(403, 'Only the browser that published this sculpture can delete it.');
  res.status(204).end();
});

app.get('/', (_req, res) => res.sendFile(path.join(root, 'index.html')));
app.get('/index.html', (_req, res) => res.sendFile(path.join(root, 'index.html')));
app.get('/studio.html', (_req, res) => res.sendFile(path.join(root, 'studio.html')));
app.use('/js', express.static(path.join(root, 'js'), { dotfiles: 'deny', index: false }));
app.use('/assets', express.static(path.join(root, 'assets'), { dotfiles: 'deny', index: false }));

app.use((error, _req, res, _next) => {
  if (res.headersSent) return res.end();
  const status = error instanceof HttpError ? error.status
    : error instanceof multer.MulterError ? 400 : 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status === 500 ? 'The gallery service encountered an error.' : error.message });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Gallery server listening on port ${port} (${online ? 'DigitalOcean backend' : 'demo fallback'}).`);
});