import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { hashPassword, verifyPassword } from './auth.ts';
import { sanitizeDescription } from './html.ts';

// ПЕРВЫЙ ЗАПУСК И ДЕМО-КОМАНДА (решение владельца 15.11.2026).
// Таска сразу стартует с тремя вымышленными сотрудниками и их задачами — пустой календарь
// плохо показывает, на что годится система. Отдельный шаг «оживить демо» больше не нужен.
//
//   логин    пароль                              кто
//   admin    случайный, вида xxxx-xxxx-xxxx      Анна Соколова — администратор
//   manager  нет (войти нельзя)                  Игорь Волков  — руководитель (обычный пользователь)
//   user     нет (войти нельзя)                  Мария Лебедева — сотрудник
//
// ⚠️ Пароль 123456 у всех троих был раньше — на открытом сайте, где логины расписаны в README,
//    им мог войти любой. Теперь у Игоря и Марии пароля нет вовсе: они видны как исполнители,
//    но войти под ними нельзя, пока администратор не задаст пароль карандашом в «Команде».
//
// ⚠️ ГДЕ ПАРОЛЬ АДМИНИСТРАТОРА. Не в журнале (пропадает при пересоздании контейнера, а журнал
//    ученики показывают помощнику целиком), не в .env и не в базе (уехал бы в копии и на ноутбук).
//    Он в файле api/.first-login (в контейнере /app/.first-login), права 0600, в git не попадает.
//    Показывает его только scripts/first-login.sh — то есть только тот, у кого есть доступ к серверу.
//    Ни одного адреса в API, который отдаёт этот файл, нет и быть не должно.
//    Запасной путь — только если записку сохранить не удалось (кончился диск и т. п.): тогда пароль
//    один раз печатается в журнал, и scripts/first-login.sh сам находит его там, сверяет с базой
//    и перекладывает в записку (независимая проверка 16.11).
//
// ⚠️ ЗАПИСКА — В ДВА ШАГА (независимая проверка 16.11). До commit она пишется в .first-login.pending,
//    после commit — переименовывается в .first-login. Сбой commit не портит прежнюю действующую записку,
//    а если процесс упал между commit и переименованием, demo-cli show под тем же замком сверит .pending
//    с базой и доведёт дело. Пока идёт посадка или сброс, show ждёт замка — и не стирает записку
//    про ещё не закоммиченного администратора.
//
// ⚠️ СТАРЫЕ УСТАНОВКИ (до 16.11, был шаг «Оживить» — старый demo-reset.sh с паролем 123456 у admin,
//    manager и user). При каждом старте api под тем же замком: у manager и user с паролем 123456 вход
//    закрывается (password_hash = NULL, задачи остаются), у admin с 123456 — новый случайный пароль и
//    записка, как при первом запуске. Повторный старт ничего не меняет: 123456 уже нет.

export const FIRST_LOGIN_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.first-login');

export type FirstLogin = { login: string; password: string; user_id: string; demo: boolean; created_at?: string };

// 12 знаков без похожих (0/O/o, 1/l/I/i) — около 69 бит; только латиница и цифры, как требует вход
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newPassword(): string {
  const part = () => Array.from({ length: 4 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
  return `${part()}-${part()}-${part()}`;
}

// Записка пишется во временный файл и переименовывается: оборванная запись не оставит полфайла.
// Возвращает текст ошибки или null.
function writeNote(file: string, rec: Omit<FirstLogin, 'created_at'>): string | null {
  const tmp = file + '.tmp';
  try {
    try { fs.unlinkSync(tmp); } catch { /* его и не было */ }
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify({ ...rec, created_at: new Date().toISOString() }) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    return null;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return (e as Error).message;
  }
}

// записка «до commit» (независимая проверка 16.11): действующей становится только после удачного commit
export const PENDING_FILE = FIRST_LOGIN_FILE + '.pending';

// сразу действующая записка — только для пароля, который уже точно в базе (show нашёл его в журнале)
export function saveFirstLogin(rec: Omit<FirstLogin, 'created_at'>): string | null {
  return writeNote(FIRST_LOGIN_FILE, rec);
}
export function stageFirstLogin(rec: Omit<FirstLogin, 'created_at'>): string | null {
  return writeNote(PENDING_FILE, rec);
}
// после удачного commit: .pending → .first-login одним переименованием
export function promoteFirstLogin(): string | null {
  try { fs.renameSync(PENDING_FILE, FIRST_LOGIN_FILE); return null; } catch (e) { return (e as Error).message; }
}
export function dropPendingFirstLogin(): void {
  try { fs.unlinkSync(PENDING_FILE); } catch { /* её и не было */ }
}

// null — записки нет; 'broken' — файл есть, но прочитать его нельзя
export function readFirstLogin(file: string = FIRST_LOGIN_FILE): FirstLogin | null | 'broken' {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try {
    const r = JSON.parse(raw);
    if (r && typeof r.password === 'string' && typeof r.user_id === 'string') return r as FirstLogin;
  } catch { /* ниже */ }
  return 'broken';
}

// Пароль сменили — записка больше не нужна. С userId стираем, только если записка про этого человека.
// И действующую, и ещё не переложенную .pending (независимая проверка 16.11).
export function forgetFirstLogin(userId?: string): void {
  for (const file of [FIRST_LOGIN_FILE, PENDING_FILE]) {
    try {
      if (userId) {
        const r = readFirstLogin(file);
        if (!r || (r !== 'broken' && r.user_id !== userId)) continue;
      }
      fs.unlinkSync(file);
    } catch { /* записки нет — и хорошо */ }
  }
}

// commit вместе с запиской (независимая проверка 16.11). Возвращает ошибку записи .pending
// (тогда пароля нет нигде, кроме памяти вызывающего, — пусть покажет его сам) или null.
// commit упал — .pending остаётся: commit мог и пройти, show сверит её с базой.
async function commitWithNote(client: PoolClient, rec: Omit<FirstLogin, 'created_at'>): Promise<string | null> {
  const err = stageFirstLogin(rec);
  await client.query('commit');
  if (err) return err;
  const moved = promoteFirstLogin();
  if (moved) console.error(`записку первого входа не удалось переложить на место (${moved}) — она в api/.first-login.pending, bash scripts/first-login.sh доведёт дело`);
  return null;
}

// значение из .env без комментария в хвосте («APP_HOST=… # цифры своего сервера»)
const envClean = (v: unknown) => String(v ?? '').replace(/(^|\s)#.*$/, '').trim().replace(/^["']|["']$/g, '');

// Адрес Таски для человека: из APP_HOST, как его видит Caddy. Локально (APP_HOST=:80) — http://localhost:порт.
export function appUrl(): string {
  let host = envClean(process.env.APP_HOST).split(/[\s,]+/)[0] || '';
  let scheme = 'https';
  const m = /^(https?):\/\//i.exec(host);
  if (m) { scheme = m[1].toLowerCase(); host = host.slice(m[0].length); }
  host = host.replace(/\/.*$/, '');
  if (!host || host.startsWith(':') || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) {
    const bind = envClean(process.env.HTTP_BIND) || '127.0.0.1:8088';
    const port = (/(?:^|:)(\d+)$/.exec(bind) || [])[1] || '8088';
    return port === '80' ? 'http://localhost' : `http://localhost:${port}`;
  }
  return `${scheme}://${host}`;
}

// DEMO_SEED: по умолчанию включено; выключают 0 / off / no / false (до первого запуска)
export function demoSeedOn(): boolean {
  return !/^(0|off|no|false|нет)$/i.test(envClean(process.env.DEMO_SEED));
}

export function plural(n: number, one: string, few: string, many: string): string {
  const a = n % 10, b = n % 100;
  const w = a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
  return `${n} ${w}`;
}

// ---------------- демо-команда ----------------
type Who = 'admin' | 'manager' | 'user';
// (смещение дня от «сегодня», время, название, метки, соисполнители, описание)
type Item = [number, string | null, string, string[], Who[], string];

const PEOPLE: { who: Who; name: string; role: 'admin' | 'member'; avatar: number }[] = [
  { who: 'admin', name: 'Анна Соколова', role: 'admin', avatar: 0 },
  { who: 'manager', name: 'Игорь Волков', role: 'member', avatar: 4 },
  { who: 'user', name: 'Мария Лебедева', role: 'member', avatar: 8 },
];
const TAGS: [string, string][] = [['Клиенты', 'blue'], ['Срочно', 'red'], ['Склад', 'yellow'], ['Офис', 'green'], ['Финансы', 'purple']];
const CL = (t: string) => `<div class="cl-item"><span class="cl-box" contenteditable="false"></span>${t}</div>`;

const PLAN: Record<Who, Item[]> = {
  admin: [
    [-2, '10:00', 'Согласовать бюджет на четвёртый квартал', ['Финансы'], ['manager'], '<div>Свести цифры по отделам.</div>' + CL('Собрать заявки') + CL('Показать директору')],
    [0, '09:30', 'Планёрка с руководителями', ['Офис'], ['manager', 'user'], ''],
    [0, null, 'Подписать договор с «Северстрой»', ['Клиенты', 'Срочно'], [], '<div>Договор согласован юристами, осталась подпись.</div>'],
    [1, '14:00', 'Собеседование на должность менеджера', ['Офис'], [], ''],
    [1, null, 'Проверить отчёт по продажам за неделю', ['Финансы'], ['manager'], ''],
    [2, '11:00', 'Встреча с банком по кредитной линии', ['Финансы'], [], ''],
    [3, null, 'Обновить регламент отпусков', ['Офис'], [], ''],
    [4, '16:00', 'Итоги месяца с командой', ['Офис'], ['manager', 'user'], ''],
    [7, null, 'Продлить страховку офиса', ['Офис', 'Финансы'], [], ''],
    [9, null, 'Заказать новогодние подарки клиентам', ['Клиенты'], ['user'], ''],
  ],
  manager: [
    [-1, '12:00', 'Отправить коммерческое предложение «Ремстрой»', ['Клиенты'], [], ''],
    [0, '11:30', 'Созвон с поставщиком по срокам', ['Склад', 'Срочно'], [], '<div>Уточнить дату поставки плитки.</div>'],
    [0, null, 'Подготовить смету для «Уютного дома»', ['Клиенты'], ['user'], ''],
    [1, '10:00', 'Проверить остатки на складе', ['Склад'], [], ''],
    [1, null, 'Согласовать график доставок на неделю', ['Склад'], [], ''],
    [2, '15:00', 'Показ объекта заказчику', ['Клиенты'], [], ''],
    [3, null, 'Собрать отзывы с последних трёх объектов', ['Клиенты'], ['user'], ''],
    [5, '13:00', 'Обучение новых сотрудников по складу', ['Склад', 'Офис'], [], ''],
    [6, null, 'Пересчитать цены с учётом новых закупок', ['Финансы'], [], ''],
    [8, null, 'План продаж на следующий месяц', ['Финансы'], [], ''],
  ],
  user: [
    [-1, null, 'Позвонить клиенту по рекламации', ['Клиенты', 'Срочно'], [], ''],
    [0, '10:00', 'Выставить счета за неделю', ['Финансы'], [], ''],
    [0, null, 'Разобрать почту и ответить клиентам', ['Клиенты'], [], ''],
    [1, '09:00', 'Принять поставку на склад', ['Склад'], [], CL('Сверить по накладной') + CL('Сфотографировать брак')],
    [1, '15:30', 'Записать клиента на замер', ['Клиенты'], [], ''],
    [2, null, 'Обновить прайс на сайте', ['Офис'], [], ''],
    [3, '12:00', 'Отвезти документы в налоговую', ['Финансы'], [], ''],
    [4, null, 'Заказать канцелярию в офис', ['Офис'], [], ''],
    [6, null, 'Подготовить фото объектов для соцсетей', ['Клиенты'], [], ''],
    [10, null, 'Инвентаризация склада', ['Склад'], [], ''],
  ],
};
const ESTIMATE = 'Подготовить смету для «Уютного дома»';
const SUBTASKS = ['Замерить помещение', 'Посчитать материалы', 'Отправить смету клиенту'];

// tasks — задачи верхнего уровня, subtasks — подзадачи: «30 задач и 3 подзадачи», как в курсе (независимая проверка 16.11)
export type Seeded = { adminId: string; users: number; tasks: number; subtasks: number; tags: number };

// Сажает демо-команду ВНУТРИ уже открытой транзакции (её открывает и закрывает вызывающий).
// База должна быть пустой по людям, задачам и меткам — это проверяет вызывающий.
export async function seedDemo(client: PoolClient, adminPw: string): Promise<Seeded> {
  // «сегодня» — в поясе команды, как у автопереноса просроченного (crud.ts). Дату считает база:
  // JS-объект Date драйвер pg превратил бы в полночь по местному времени контейнера.
  const tz = String(process.env.APP_TZ || 'Europe/Moscow');
  const id: Record<Who, string> = { admin: '', manager: '', user: '' };
  // clock_timestamp(), а не now(): внутри одной транзакции now() у всех строк одинаковое,
  // и списки «по времени создания» (Делегированные, продавцы CRM) прыгали бы местами.
  for (const p of PEOPLE) {
    const r = await client.query(
      `insert into users(name, email, password_hash, role, active, avatar_no, created_at)
       values($1,$2,$3,$4,true,$5,clock_timestamp()) returning id`,
      [p.name, p.who, p.who === 'admin' ? hashPassword(adminPw) : null, p.role, p.avatar],
    );
    id[p.who] = r.rows[0].id;
  }
  const tag: Record<string, string> = {};
  for (const [name, color] of TAGS) {
    const r = await client.query('insert into tags(name, color_key) values($1,$2) returning id', [name, color]);
    tag[name] = r.rows[0].id;
  }
  const task: Record<string, string> = {};
  let tasks = 0;
  for (const who of ['admin', 'manager', 'user'] as Who[]) {
    for (const [off, time, name, tags, co, desc] of PLAN[who]) {
      const r = await client.query(
        `insert into tasks(name, due_date, due_time, assignee_id, author_id, description, created_at)
         values($1, (now() at time zone $2)::date + $3::int, $4::time, $5, $5, $6, clock_timestamp()) returning id`,
        [name, tz, off, time, id[who], desc ? sanitizeDescription(desc) : null],
      );
      const tid = r.rows[0].id as string;
      task[`${who}:${name}`] = tid;
      tasks++;
      for (const c of co) if (c !== who) {
        await client.query('insert into task_co_assignees(task_id, user_id) values($1,$2)', [tid, id[c]]);
      }
      let pos = 0;
      for (const t of tags.slice(0, 2)) {
        await client.query('insert into task_tags(task_id, tag_id, pos) values($1,$2,$3)', [tid, tag[t], pos++]);
      }
    }
  }
  // подзадачи, комментарии, повторение — чтобы карточки были живыми
  const parent = task[`manager:${ESTIMATE}`];
  let subtasks = 0;
  for (const name of SUBTASKS) {
    await client.query(
      `insert into tasks(name, due_date, assignee_id, author_id, parent_id, created_at)
       values($1, (now() at time zone $2)::date + 1, $3, $4, $5, clock_timestamp())`,
      [name, tz, id.user, id.manager, parent],
    );
    subtasks++;
  }
  await client.query(
    `insert into comments(task_id, author_id, text, created_at) values
       ($1, $2, 'Замер сделаю завтра утром, материалы посчитаю к обеду.', now() - interval '2 hours'),
       ($1, $3, 'Хорошо. Смету нужно отправить до среды.', now() - interval '1 hour')`,
    [parent, id.user, id.manager],
  );
  await client.query(`update tasks set recurrence_type = 'weekly', recurrence_days = '{1}' where id = $1`, [task['admin:Планёрка с руководителями']]);
  await client.query(`update tasks set recurrence_type = 'weekly', recurrence_days = '{5}' where id = $1`, [task['user:Выставить счета за неделю']]);
  // пара завершённых — чтобы архив не был пустым
  await client.query('update tasks set archived = true, completed_at = now() where id = any($1::uuid[])',
    [[task['manager:Отправить коммерческое предложение «Ремстрой»'], task['user:Позвонить клиенту по рекламации']]]);
  return { adminId: id.admin, users: PEOPLE.length, tasks, subtasks, tags: TAGS.length };
}

// Стирает людей (кроме keepEmails — учётки телеграм-агента), задачи, метки, комментарии и карточки вложений.
// Сами файлы вложений в MinIO чистит scripts/demo-reset.sh.
export async function wipeForDemo(client: PoolClient, keepEmails: string[]): Promise<void> {
  await client.query('delete from comments; delete from task_tags; delete from task_co_assignees; delete from attachments; delete from tasks; delete from tags');
  await client.query('delete from users where lower(email) <> all($1::text[])', [keepEmails.map((e) => e.toLowerCase())]);
}

// общий замок первого запуска, сброса демо и show (demo-cli) — независимая проверка 16.11
export const LOCK = `select pg_advisory_xact_lock(hashtext('taska_first_start'))`;

// «30 задач и 3 подзадачи»
export function tasksText(tasks: number, subtasks: number): string {
  return `${plural(tasks, 'задача', 'задачи', 'задач')} и ${plural(subtasks, 'подзадача', 'подзадачи', 'подзадач')}`;
}

// Общий пароль 123456 от прежнего шага «Оживить» (старый demo-reset.sh, до 16.11) — независимая проверка 16.11.
// Внутри уже открытой транзакции под LOCK. manager и user (и выключенный admin) — вход закрыть: password_hash = NULL,
// задачи остаются. Включённый admin — новый случайный пароль; записку пишет вызывающий. Повторно — ничего: 123456 уже нет.
const OLD_DEMO_PASSWORD = '123456';
async function closeOldDemoPasswords(client: PoolClient): Promise<{ closed: string[]; admin: { id: string; password: string } | null }> {
  const rows = (await client.query(
    `select id, lower(email) as login, active, password_hash from users
      where lower(email) = any($1::text[]) and password_hash is not null order by lower(email)`,
    [['admin', 'manager', 'user']],
  )).rows as { id: string; login: string; active: boolean; password_hash: string }[];
  const closed: string[] = [];
  let admin: { id: string; password: string } | null = null;
  for (const r of rows) {
    if (!verifyPassword(OLD_DEMO_PASSWORD, r.password_hash)) continue;
    if (r.login === 'admin' && r.active) {
      const password = newPassword();
      await client.query('update users set password_hash = $1 where id = $2', [hashPassword(password), r.id]);
      admin = { id: r.id, password };
    } else {
      await client.query('update users set password_hash = null where id = $1', [r.id]);
      closed.push(r.login);
    }
  }
  return { closed, admin };
}

// При старте api, после миграций и до приёма запросов.
//   людей уже есть                      → только закрываем общий пароль 123456 от прежнего «Оживить» (см. выше);
//   DEMO_SEED не 0 и нет задач и меток  → демо-команда;
//   иначе (DEMO_SEED=0 или база вернулась из копии не целиком) → один администратор из ADMIN_EMAIL, как раньше.
// Посадка демо упала — откат и один администратор: Таска запускается в любом случае.
export async function firstStart(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(LOCK);   // два api разом (перезапуск внахлёст) не посадят демо дважды
    const c = (await client.query(
      'select (select count(*) from users)::int as users, (select count(*) from tasks)::int as tasks, (select count(*) from tags)::int as tags',
    )).rows[0];
    if (c.users > 0) {
      const old = await closeOldDemoPasswords(client);
      if (old.admin) {
        const err = await commitWithNote(client, { login: 'admin', password: old.admin.password, user_id: old.admin.id, demo: true });
        const was = 'у admin был общий пароль 123456 (от прежнего шага «Оживить») — задан новый случайный';
        if (!err) console.log(`ADMIN_BOOTSTRAP ${was}: адрес, логин и пароль — bash scripts/first-login.sh`);
        else console.log(`ADMIN_BOOTSTRAP ${was}: вход admin, пароль ${old.admin.password} — записку api/.first-login сохранить не удалось (${err}), поэтому пароль здесь, один раз: перепишите его сейчас`);
      } else {
        await client.query('commit');
      }
      if (old.closed.length) {
        console.log(`Вход ${old.closed.join(', ')} закрыт: был общий пароль 123456 (от прежнего шага «Оживить»). ` +
          'Задачи остались; пароль, если нужен, задаёт администратор карандашом в «Команде».');
      }
      return;
    }

    if (demoSeedOn() && c.tasks === 0 && c.tags === 0) {
      const pw = newPassword();
      let seeded: Seeded | null = null;
      await client.query('savepoint demo');
      try {
        seeded = await seedDemo(client, pw);
      } catch (e) {
        await client.query('rollback to savepoint demo');
        console.error(`DEMO_SEED не удалось: ${(e as Error).message} — завожу одного администратора, как при DEMO_SEED=0`);
      }
      if (seeded) {
        const what = `демо-команда готова (${plural(seeded.users, 'человек', 'человека', 'человек')}, ${tasksText(seeded.tasks, seeded.subtasks)}, ${plural(seeded.tags, 'метка', 'метки', 'меток')})`;
        const err = await commitWithNote(client, { login: 'admin', password: pw, user_id: seeded.adminId, demo: true });
        if (!err) console.log(`ADMIN_BOOTSTRAP ${what}: вход admin — адрес, логин и пароль: bash scripts/first-login.sh`);
        else console.log(`ADMIN_BOOTSTRAP ${what}: вход admin, пароль ${pw} — записку api/.first-login сохранить не удалось (${err}), поэтому пароль здесь, один раз: перепишите его сейчас`);
        return;
      }
    }

    const email = envClean(process.env.ADMIN_EMAIL).toLowerCase() || 'admin@example.com';
    const pw = newPassword();
    const r = await client.query(
      `insert into users(name, email, password_hash, role, active) values($1,$2,$3,'admin',true) returning id`,
      ['Администратор', email, hashPassword(pw)],
    );
    const err = await commitWithNote(client, { login: email, password: pw, user_id: r.rows[0].id, demo: false });
    if (!err) console.log(`ADMIN_BOOTSTRAP login=${email} — пароль: bash scripts/first-login.sh`);
    else console.log(`ADMIN_BOOTSTRAP login=${email} temp_password=${pw} — записку api/.first-login сохранить не удалось (${err}), поэтому пароль здесь, один раз: перепишите его сейчас`);
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Сбросить всё и посадить демо заново — одной транзакцией: при сбое база остаётся как была.
export async function resetDemo(pool: Pool, keepEmails: string[]): Promise<Seeded & { password: string; saveError: string | null }> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(LOCK);
    await wipeForDemo(client, keepEmails);
    const password = newPassword();
    const seeded = await seedDemo(client, password);
    const saveError = await commitWithNote(client, { login: 'admin', password, user_id: seeded.adminId, demo: true });
    return { ...seeded, password, saveError };
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
