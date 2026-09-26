import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

export function createPool({ required = true } = {}) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    if (required) throw new Error('DATABASE_URL is required.');
    return null;
  }

  const ca = process.env.DATABASE_CA_CERT?.replace(/\\n/g, '\n');
  if (process.env.NODE_ENV === 'production' && !ca) {
    throw new Error('DATABASE_CA_CERT is required in production.');
  }
  const ssl = ca ? { ca, rejectUnauthorized: true } : undefined;

  return new Pool({ connectionString, ssl });
}