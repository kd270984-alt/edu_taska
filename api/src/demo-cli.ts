// Первый вход и демо-команда изнутри контейнера api — без пароля администратора: база берётся из DATABASE_URL.
// Обычно их зовут scripts/first-login.sh и scripts/demo-reset.sh, руками:
//   docker compose exec -T api node_modules/.bin/tsx src/demo-cli.ts show    — адрес, логин и пароль первого входа (три строки)
//   docker compose exec -T api node_modules/.bin/tsx src/demo-cli.ts count   — сколько сейчас людей, задач и вложений
//   docker compose exec -T -e KEEP_EMAIL=agent@taska.local api node_modules/.bin/tsx src/demo-cli.ts reset
//                                                                            — стереть всё и посадить демо-команду заново
// Коды выхода: 0 — готово; 3 — записки с паролем нет или пароль из неё больше не подходит (записка стёрта);
//              4 — reset: демо посажено, но записку сохранить не удалось — строки входа напечатаны здесь же;
//              1 — ошибка; 2 — неизвестная команда.
import { Pool } from 'pg';
import { verifyPassword } from './auth.ts';
import { appUrl, forgetFirstLogin, readFirstLogin, resetDemo } from './demo-seed.ts';

const cmd = process.argv[2] || 'show';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lines = (login: string, password: string) =>
  `Адрес вашей Таски: ${appUrl()}\nЛогин: ${login}\nПароль: ${password}`;
// кого не трогать при сбросе: учётку телеграм-агента (из .env скрипта и из окружения контейнера)
const keep = [...new Set([process.env.KEEP_EMAIL, process.env.AGENT_EMAIL]
  .flatMap((v) => String(v ?? '').split(','))
  .map((v) => v.replace(/(^|\s)#.*$/, '').trim().toLowerCase())
  .filter(Boolean))];

const GONE =
  'Если Таска новая и своего в ней ещё ничего нет, можно начать заново: bash scripts/demo-reset.sh ' +
  '(стирает всё, спросит подтверждение) — он выдаст новый пароль.';

try {
  if (cmd === 'show') {
    const rec = readFirstLogin();
    if (!rec) {
      console.error(
        'Записки с паролем первого входа нет: пароль администратора уже меняли (тогда записка стирается сама) ' +
        'или Таска поставлена до того, как записка появилась. Входите с паролем, который сохранили в «Мои доступы». ' + GONE,
      );
      process.exitCode = 3;
    } else {
      const u = rec !== 'broken' && UUID.test(rec.user_id)
        ? (await pool.query('select email, password_hash, active from users where id = $1', [rec.user_id])).rows[0]
        : null;
      if (rec === 'broken' || !u || !u.active || !verifyPassword(rec.password, u.password_hash)) {
        forgetFirstLogin();
        console.error(
          'Пароль из записки первого входа больше не подходит: его сменили, базу вернули из копии или пересоздали. ' +
          'Записку удалил. Входите с паролем, который сохранили в «Мои доступы». ' + GONE,
        );
        process.exitCode = 3;
      } else {
        console.log(lines(u.email, rec.password));
      }
    }
  } else if (cmd === 'count') {
    const r = (await pool.query(
      `select (select count(*) from users where lower(email) <> all($1::text[]))::int as users,
              (select count(*) from tasks)::int as tasks,
              (select count(*) from attachments)::int as files`, [keep])).rows[0];
    console.log(`людей ${r.users}, задач ${r.tasks}, вложений ${r.files}`);
  } else if (cmd === 'reset') {
    const r = await resetDemo(pool, keep);
    const kept = (await pool.query('select email from users where lower(email) = any($1::text[]) order by email', [keep])).rows.map((x) => x.email);
    console.log(`демо-команда посажена: людей ${r.users}, задач ${r.tasks}, меток ${r.tags}` +
      (kept.length ? `; учётка агента ${kept.join(', ')} осталась` : ''));
    if (r.saveError) {
      console.error(`⚠️ Записку с паролем (api/.first-login) сохранить не удалось: ${r.saveError}. ` +
        'Перепишите пароль сейчас — второй раз его не показать.');
      console.log(lines('admin', r.password));
      process.exitCode = 4;
    }
  } else {
    console.error(`неизвестная команда «${cmd}». Есть: show, count, reset`);
    process.exitCode = 2;
  }
} catch (e) {
  console.error('ошибка —', (e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
