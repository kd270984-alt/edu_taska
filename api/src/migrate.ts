import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

// Простой раннер миграций: применяет неприменённые *.sql из ../migrations по порядку,
// каждую в транзакции, и отмечает в таблице schema_migrations.
export async function migrate(pool: Pool): Promise<string[]> {
  await pool.query(`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`);

  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const appliedRes = await pool.query<{ name: string }>('select name from schema_migrations');
  const applied = new Set(appliedRes.rows.map((r) => r.name));

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations(name) values($1)', [file]);
      await client.query('commit');
      ran.push(file);
      console.log(`migrate: applied ${file}`);
    } catch (e) {
      await client.query('rollback');
      console.error(`migrate: FAILED ${file}:`, (e as Error).message);
      throw e;
    } finally {
      client.release();
    }
  }
  if (ran.length === 0) console.log('migrate: nothing to apply');
  return ran;
}
