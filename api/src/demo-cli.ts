// Первый вход и демо-команда изнутри контейнера api — без пароля администратора: база берётся из DATABASE_URL.
// Обычно их зовут scripts/first-login.sh и scripts/demo-reset.sh, руками:
//   docker compose exec -T api node_modules/.bin/tsx src/demo-cli.ts show    — адрес, логин и пароль первого входа (три строки)
//   docker compose exec -T api node_modules/.bin/tsx src/demo-cli.ts count   — сколько сейчас людей, задач и вложений
//   docker compose exec -T -e KEEP_EMAIL=agent@taska.local api node_modules/.bin/tsx src/demo-cli.ts reset
//                                                                            — стереть всё и посадить демо-команду заново
//   … demo-cli.ts password-check [логин] — кому admin-password.sh задаст пароль (ничего не меняет)
//   … demo-cli.ts password [логин]       — новый пароль администратору, ничего не стирая (проверка 16.11);
//                                          прежние входы под этим логином обрываются; ответ — те же три строки
// show --log: на вход (stdin) — строки ADMIN_BOOTSTRAP из журнала api; так зовёт scripts/first-login.sh.
//   Если записки нет, а при запуске её сохранить не удалось, пароль ищется там, сверяется с базой
//   и перекладывается в записку (независимая проверка 16.11).
// Коды выхода: 0 — готово; 3 — записки с паролем нет или пароль из неё больше не подходит (записка стёрта),
//              у password — отказ (нет такого администратора и т. п., почему — в stderr);
//              4 — строки входа напечатаны, но записку сохранить не удалось — перепишите пароль сейчас;
//              1 — ошибка; 2 — неизвестная команда.
import fs from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { verifyPassword } from './auth.ts';
import {
  PENDING_FILE, appUrl, dropPendingFirstLogin, findAdminTarget, forgetFirstLogin, plural, promoteFirstLogin,
  readFirstLogin, resetDemo, saveFirstLogin, setAdminPassword, tasksText, withFirstStartLock, type FirstLogin,
} from './demo-seed.ts';

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

// Что делать, когда пароля нет (независимая проверка 16.11): человеку — «Мои доступы»; новый пароль или
// стирание — только после «да» человека; где ещё искать пароль, не подсказываем (курс просит помощника этого не показывать).
// Проверка 16.11: первым — новый пароль без стирания (admin-password.sh), стирание всего — только когда своего нет.
const WHAT_NOW =
  'Что делать: войдите с паролем администратора, который сохранили в «Мои доступы». ' +
  'Если его там нет — задайте администратору новый пароль, ничего не стирая: bash scripts/admin-password.sh ' +
  '(люди, задачи и вложения остаются; прежний пароль и все открытые входы под этим логином перестают действовать). ' +
  'Помощник: сами не запускайте — сначала спросите человека, согласен ли он сменить пароль администратора, ' +
  'и только после его «да» добавьте --yes. Стирать всё (bash scripts/demo-reset.sh) для этого не нужно.';

// Строки ADMIN_BOOTSTRAP с паролем (когда записку сохранить не удалось): «вход admin, пароль X — …»
// и «login=… temp_password=…» (и прежний «email=… temp_password=…»). Новые — первыми.
function fromLog(text: string): { login: string; password: string }[] {
  const out: { login: string; password: string }[] = [];
  for (const line of text.split('\n').reverse()) {
    if (!line.includes('ADMIN_BOOTSTRAP')) continue;
    const a = /вход (\S+), пароль (\S+) — /.exec(line) || /(?:login|email)=(\S+)\s+temp_password=(\S+)/.exec(line);
    if (a) out.push({ login: a[1].toLowerCase(), password: a[2] });
  }
  return out;
}

// Чей пароль в записке и действует ли он: включённый человек с этим паролем — или null
async function owner(c: PoolClient, rec: FirstLogin | 'broken'): Promise<{ id: string; email: string } | null> {
  if (rec === 'broken' || !UUID.test(rec.user_id)) return null;
  const u = (await c.query('select id, email, password_hash, active from users where id = $1', [rec.user_id])).rows[0];
  return u && u.active && verifyPassword(rec.password, u.password_hash) ? u : null;
}

// Под тем же замком, что посадка и сброс (независимая проверка 16.11): пока они идут, show ждёт —
// и не стирает записку про ещё не закоммиченного администратора.
async function show(logText: string): Promise<void> {
  let out = null as { login: string; password: string } | null;   // «as»: присваивается внутри замка (замыкание)
  let warn = '';
  let stale = false;
  // замок соединения (проверка 16.11): посадка и сброс держат его до конца переименования записки
  await withFirstStartLock(pool, async (c) => {
    // 1) записка «до commit»: commit прошёл — переложить на место, не прошёл — выбросить
    const pend = readFirstLogin(PENDING_FILE);
    if (pend) {
      const u = await owner(c, pend);
      if (!u || pend === 'broken') dropPendingFirstLogin();
      else {
        const e = promoteFirstLogin();
        if (e) { out = { login: u.email, password: pend.password }; warn = `записку не удалось переложить на место (${e})`; }
      }
    }
    // 2) действующая записка
    if (!out) {
      const rec = readFirstLogin();
      if (rec) {
        const u = await owner(c, rec);
        if (u && rec !== 'broken') out = { login: u.email, password: rec.password };
        else { forgetFirstLogin(); stale = true; }
      }
    }
    // 3) записку при запуске сохранить не удалось — пароль один раз напечатан в журнале
    if (!out && logText) {
      for (const cand of fromLog(logText)) {
        const u = (await c.query('select id, email, password_hash, active from users where lower(email) = $1', [cand.login])).rows[0];
        if (!u || !u.active || !verifyPassword(cand.password, u.password_hash)) continue;
        out = { login: u.email, password: cand.password };
        const e = saveFirstLogin({ login: u.email, password: cand.password, user_id: u.id, demo: u.email === 'admin' });
        if (e) warn = `записку сохранить не удалось и сейчас (${e})`;
        else console.error('Записку с паролем при запуске сохранить не удалось — пароль нашёлся и теперь сохранён в записке.');
        break;
      }
    }
  });
  if (out) {
    console.log(lines(out.login, out.password));
    if (warn) {
      console.error(`⚠️ ${warn[0].toUpperCase()}${warn.slice(1)}. Перепишите пароль в «Мои доступы» сейчас — второй раз его может не найтись.`);
      process.exitCode = 4;
    }
    return;
  }
  console.error((stale
    ? 'Пароль из записки первого входа больше не подходит: его сменили, базу вернули из копии или пересоздали. Записку удалил. '
    : 'Пароля первого входа у Таски больше нет: пароль администратора уже меняли (тогда записка стирается сама), ' +
      'базу вернули из копии или Таску поставили до того, как записка появилась. ') + WHAT_NOW);
  process.exitCode = 3;
}

try {
  if (cmd === 'show') {
    // строки журнала — только по ключу --log (иначе ручной запуск в терминале ждал бы ввода)
    await show(process.argv.includes('--log') ? fs.readFileSync(0, 'utf8') : '');
  } else if (cmd === 'count') {
    // задачи и подзадачи — отдельно: «30 задач и 3 подзадачи» (независимая проверка 16.11)
    const r = (await pool.query(
      `select (select count(*) from users where lower(email) <> all($1::text[]))::int as users,
              (select count(*) from tasks where parent_id is null)::int as tasks,
              (select count(*) from tasks where parent_id is not null)::int as subtasks,
              (select count(*) from attachments)::int as files`, [keep])).rows[0];
    console.log(`${plural(r.users, 'человек', 'человека', 'человек')}, ${tasksText(r.tasks, r.subtasks)}, ` +
      plural(r.files, 'вложение', 'вложения', 'вложений'));
  } else if (cmd === 'reset') {
    const r = await resetDemo(pool, keep);
    const kept = (await pool.query('select email from users where lower(email) = any($1::text[]) order by email', [keep])).rows.map((x) => x.email);
    console.log(`демо-команда посажена: ${plural(r.users, 'человек', 'человека', 'человек')}, ${tasksText(r.tasks, r.subtasks)}, ` +
      plural(r.tags, 'метка', 'метки', 'меток') +
      (kept.length ? `; учётка агента ${kept.join(', ')} осталась` : ''));
    if (r.saveError) {
      console.error(`⚠️ Записку с паролем (api/.first-login) сохранить не удалось: ${r.saveError}. ` +
        'Перепишите пароль сейчас — второй раз его не показать.');
      console.log(lines('admin', r.password));
      process.exitCode = 4;
    }
  } else if (cmd === 'password-check') {
    // кому admin-password.sh задаст пароль — чтобы спросить человека заранее; ничего не меняет
    const t = await withFirstStartLock(pool, (c) => findAdminTarget(c, process.argv[3] || '', keep));
    if ('refuse' in t) { console.error(t.refuse); process.exitCode = 3; }
    else console.log(t.email);
  } else if (cmd === 'password') {
    const r = await setAdminPassword(pool, process.argv[3] || '', keep);
    if ('refuse' in r) { console.error(r.refuse); process.exitCode = 3; }
    else {
      console.log(lines(r.login, r.password));
      if (r.saveError) {
        console.error(`⚠️ Записку с паролем (api/.first-login) сохранить не удалось: ${r.saveError}. ` +
          'Перепишите пароль в «Мои доступы» сейчас — второй раз его не показать.');
        process.exitCode = 4;
      }
    }
  } else {
    console.error(`неизвестная команда «${cmd}». Есть: show, count, reset, password-check, password`);
    process.exitCode = 2;
  }
} catch (e) {
  console.error('ошибка —', (e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
