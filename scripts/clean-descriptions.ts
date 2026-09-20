// Разовая чистка УЖЕ СОХРАНЁННЫХ описаний задач.
// Сервер чистит разметку на входе, фронт — на показе; эта команда убирает яд из старых записей.
// Запуск:  docker compose exec api npx tsx /app/../scripts/clean-descriptions.ts
//   (или)  docker compose exec -T api sh -lc "cd /app && npx tsx ./scripts/clean-descriptions.ts"
import { Pool } from 'pg';
import { sanitizeDescription } from '../api/src/html.ts';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const { rows } = await pool.query('select id, description from tasks where description is not null and description <> \'\'');
let changed = 0;
for (const r of rows) {
  const clean = sanitizeDescription(r.description);
  if (clean !== r.description) {
    await pool.query('update tasks set description = $1 where id = $2', [clean, r.id]);
    changed++;
  }
}
console.log(`описаний просмотрено: ${rows.length}, вычищено: ${changed}`);
await pool.end();
