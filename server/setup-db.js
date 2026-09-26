import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { createPool } from './db.js';

const pool = createPool();
try {
  const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  await pool.query(schema);
  console.log('DigitalOcean gallery schema is ready.');
} finally {
  await pool.end();
}