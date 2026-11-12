// Команды CRM изнутри контейнера api — без пароля администратора: база берётся из DATABASE_URL.
// Обычно их зовёт scripts/crm-demo.sh, руками:
//   docker compose exec -T api npx tsx src/crm-cli.ts load     — демо в пустую CRM (свои данные не трогает)
//   docker compose exec -T api npx tsx src/crm-cli.ts reset    — стереть данные CRM и загрузить демо заново
//   docker compose exec -T api npx tsx src/crm-cli.ts clear    — стереть данные CRM
//   docker compose exec -T api npx tsx src/crm-cli.ts status   — сколько сейчас клиентов, сделок, товаров
import { Pool } from 'pg';
import { crmCounts, clearCrm, loadCrmDemo } from './crm-demo.ts';

const cmd = process.argv[2] || 'status';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const say = (c: { companies: number; deals: number; products: number }) =>
  `клиентов ${c.companies}, сделок ${c.deals}, товаров ${c.products}`;

try {
  if (cmd === 'load' || cmd === 'reset') {
    const r = await loadCrmDemo(pool, { reset: cmd === 'reset' });
    console.log(r.loaded
      ? `CRM: демо загружено — ${say(r)}`
      : `CRM: данные уже есть (${say(r)}) — демо не загружал. Начать заново: bash scripts/crm-demo.sh reset`);
  } else if (cmd === 'clear') {
    const r = await clearCrm(pool);
    console.log(`CRM: стёрто — ${say(r)}`);
  } else if (cmd === 'status') {
    console.log(`CRM: ${say(await crmCounts(pool))}`);
  } else {
    console.error(`неизвестная команда «${cmd}». Есть: load, reset, clear, status`);
    process.exitCode = 2;
  }
} catch (e) {
  // таблицы CRM создаёт миграция при старте api; нет их — значит api ещё не перезапускали с новым кодом
  if ((e as { code?: string }).code === '42P01') console.error('CRM: таблиц CRM ещё нет — перезапустите api (docker compose up -d --force-recreate api) и повторите');
  else console.error('CRM: ошибка —', (e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
