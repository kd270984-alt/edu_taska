import type { Express, Response } from 'express';
import type { Pool } from 'pg';
import { requireAuth, requireRole, hashPassword, verifyToken, type AuthedRequest, type JwtUser } from './auth.ts';
import { sanitizeDescription } from './html.ts';
import * as Minio from 'minio';
import multer from 'multer';

// MinIO для вложений (в docker-сети host = minio:9000; браузер MinIO не видит — качаем через стрим API)
const mc = new Minio.Client({
  endPoint: (process.env.MINIO_ENDPOINT || 'minio:9000').split(':')[0],   // endPoint — только хост, без порта
  port: Number((process.env.MINIO_ENDPOINT || 'minio:9000').split(':')[1] || 9000),
  useSSL: false,
  accessKey: process.env.MINIO_ROOT_USER || '',
  secretKey: process.env.MINIO_ROOT_PASSWORD || '',
});
const ATTACH_BUCKET = process.env.MINIO_BUCKET || 'attachments';
let bucketReady = false;
async function ensureBucket(): Promise<void> {
  if (bucketReady) return;
  const ex = await mc.bucketExists(ATTACH_BUCKET).catch(() => false);
  if (!ex) await mc.makeBucket(ATTACH_BUCKET).catch(() => {});
  bucketReady = true;
}
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// --- помощники прав ---
async function canViewTask(pool: Pool, user: JwtUser, taskId: string): Promise<boolean> {
  // РОЛЬ НЕ ДАЁТ ВИДИМОСТИ: даже admin/manager читают только задачи,
  // где они ответственный или соисполнитель. АВТОР — исключение: он должен открывать
  // то, что сам поручил (раздел «Делегированные»), иначе поручение нельзя проконтролировать.
  const t = await pool.query('select assignee_id, author_id from tasks where id = $1', [taskId]);
  if (!t.rows[0]) return false;
  if (t.rows[0].assignee_id === user.id) return true;
  if (t.rows[0].author_id === user.id) return true;
  if (await ownsViaParent(pool, user, taskId)) return true;   // ответственный родителя видит свою подзадачу
  const co = await pool.query('select 1 from task_co_assignees where task_id = $1 and user_id = $2 limit 1', [taskId, user.id]);
  return (co.rowCount ?? 0) > 0;
}
// доступ к ВЛОЖЕНИЯМ задачи = доступ к задаче ИЛИ авторство.
// Автор нужен, потому что он их и прикладывает, поручая задачу: приложить и не видеть список — бессмыслица.
// На описание и комментарии авторство прав по-прежнему НЕ даёт.
async function canViewTaskFiles(pool: Pool, user: JwtUser, taskId: string): Promise<boolean> {
  if (await canViewTask(pool, user, taskId)) return true;
  const r = await pool.query('select 1 from tasks where id = $1 and author_id = $2 limit 1', [taskId, user.id]);
  return (r.rowCount ?? 0) > 0;
}

// доступ к конкретному вложению по его сущности (download: write=false, delete: write=true)
async function canTouchAttachment(pool: Pool, user: JwtUser, attId: string, write: boolean): Promise<boolean> {
  const a = await pool.query('select entity_type, entity_id from attachments where id = $1', [attId]);
  if (!a.rows[0]) return false;
  const { entity_type, entity_id } = a.rows[0];
  if (entity_type === 'task') return write ? canEditTask(pool, user, entity_id) : canViewTaskFiles(pool, user, entity_id);
  return user.role === 'admin';
}

// при удалении задачи подчищаем вложения: файлы в MinIO + строки в БД (FK-каскада нет)
async function wipeAttachments(pool: Pool, entityType: string, entityId: string): Promise<void> {
  const rows = await pool.query('select storage_key from attachments where entity_type=$1 and entity_id=$2', [entityType, entityId]);
  for (const a of rows.rows) await mc.removeObject(ATTACH_BUCKET, a.storage_key).catch(() => {});
  await pool.query('delete from attachments where entity_type=$1 and entity_id=$2', [entityType, entityId]);
}

async function canEditTask(pool: Pool, user: JwtUser, taskId: string): Promise<boolean> {
  if (user.role === 'viewer') return false;
  // роль не даёт и права правки: видимость и правка идут вместе, иначе получалось «не вижу, но могу изменить»
  const r = await pool.query(
    `select 1 from tasks t
      where t.id = $1 and (t.assignee_id = $2
        or exists (select 1 from task_co_assignees c where c.task_id = t.id and c.user_id = $2)) limit 1`,
    [taskId, user.id],   // менять карточку: ответственный или соисполнитель. Автор прав НЕ даёт.
  );
  if ((r.rowCount ?? 0) > 0) return true;
  return ownsViaParent(pool, user, taskId);   // ...и ответственный родительской задачи — в её подзадачах
}
// ТЕКУЩИЙ ответственный задачи — СТРОГО: БЕЗ обхода для admin/manager.
// Управление задачей (сменить ответственного, соисполнители, подзадачи, удаление) — только у того, кто СЕЙЧАС ответственный.
// Автор, отдав задачу другому, теряет управление. Правку базовых полей (имя/статус/описание) это НЕ трогает — она в canEditTask.
async function isTaskAssignee(pool: Pool, user: JwtUser, taskId: string): Promise<boolean> {
  const r = await pool.query('select 1 from tasks where id = $1 and assignee_id = $2 limit 1', [taskId, user.id]);
  if ((r.rowCount ?? 0) > 0) return true;
  return ownsViaParent(pool, user, taskId);   // подзадачей распоряжается и ответственный родителя (завершить, переназначить, удалить)
}
// приложить файл к задаче может ответственный, соисполнитель ИЛИ автор.
// Автор нужен отдельно: он создаёт задачу для другого и прикладывает материалы — без этого
// вложения при делегировании отбивались 403 (правку карточки авторство по-прежнему НЕ даёт).
async function canAttachToTask(pool: Pool, user: JwtUser, taskId: string): Promise<boolean> {
  if (await canEditTask(pool, user, taskId)) return true;
  const r = await pool.query('select 1 from tasks where id = $1 and author_id = $2 limit 1', [taskId, user.id]);
  return (r.rowCount ?? 0) > 0;
}
// Ответственный РОДИТЕЛЬСКОЙ задачи (на любой глубине) распоряжается её подзадачами как своими —
// правило: «если я назначил подзадачу к своей задаче, я могу менять в ней всё,
// даже если ответственный там другой». Иначе декомпозицией нельзя было управлять.
async function ownsViaParent(pool: Pool, user: JwtUser, taskId: string): Promise<boolean> {
  const r = await pool.query(
    `with recursive up as (
       select parent_id from tasks where id = $1 and parent_id is not null
       union all
       select t.parent_id from tasks t join up on t.id = up.parent_id where t.parent_id is not null)
     select 1 from tasks p join up on p.id = up.parent_id where p.assignee_id = $2 limit 1`,
    [taskId, user.id]);
  return (r.rowCount ?? 0) > 0;
}

// объект лежит в корзине? (правки в него не пускаем — сначала «Вернуть»)
async function inTrash(pool: Pool, table: 'tasks', id: string): Promise<boolean> {
  const r = await pool.query(`select 1 from ${table} where id = $1 and deleted_at is not null limit 1`, [id]);
  return (r.rowCount ?? 0) > 0;
}
// та же защита для ПОДРЕСУРСОВ (комментарий/пункт чек-листа/вложение), у которых на руках только их собственный id:
// поднимаемся к родительской задаче/проекту и смотрим, не в корзине ли он.
async function ownerInTrash(pool: Pool, kind: 'comment' | 'attachment', id: string): Promise<boolean> {
  const sql = kind === 'comment'
    ? `select 1 from comments c join tasks t on t.id = c.task_id where c.id = $1 and t.deleted_at is not null limit 1`
    : `select 1 from attachments a
         join tasks t on a.entity_type = 'task' and t.id = a.entity_id
        where a.id = $1 and t.deleted_at is not null limit 1`;
  const r = await pool.query(sql, [id]);
  return (r.rowCount ?? 0) > 0;
}
const TRASH_MSG = 'объект в корзине — сначала верните его из архива';

// безопасный частичный UPDATE: имена колонок только из белого списка
// Дата задачи ОБЯЗАТЕЛЬНА: календарь — единственный вид,
// задаче без даты в продукте негде жить. Проверяем на сервере, а не только в форме:
// в базу ходит и телеграм-агент.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isoDay(v: unknown): string | null {
  const s = String(v ?? '').slice(0, 10);
  return DATE_RE.test(s) && !isNaN(Date.parse(s)) ? s : null;
}

// Учётка телеграм-агента служебная: человеку её выбирать незачем, поэтому из списков людей её прячем.
// Она остаётся полноценным пользователем — просто не показывается в интерфейсе.
const AGENT_EMAIL = (process.env.AGENT_EMAIL || '').toLowerCase();
const HIDE_AGENT = AGENT_EMAIL ? 'and lower(email) <> $1' : '';
const hideAgentArgs = AGENT_EMAIL ? [AGENT_EMAIL] : [];

function buildUpdate(allowed: string[], body: Record<string, unknown>) {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      params.push(body[k]);
      sets.push(`${k} = $${params.length}`);
    }
  }
  return { sets, params };
}

const fail = (res: Response, code: number, error: string) => res.status(code).json({ ok: false, error });
const oops = (res: Response, e: unknown) => {
  const code = (e as { code?: string }).code;
  if (code === '22P02' || code === '22007') return res.status(400).json({ ok: false, error: 'некорректный формат данных' });   // битый uuid/дата — 400, не 500 с сырой ошибкой PG
  if (code === '23505') return res.status(400).json({ ok: false, error: 'такой логин уже занят' });   // unique violation (email)
  // ⚠️ Владельцу видно только слово «логин»: почты в продукте нет, адрес — это просто логин (правка 20.09.2026).
  return res.status(500).json({ ok: false, error: (e as Error).message });
};

export function registerCrud(app: Express, pool: Pool): void {
  // ---------- TASKS ----------
  app.get('/api/tasks', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const u = req.user!;
      const where: string[] = [];
      const params: unknown[] = [];
      // по умолчанию активные; ?archived=1 — завершённые; ?deleted=1 — корзина (удалённые не смешиваются с завершёнными)
      if (req.query.deleted) where.push('t.deleted_at is not null');
      else { where.push(req.query.archived ? 't.archived = true' : 't.archived = false'); where.push('t.deleted_at is null'); }
      // видит ТОЛЬКО свои задачи: где он ответственный или соисполнитель — для ВСЕХ ролей, включая admin/manager (единое пространство «каждый видит своё»).
      // Ни автор, ни допуск к проекту сами по себе задачу не открывают. Расширенные права роли (правка/удаление любой задачи) живут в canEditTask/isTaskAssignee и от видимости не зависят.
      {
        params.push(u.id);
        const i = params.length;
        where.push(`(t.assignee_id = $${i} or exists (select 1 from task_co_assignees c where c.task_id = t.id and c.user_id = $${i}))`);
      }
      const sql = `select t.*,
                     (select p.assignee_id from tasks p where p.id = t.parent_id) as parent_assignee_id,
                     (select count(*) from comments cm where cm.task_id = t.id)::int as comments_count,
                     coalesce((select array_agg(c.user_id) from task_co_assignees c where c.task_id = t.id), '{}') as co_assignees,
                     coalesce((select array_agg(tt.tag_id order by tt.pos) from task_tags tt where tt.task_id = t.id), '{}') as tags
                   from tasks t ${where.length ? 'where ' + where.join(' and ') : ''} order by t.created_at desc`;
      const r = await pool.query(sql, params);
      res.json({ ok: true, tasks: r.rows });
    } catch (e) { oops(res, e); }
  });

  // АВТОПЕРЕНОС просроченных задач на сегодня — ОДНИМ запросом НА СЕРВЕРЕ.
  // Почему здесь, а не в браузере: раньше перенос делал фронт — шёл по своему списку задач
  // В ПАМЯТИ и патчил каждую дату отдельным PATCH. Список в памяти мог быть устаревшим
  // (страница на телефоне спала сутками, проснулась, сеть ещё не поднялась, а таймер смены
  // суток уже сработал), и перенос затирал СВЕЖИЕ даты: задачи, отложенные на будущее
  // с другого устройства, возвращались на сегодня. Инцидент 18.09.2026 — так вернулись
  // девять задач, отложенных 15–16.09 на 19.09–08.10. Здесь состояние читается и пишется
  // одним запросом: устаревшим оно быть не может по построению.
  //
  // ⚠️ ДЕНЬ СЧИТАЕТ СЕРВЕР, И ТОЛЬКО СЕРВЕР. Первая версия этой правки принимала дату
  // от клиента (у сервера часы UTC, у людей московские, и с 00:00 до 03:00 местные сутки
  // уже новые). Ревью показало, чем это кончится: планшет с убежавшими на сутки часами
  // прислал бы «завтра», под условие `due_date < завтра` попали бы ВСЕ сегодняшние задачи,
  // и день вычистился бы целиком — на всех остальных устройствах, молча и необратимо
  // (перенос двигает только из прошлого, обратно он не вернёт). Поэтому даты снаружи
  // не принимаем вовсе, а московские сутки берём у самой базы: работает одинаково
  // и в контейнере с часами UTC, и в хостовом кластере после переезда.
  //
  // Кого двигаем: ровно тех, кого этот человек и так видит, — свои задачи и те, где он
  // соисполнитель (то же правило, что в GET /api/tasks). Роль проверяем middleware, как
  // у остальных пишущих маршрутов: у наблюдателя (viewer) прежний путь через PATCH падал
  // в canEditTask, и без requireRole сервер начал бы двигать даты тому, кому правка запрещена.
  // Перенос просроченного на сегодня ВКЛЮЧЁН. Выключить — поставить false: фронт продолжит
  // спрашивать эндпоинт при каждом обновлении и будет получать «переехало 0».
  const ROLLOVER_ENABLED = true;
  app.post('/api/tasks/rollover', requireAuth, requireRole('admin', 'manager', 'member'), async (req: AuthedRequest, res) => {
    try {
      if (!ROLLOVER_ENABLED) { res.locals.silent = true; res.json({ ok: true, moved: 0, disabled: true }); return; }
      const r = await pool.query(
        `with d as (select (now() at time zone $2)::date as today)
         update tasks t set due_date = (select today from d)
          where t.due_date < (select today from d)
            and t.archived = false and t.deleted_at is null
            and (t.assignee_id = $1 or exists (
                  select 1 from task_co_assignees c where c.task_id = t.id and c.user_id = $1))
          returning t.id`,
        [req.user!.id, APP_TZ]);
      const moved = r.rowCount ?? 0;
      if (moved === 0) res.locals.silent = true;   // ничего не переехало — не рассылаем «изменилось»
      res.json({ ok: true, moved });
    } catch (e) { oops(res, e); }
  });

  app.post('/api/tasks', requireAuth, requireRole('admin', 'manager', 'member'), async (req: AuthedRequest, res) => {
    try {
      const { name, due_date, due_time, assignee_id, description, parent_id,
        recurrence_type, recurrence_days, recurrence_day_of_month, recurrence_date } = req.body ?? {};
      if (!name) return fail(res, 400, 'Укажите название задачи');
      const dueDay = isoDay(due_date);
      if (!dueDay) return fail(res, 400, 'Укажите дату выполнения — задача живёт в календаре');
      // подзадачу (parent_id) создаёт ТОЛЬКО ответственный родителя (или admin/manager) — соисполнитель не может
      if (parent_id && !(await isTaskAssignee(pool, req.user!, parent_id))) return fail(res, 403, 'подзадачи создаёт только ответственный задачи');
      if (parent_id && await inTrash(pool, 'tasks', parent_id)) return fail(res, 400, 'родительская задача в корзине');
      const dueTime = due_time ?? null;   // время остаётся необязательным
      // ответственный не назван — задача достаётся тому, кто её создаёт (иначе она была бы не видна никому)
      const r = await pool.query(
        `insert into tasks(name, due_date, due_time, assignee_id, description, parent_id, author_id,
           recurrence_type, recurrence_days, recurrence_day_of_month, recurrence_date)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
        [name, dueDay, dueTime, assignee_id ?? req.user!.id, description == null ? null : sanitizeDescription(description), parent_id ?? null, req.user!.id,
          recurrence_type ?? 'none', recurrence_days ?? null, recurrence_day_of_month ?? null, recurrence_date ?? null],
      );
      const nt = r.rows[0];
      // Соисполнители, метки и чек-лист кладём ЗДЕСЬ ЖЕ, правами создателя.
      // Отдельными запросами это не работало при делегировании: их гейты требуют быть ответственным,
      // а автор, поручив задачу другому, им не является — всё молча отваливалось в 403.
      const body2 = req.body ?? {};
      if (Array.isArray(body2.co_assignees)) {
        for (const uid of body2.co_assignees) if (typeof uid === 'string' && uid && uid !== nt.assignee_id)
          await pool.query('insert into task_co_assignees(task_id, user_id) values($1,$2) on conflict do nothing', [nt.id, uid]);
      }
      if (Array.isArray(body2.tag_ids) && body2.tag_ids.length) {
        let pos = 0;
        for (const tid of body2.tag_ids.slice(0, 2)) if (typeof tid === 'string' && tid)
          await pool.query('insert into task_tags(task_id, tag_id, pos) values($1,$2,$3) on conflict do nothing', [nt.id, tid, pos++]);
      }
      res.status(201).json({ ok: true, task: nt });
    } catch (e) { oops(res, e); }
  });

  app.patch('/api/tasks/:id', requireAuth, async (req: AuthedRequest, res) => {
    try {
      if (!(await canEditTask(pool, req.user!, req.params.id))) return fail(res, 403, 'forbidden');
      if (await inTrash(pool, 'tasks', req.params.id)) return fail(res, 400, 'задача в корзине — сначала верните её из архива');
      const body = req.body ?? {};
      // ответственного можно только СМЕНИТЬ, но не убрать: пустой/null assignee молча игнорируем,
      // иначе задача осталась бы без ответственного и пропала бы из всех списков.
      if (body.assignee_id === null || body.assignee_id === '') delete body.assignee_id;
      // соисполнитель не может менять ответственного — молча выкидываем поле (право есть только у ответственного/админа)
      if (body.assignee_id !== undefined && !(await isTaskAssignee(pool, req.user!, req.params.id))) delete body.assignee_id;
      // ЗАВЕРШИТЬ задачу (в архив / completed_at) может только текущий ответственный — соисполнителю 403
      if ((body.archived === true || body.completed_at)
        && !(await isTaskAssignee(pool, req.user!, req.params.id))) return fail(res, 403, 'завершить задачу может только ответственный');
      // время не живёт без даты (защита для ЛЮБОГО клиента, не только веб-формы): снимаешь дату — время уходит вместе с ней;
      // ставишь время без даты (в запросе и в самой задаче) — время молча не сохраняем
      // ЖУРНАЛ ПРАВОК ДАТЫ (18.09.2026). У задач нет отметки «когда изменена», журнал действий
      // приложения пуст, запросов API не писал — и когда 18.09 десять задач уехали с будущих дней
      // на сегодня, назвать виновника было нечем. Теперь каждая правка даты называет человека.
      if (body.due_date !== undefined) {
        try {
          const cur = await pool.query('select due_date from tasks where id = $1', [req.params.id]);
          const was = cur.rows[0] ? String(cur.rows[0].due_date ?? '').slice(0, 10) : '?';
          const will = String(body.due_date ?? 'нет').slice(0, 10);
          if (was !== will) console.log(`[дата] ${new Date().toISOString()} задача=${req.params.id} ${was || 'нет'} -> ${will} человек=${req.user!.id} роль=${req.user!.role}`);
        } catch { /* журнал не должен мешать правке */ }
      }
      if (body.due_date !== undefined) {
        const d = isoDay(body.due_date);
        if (!d) return fail(res, 400, 'Дату убрать нельзя — задача живёт в календаре');
        body.due_date = d;
      }
      // ⚠️ Описание — разметка, и показывается оно через innerHTML. Чистим ВСЕГДА на входе (см. html.ts).
      if (typeof body.description === 'string') body.description = sanitizeDescription(body.description);
      const { sets, params } = buildUpdate(
        ['name', 'due_date', 'due_time', 'assignee_id', 'description',
          'parent_id', 'archived', 'completed_at', 'recurrence_type', 'recurrence_days',
          'recurrence_day_of_month', 'recurrence_date'],
        body,
      );
      if (!sets.length) return fail(res, 400, 'no fields to update');
      params.push(req.params.id);
      const r = await pool.query(`update tasks set ${sets.join(', ')} where id = $${params.length} returning *`, params);
      if (!r.rows[0]) return fail(res, 404, 'not found');
      res.json({ ok: true, task: r.rows[0] });
    } catch (e) { oops(res, e); }
  });

  // КОРЗИНА: удаление мягкое — задача уходит в «Архив» (deleted_at), данные и вложения сохраняются, можно вернуть.
  // Подзадачи уходят вместе с родителем и тем же временем — чтобы «Вернуть» подняло ровно ту же группу.
  app.delete('/api/tasks/:id', requireAuth, async (req: AuthedRequest, res) => {
    try {
      if (!(await isTaskAssignee(pool, req.user!, req.params.id))) return fail(res, 403, 'forbidden');   // удаляет только ответственный (или admin/manager), не соисполнитель
      // ?purge=1 — стереть НАВСЕГДА, минуя корзину. Только автор задачи: это отмена собственного создания (Ctrl+Z),
      // иначе отменённый черновик оседал бы в архиве как «удалённая задача».
      if (req.query.purge) {
        // Только АВТОР. Состояние задачи не важно: отмена создания (Ctrl+Z) часто прилетает уже после того,
        // как человек успел задачу удалить, — и раньше отмена падала с непонятным «стереть может только автор
        // и только не удалённую задачу». Свою собственную задачу автор вправе стереть в любом состоянии.
        const own = await pool.query('select 1 from tasks where id = $1 and author_id = $2 limit 1', [req.params.id, req.user!.id]);
        if (!own.rowCount) return fail(res, 403, 'стереть навсегда может только автор задачи');
        await pool.query('update tasks set parent_id = null where parent_id = $1', [req.params.id]);   // подзадачи не осиротить молча — открепляем явно
        await wipeAttachments(pool, 'task', req.params.id);
        const hard = await pool.query('delete from tasks where id = $1 returning id', [req.params.id]);
        if (!hard.rows[0]) return fail(res, 404, 'not found');
        return res.json({ ok: true, deleted: hard.rows[0].id, purged: true });
      }
      const r = await pool.query(
        `update tasks set deleted_at = now(), deleted_by = $2 where id = $1 and deleted_at is null returning id, deleted_at`,
        [req.params.id, req.user!.id]);
      if (!r.rows[0]) return fail(res, 404, 'not found');
      // всё дерево подзадач (любой глубины), тем же timestamp — «Вернуть» поднимет ровно эту группу
      const kids = await pool.query(
        `with recursive tree as (
           select id from tasks where parent_id = $1 and deleted_at is null
           union all
           select t.id from tasks t join tree on t.parent_id = tree.id where t.deleted_at is null)
         update tasks set deleted_at = $2, deleted_by = $3 where id in (select id from tree) returning id`,
        [req.params.id, r.rows[0].deleted_at, req.user!.id]);
      res.json({ ok: true, deleted: r.rows[0].id, subtasks: kids.rowCount ?? 0 });
    } catch (e) { oops(res, e); }
  });

  // вернуть задачу из корзины (вместе с подзадачами, ушедшими тем же действием)
  app.post('/api/tasks/:id/restore', requireAuth, async (req: AuthedRequest, res) => {
    try {
      if (!(await isTaskAssignee(pool, req.user!, req.params.id))) return fail(res, 403, 'вернуть задачу может только ответственный');
      const cur = await pool.query('select deleted_at from tasks where id = $1', [req.params.id]);
      if (!cur.rows[0]) return fail(res, 404, 'not found');
      const at = cur.rows[0].deleted_at;
      if (!at) return fail(res, 400, 'задача не в корзине');
      // родитель в корзине? тогда задача останется скрытой — возвращаем и его цепочку не трогаем, но предупреждаем клиента
      const r = await pool.query('update tasks set deleted_at = null, deleted_by = null where id = $1 returning *', [req.params.id]);
      await pool.query(
        `with recursive tree as (
           select id from tasks where parent_id = $1 and deleted_at = $2
           union all
           select t.id from tasks t join tree on t.parent_id = tree.id where t.deleted_at = $2)
         update tasks set deleted_at = null, deleted_by = null where id in (select id from tree)`,
        [req.params.id, at]);
      res.json({ ok: true, task: r.rows[0] });
    } catch (e) { oops(res, e); }
  });

  // СПАСАТЕЛЬНЫЙ ЛЮК ДЛЯ АДМИНА: передать задачу/проект другому ответственному.
  // Видимость чужого закрыта, из-за чего задача уволенного сотрудника
  // иначе оказался бы заперт навсегда — переназначить его не мог бы никто. Здесь НЕТ чтения содержимого:
  // только смена ответственного, и только для admin. В ответ отдаём лишь имя объекта, чтобы админ видел, что передал.
  app.post('/api/admin/reassign', requireAuth, requireRole('admin'), async (req: AuthedRequest, res) => {
    try {
      const { kind, id, assignee_id } = req.body ?? {};
      if (kind !== 'task' || !id || !assignee_id) return fail(res, 400, 'нужны kind (task), id и assignee_id');
      const u = await pool.query('select 1 from users where id = $1 and active = true limit 1', [assignee_id]);
      if (!u.rowCount) return fail(res, 400, 'новый ответственный не найден или заблокирован');
      const r = await pool.query('update tasks set assignee_id = $2 where id = $1 returning id, name', [id, assignee_id]);
      if (!r.rows[0]) return fail(res, 404, 'not found');
      res.json({ ok: true, kind, id: r.rows[0].id, name: r.rows[0].name, assignee_id });
    } catch (e) { oops(res, e); }
  });

  // «ДЕЛЕГИРОВАННЫЕ» — задачи, которые пользователь СОЗДАЛ (author_id), кому бы они ни были поручены.
  // Отдаём кратко (название, ответственный, сроки, статус) — это обзор поручений, а не доступ к чужим карточкам.
  // ?state=done — закрытые (завершённые), иначе в работе. Порядок — по дате создания, свежие сверху.
  app.get('/api/tasks/authored', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const done = String(req.query.state || '') === 'done';
      const r = await pool.query(
        `select t.id, t.name, t.assignee_id, t.due_date, t.due_time, t.archived, t.created_at, t.completed_at,
                t.parent_id,
                coalesce((select array_agg(c.user_id) from task_co_assignees c where c.task_id = t.id), '{}') as co_assignees
           from tasks t
          where t.author_id = $1 and t.assignee_id is distinct from $1 and t.deleted_at is null and t.archived = ${done ? 'true' : 'false'}
          order by t.created_at desc`,
        [req.user!.id]);
      res.json({ ok: true, tasks: r.rows });
    } catch (e) { oops(res, e); }
  });

  // одна задача целиком — нужна, чтобы открыть карточку из списка подзадач/архива, когда её нет в текущем списке
  // (например, СВОЯ завершённая подзадача: в «активных» её нет). Доступ — обычный: ответственный или соисполнитель.
  app.get('/api/tasks/:id', requireAuth, async (req: AuthedRequest, res) => {
    try {
      if (!(await canViewTask(pool, req.user!, req.params.id))) return fail(res, 403, 'forbidden');
      const r = await pool.query(
        `select t.*,
           (select p.assignee_id from tasks p where p.id = t.parent_id) as parent_assignee_id,
           coalesce((select array_agg(c.user_id) from task_co_assignees c where c.task_id = t.id), '{}') as co_assignees,
           coalesce((select array_agg(tt.tag_id order by tt.pos) from task_tags tt where tt.task_id = t.id), '{}') as tags
         from tasks t where t.id = $1`, [req.params.id]);
      if (!r.rows[0]) return fail(res, 404, 'not found');
      res.json({ ok: true, task: r.rows[0] });
    } catch (e) { oops(res, e); }
  });

  // СВОДКА ПОДЗАДАЧ для ответственного родителя.
  // Отдельный эндпоинт нужен потому, что общий список задач показывает только «свои» — и подзадача,
  // порученная другому человеку, пропадала из карточки родителя (получалось: делегировал и не видишь статус).
  // Отдаём КРАТКО (название, кто, срок, статус) — без описания, файлов и комментариев: это не доступ к чужой задаче.
  app.get('/api/tasks/:id/subtasks', requireAuth, async (req: AuthedRequest, res) => {
    try {
      if (!(await isTaskAssignee(pool, req.user!, req.params.id))) return fail(res, 403, 'подзадачи видит ответственный задачи');
      const r = await pool.query(
        `select t.id, t.name, t.assignee_id, t.due_date, t.due_time, t.archived, t.parent_id,
                coalesce((select array_agg(tt.tag_id order by tt.pos) from task_tags tt where tt.task_id = t.id), '{}') as tags
           from tasks t where t.parent_id = $1 and t.deleted_at is null
          order by t.archived, t.due_date, t.created_at`,
        [req.params.id]);
      res.json({ ok: true, subtasks: r.rows });
    } catch (e) { oops(res, e); }
  });

  // соисполнители задачи (заменить набор целиком)
  app.put('/api/tasks/:id/co-assignees', requireAuth, async (req: AuthedRequest, res) => {
    try {
      if (await inTrash(pool, 'tasks', req.params.id)) return fail(res, 400, TRASH_MSG);
      const ids = Array.isArray(req.body?.user_ids) ? req.body.user_ids.filter((x: unknown) => typeof x === 'string' && x) : [];
      const boss = await isTaskAssignee(pool, req.user!, req.params.id);   // ответственный/админ задаёт любой набор
      if (!boss) {
        // соисполнитель может ТОЛЬКО выйти сам: новый набор = старый минус он, и он там был
        const cur = await pool.query('select user_id from task_co_assignees where task_id = $1', [req.params.id]);
        const curIds = cur.rows.map((r) => r.user_id);
        const wasMember = curIds.includes(req.user!.id);
        const removedSelfOnly = wasMember && !ids.includes(req.user!.id)
          && curIds.filter((x) => x !== req.user!.id).every((x) => ids.includes(x))
          && ids.every((x: string) => curIds.includes(x));
        if (!removedSelfOnly) return fail(res, 403, 'соисполнителей меняет только ответственный');
      }
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('delete from task_co_assignees where task_id = $1', [req.params.id]);
        for (const uid of ids) {
          if (typeof uid === 'string' && uid) {
            await client.query('insert into task_co_assignees(task_id, user_id) values($1,$2) on conflict do nothing', [req.params.id, uid]);
          }
        }
        await client.query('commit');
      } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }
      res.json({ ok: true, user_ids: ids });
    } catch (e) { oops(res, e); }
  });

  // ---------- COMMENTS (комментарии задачи) ----------
  app.get('/api/tasks/:id/comments', requireAuth, async (req: AuthedRequest, res) => {
    try {
      if (!(await canViewTask(pool, req.user!, req.params.id))) return fail(res, 403, 'forbidden');
      const r = await pool.query(
        `select c.id, c.task_id, c.text, c.created_at, c.author_id, u.name as author_name
           from comments c left join users u on u.id = c.author_id
          where c.task_id = $1 order by c.created_at`, [req.params.id]);
      res.json({ ok: true, comments: r.rows });
    } catch (e) { oops(res, e); }
  });
  app.post('/api/tasks/:id/comments', requireAuth, async (req: AuthedRequest, res) => {
    try {
      if (await inTrash(pool, 'tasks', req.params.id)) return fail(res, 400, TRASH_MSG);
      if (!(await canViewTask(pool, req.user!, req.params.id))) return fail(res, 403, 'forbidden');
      const text = (req.body?.text ?? '').toString();
      if (!text.trim()) return fail(res, 400, 'text required');
      const r = await pool.query('insert into comments(task_id, author_id, text) values($1,$2,$3) returning id, task_id, text, created_at, author_id', [req.params.id, req.user!.id, text]);
      const u = await pool.query('select name from users where id = $1', [req.user!.id]);
      res.status(201).json({ ok: true, comment: { ...r.rows[0], author_name: u.rows[0]?.name } });
    } catch (e) { oops(res, e); }
  });
  app.delete('/api/comments/:id', requireAuth, async (req: AuthedRequest, res) => {
    try {
      if (await ownerInTrash(pool, 'comment', req.params.id)) return fail(res, 400, TRASH_MSG);
      const c = await pool.query('select author_id from comments where id = $1', [req.params.id]);
      if (!c.rows[0]) return fail(res, 404, 'not found');
      if (req.user!.role !== 'admin' && c.rows[0].author_id !== req.user!.id) return fail(res, 403, 'forbidden');
      await pool.query('delete from comments where id = $1', [req.params.id]);
      res.json({ ok: true, deleted: req.params.id });
    } catch (e) { oops(res, e); }
  });
  // правка текста комментария — автор или админ
  app.patch('/api/comments/:id', requireAuth, async (req: AuthedRequest, res) => {
    try {
      if (await ownerInTrash(pool, 'comment', req.params.id)) return fail(res, 400, TRASH_MSG);
      const text = (req.body?.text ?? '').toString();
      if (!text.trim()) return fail(res, 400, 'text required');
      const c = await pool.query('select author_id from comments where id = $1', [req.params.id]);
      if (!c.rows[0]) return fail(res, 404, 'not found');
      if (req.user!.role !== 'admin' && c.rows[0].author_id !== req.user!.id) return fail(res, 403, 'forbidden');
      const r = await pool.query('update comments set text = $1 where id = $2 returning id, task_id, text, created_at, author_id', [text, req.params.id]);
      res.json({ ok: true, comment: r.rows[0] });
    } catch (e) { oops(res, e); }
  });

  // ---------- TAGS (метки) ----------
  app.get('/api/tags', requireAuth, async (_req: AuthedRequest, res) => {
    try {
      const r = await pool.query('select id, name, color_key from tags order by name');
      res.json({ ok: true, tags: r.rows });
    } catch (e) { oops(res, e); }
  });
  // создание/правка/удаление меток — только админ; пользователи только выбирают из списка
  app.post('/api/tags', requireAuth, requireRole('admin'), async (req: AuthedRequest, res) => {
    try {
      const { name, color_key } = req.body ?? {};
      if (!name) return fail(res, 400, 'name required');
      const r = await pool.query('insert into tags(name, color_key) values($1,$2) returning id, name, color_key', [name, color_key ?? null]);
      res.status(201).json({ ok: true, tag: r.rows[0] });
    } catch (e) { oops(res, e); }
  });
  app.patch('/api/tags/:id', requireAuth, requireRole('admin'), async (req: AuthedRequest, res) => {
    try {
      const { sets, params } = buildUpdate(['name', 'color_key'], req.body ?? {});
      if (!sets.length) return fail(res, 400, 'no fields to update');
      params.push(req.params.id);
      const r = await pool.query(`update tags set ${sets.join(', ')} where id = $${params.length} returning id, name, color_key`, params);
      if (!r.rows[0]) return fail(res, 404, 'not found');
      res.json({ ok: true, tag: r.rows[0] });
    } catch (e) { oops(res, e); }
  });
  app.delete('/api/tags/:id', requireAuth, requireRole('admin'), async (req: AuthedRequest, res) => {
    try {
      await pool.query('delete from task_tags where tag_id = $1', [req.params.id]);
      const r = await pool.query('delete from tags where id = $1 returning id', [req.params.id]);
      if (!r.rows[0]) return fail(res, 404, 'not found');
      res.json({ ok: true });
    } catch (e) { oops(res, e); }
  });
  app.put('/api/tasks/:id/tags', requireAuth, async (req: AuthedRequest, res) => {
    try {
      if (await inTrash(pool, 'tasks', req.params.id)) return fail(res, 400, TRASH_MSG);
      if (!(await canEditTask(pool, req.user!, req.params.id))) return fail(res, 403, 'forbidden');
      const ids = (Array.isArray(req.body?.tag_ids) ? req.body.tag_ids : []).filter((x: unknown) => typeof x === 'string' && x).slice(0, 2);   // максимум 2 метки на задачу
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('delete from task_tags where task_id = $1', [req.params.id]);
        for (let i = 0; i < ids.length; i++) await client.query('insert into task_tags(task_id, tag_id, pos) values($1,$2,$3) on conflict do nothing', [req.params.id, ids[i], i]);   // pos = порядок в карточке
        await client.query('commit');
      } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }
      res.json({ ok: true, tag_ids: ids });
    } catch (e) { oops(res, e); }
  });

  // ---------- ATTACHMENTS (вложения задачи, файлы в MinIO) ----------
  app.get('/api/tasks/:id/attachments', requireAuth, async (req: AuthedRequest, res) => {
    try {
      if (!(await canViewTaskFiles(pool, req.user!, req.params.id))) return fail(res, 403, 'forbidden');
      const r = await pool.query(
        "select id, filename, content_type, size_bytes, created_at from attachments where entity_type='task' and entity_id=$1 order by created_at",
        [req.params.id]);
      res.json({ ok: true, attachments: r.rows });
    } catch (e) { oops(res, e); }
  });
  app.post('/api/tasks/:id/attachments', requireAuth, upload.single('file'), async (req: AuthedRequest, res) => {
    try {
      if (await inTrash(pool, 'tasks', req.params.id)) return fail(res, 400, TRASH_MSG);
      if (!(await canAttachToTask(pool, req.user!, req.params.id))) return fail(res, 403, 'forbidden');
      const f = (req as unknown as { file?: { buffer: Buffer; size: number; mimetype: string; originalname: string } }).file;
      if (!f) return fail(res, 400, 'file required');
      await ensureBucket();
      const key = req.params.id + '/' + Date.now() + '-' + Math.random().toString(36).slice(2);
      await mc.putObject(ATTACH_BUCKET, key, f.buffer, f.size, { 'Content-Type': f.mimetype });
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8');   // multer отдаёт не-ASCII имена в latin1
      const r = await pool.query(
        "insert into attachments(entity_type, entity_id, filename, storage_key, content_type, size_bytes) values('task',$1,$2,$3,$4,$5) returning id, filename, content_type, size_bytes, created_at",
        [req.params.id, name, key, f.mimetype, f.size]);
      res.status(201).json({ ok: true, attachment: r.rows[0] });
    } catch (e) { oops(res, e); }
  });
  app.get('/api/attachments/:id/download', requireAuth, async (req: AuthedRequest, res) => {
    try {
      if (!(await canTouchAttachment(pool, req.user!, req.params.id, false))) return fail(res, 403, 'forbidden');
      const a = await pool.query('select filename, storage_key, content_type from attachments where id=$1', [req.params.id]);
      if (!a.rows[0]) return fail(res, 404, 'not found');
      await ensureBucket();
      const stream = await mc.getObject(ATTACH_BUCKET, a.rows[0].storage_key);
      res.setHeader('Content-Type', a.rows[0].content_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(a.rows[0].filename));
      stream.pipe(res);
    } catch (e) { oops(res, e); }
  });
  app.delete('/api/attachments/:id', requireAuth, async (req: AuthedRequest, res) => {
    try {
      if (await ownerInTrash(pool, 'attachment', req.params.id)) return fail(res, 400, TRASH_MSG);
      if (!(await canTouchAttachment(pool, req.user!, req.params.id, true))) return fail(res, 403, 'forbidden');
      const a = await pool.query('select storage_key from attachments where id=$1', [req.params.id]);
      if (!a.rows[0]) return fail(res, 404, 'not found');
      await mc.removeObject(ATTACH_BUCKET, a.rows[0].storage_key).catch(() => {});
      await pool.query('delete from attachments where id=$1', [req.params.id]);
      res.json({ ok: true, deleted: req.params.id });
    } catch (e) { oops(res, e); }
  });

  // Логин и пароль — только печатные ASCII: латиница, цифры, знаки. Кириллица в них ломает вход
  // (человек набирает пароль в русской раскладке и потом не может войти), поэтому не пускаем и на сервере.
  // Часовой пояс команды: от него считаются «сегодня» и перенос просроченного. Раньше здесь была
  // зашита Москва — у команды в другом поясе сутки переключались бы не в полночь. Значение идёт
  // в запрос ПАРАМЕТРОМ; незнакомый пояс Postgres отвергнет сам, до данных не дойдёт.
  const APP_TZ = String(process.env.APP_TZ || 'Europe/Moscow');
  const AVATAR_COUNT = 20;   // размер встроенного набора аватарок — столько же картинок нарисовано во фронте
  const LATIN_ONLY = /^[\x21-\x7e]+$/;
  const badLatin = (v: unknown) => typeof v === 'string' && v.length > 0 && !LATIN_ONLY.test(v);

  // ---------- USERS (для выбора ответственного) ----------
  // ⚠️ ЧУЖОЙ ЛОГИН ВИДИТ ТОЛЬКО АДМИН. Список нужен всем (выбрать ответственного, соисполнителя,
  // показать автора) — но это имена и аватары, а не учётные данные. Раньше сюда ехал email каждого:
  // любой сотрудник читал логины всей команды, то есть половину пары «логин + пароль» (правка 20.09.2026).
  app.get('/api/users', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const isAdmin = req.user!.role === 'admin';
      const all = req.query.all && isAdmin;   // админ-панель: все, включая заблокированных
      const r = all
        ? await pool.query(`select id, name, email, role, active, avatar_key, avatar_no from users where true ${HIDE_AGENT} order by name`, hideAgentArgs)
        : await pool.query(`select id, name, email, role, avatar_key, avatar_no from users where active = true ${HIDE_AGENT} order by name`, hideAgentArgs);
      const rows = isAdmin ? r.rows : r.rows.map((u: { id: string; email?: string }) => (u.id === req.user!.id ? u : { ...u, email: undefined }));
      res.json({ ok: true, users: rows });
    } catch (e) { oops(res, e); }
  });
  // создание пользователя — только админ
  app.post('/api/users', requireAuth, requireRole('admin'), async (req: AuthedRequest, res) => {
    try {
      const { name, email, password, role } = req.body ?? {};
      if (!name || !email || !password) return fail(res, 400, 'нужны имя, логин и пароль');
      if (badLatin(email) || badLatin(password)) return fail(res, 400, 'логин и пароль — только латиница, цифры и знаки');
      const okRole = ['admin', 'manager', 'member'].includes(role) ? role : 'member';
      // Аватарка по умолчанию — САМАЯ РЕДКАЯ из набора: у нового сотрудника она не совпадёт
      // с теми, что уже стоят у других (правка владельца 20.09.2026, п.3).
      const av = await pool.query('select avatar_no, count(*)::int as c from users where avatar_no is not null group by avatar_no');
      const used = new Array(AVATAR_COUNT).fill(0);
      for (const row of av.rows) { const i = Number(row.avatar_no); if (i >= 0 && i < AVATAR_COUNT) used[i] = row.c; }
      let pick = 0; for (let i = 1; i < AVATAR_COUNT; i++) if (used[i] < used[pick]) pick = i;
      const r = await pool.query(
        `insert into users(name, email, password_hash, role, active, avatar_no) values($1, lower($2), $3, $4, true, $5) returning id, name, email, role, avatar_no`,
        [name, email, hashPassword(String(password)), okRole, pick],
      );
      res.status(201).json({ ok: true, user: r.rows[0] });
    } catch (e) { oops(res, e); }
  });
  // правка пользователя: админ — имя/пароль/доступ любому; каждый — своё имя/пароль
  app.patch('/api/users/:id', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const isAdmin = req.user!.role === 'admin';
      const self = req.user!.id === req.params.id;
      if (!isAdmin && !self) return fail(res, 403, 'forbidden');
      const body = req.body ?? {};
      if (badLatin(body.email) || badLatin(body.password)) return fail(res, 400, 'логин и пароль — только латиница, цифры и знаки');
      const sets: string[] = []; const params: unknown[] = [];
      if (typeof body.name === 'string' && body.name.trim()) { params.push(body.name.trim()); sets.push(`name = $${params.length}`); }
      if (typeof body.password === 'string' && body.password) { params.push(hashPassword(body.password)); sets.push(`password_hash = $${params.length}`); }
      if (isAdmin && typeof body.email === 'string' && body.email.trim()) { params.push(body.email.trim().toLowerCase()); sets.push(`email = $${params.length}`); }   // логин — меняет только админ
      if (isAdmin && typeof body.role === 'string' && ['admin', 'manager', 'member', 'viewer'].includes(body.role)) {
        if (self) return fail(res, 400, 'нельзя сменить собственную роль');   // защита от самоблокировки админа
        params.push(body.role); sets.push(`role = $${params.length}`);
      }
      // встроенная аватарка из набора: ставит себе каждый, админ — любому. Загруженная фотография
      // при этом снимается, иначе она продолжала бы перекрывать выбранную картинку.
      if (typeof body.avatar_no === 'number' && body.avatar_no >= 0 && body.avatar_no < AVATAR_COUNT) {
        params.push(Math.floor(body.avatar_no)); sets.push(`avatar_no = $${params.length}`);
        const old = await pool.query('select avatar_key from users where id = $1', [req.params.id]);
        if (old.rows[0]?.avatar_key) { await mc.removeObject(ATTACH_BUCKET, old.rows[0].avatar_key).catch(() => {}); sets.push('avatar_key = null'); }
      }
      // настройки интерфейса (ширина карточки и т.п.) — только свои, объектом целиком
      if (self && body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)) {
        params.push(JSON.stringify(body.settings)); sets.push(`settings = $${params.length}::jsonb`);
      }
      if (isAdmin && typeof body.active === 'boolean') {
        if (self && body.active === false) return fail(res, 400, 'нельзя заблокировать самого себя');
        params.push(body.active); sets.push(`active = $${params.length}`);
      }
      if (!sets.length) return fail(res, 400, 'no fields to update');
      params.push(req.params.id);
      const r = await pool.query(`update users set ${sets.join(', ')} where id = $${params.length} returning id, name, email, role, active, avatar_key, avatar_no`, params);
      if (!r.rows[0]) return fail(res, 404, 'not found');
      res.json({ ok: true, user: r.rows[0] });
    } catch (e) { oops(res, e); }
  });
  // аватарка: загрузка (админ любому, каждый себе) и отдача
  app.post('/api/users/:id/avatar', requireAuth, upload.single('file'), async (req: AuthedRequest, res) => {
    try {
      if (req.user!.role !== 'admin' && req.user!.id !== req.params.id) return fail(res, 403, 'forbidden');
      const f = (req as unknown as { file?: { buffer: Buffer; size: number; mimetype: string } }).file;
      if (!f) return fail(res, 400, 'file required');
      // ⚠️ SVG — это не картинка, а документ: внутри может быть скрипт, и открытый по прямому адресу
      // он выполнится НА НАШЕМ домене, то есть доберётся до сессии. Принимаем только растровые форматы.
      if (!/^image\/(png|jpe?g|gif|webp|avif|bmp|heic|heif)$/i.test(String(f.mimetype))) {
        return fail(res, 400, 'аватар — картинка: png, jpg, gif, webp, avif');
      }
      if (f.size > 3 * 1024 * 1024) return fail(res, 400, 'аватар до 3 МБ');
      await ensureBucket();
      const old = await pool.query('select avatar_key from users where id = $1', [req.params.id]);
      if (old.rows[0]?.avatar_key) await mc.removeObject(ATTACH_BUCKET, old.rows[0].avatar_key).catch(() => {});
      const key = 'avatar/' + req.params.id + '/' + Date.now();
      await mc.putObject(ATTACH_BUCKET, key, f.buffer, f.size, { 'Content-Type': f.mimetype });
      const r = await pool.query('update users set avatar_key = $1 where id = $2 returning id, avatar_key', [key, req.params.id]);
      if (!r.rows[0]) return fail(res, 404, 'not found');
      res.json({ ok: true, avatar_key: key });
    } catch (e) { oops(res, e); }
  });
  // отдача аватара для <img>: токен принимаем и из заголовка, и из query (?tk=), т.к. img не шлёт Authorization
  app.get('/api/users/:id/avatar', async (req, res) => {
    try {
      const h = req.headers.authorization || '';
      const tk = (h.startsWith('Bearer ') ? h.slice(7) : '') || String((req.query as { tk?: string }).tk || '');
      if (!verifyToken(tk)) return fail(res, 401, 'unauthorized');
      const r = await pool.query('select avatar_key from users where id = $1', [req.params.id]);
      if (!r.rows[0] || !r.rows[0].avatar_key) return fail(res, 404, 'no avatar');
      await ensureBucket();
      const stream = await mc.getObject(ATTACH_BUCKET, r.rows[0].avatar_key);
      // Тип задаём САМИ и не по присланному значению: браузер не должен получить повод
      // показать содержимое как страницу.
      res.setHeader('Content-Type', 'image/*');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=300');
      stream.pipe(res);
    } catch (e) { oops(res, e); }
  });

  // ---------- АВТО-ЧИСТКА старых данных (чтобы БД/сервер не раздувались) ----------
  // Удаляем НАВСЕГДА вместе с вложениями в MinIO. Два срока (решение владельца 20.09.2026):
  //   корзина — TRASH_DAYS   (по умолчанию 30 дней, считается от deleted_at),
  //   архив   — ARCHIVE_DAYS (по умолчанию 365 дней, считается от completed_at).
  // Ниже 7 дней не опускаем — защита от опечатки в .env, которая вычистила бы всё за ночь.
  const TRASH_DAYS = Math.max(7, Number(process.env.TRASH_DAYS) || 30);
  const ARCHIVE_DAYS = Math.max(7, Number(process.env.ARCHIVE_DAYS) || 365);
  async function cleanupOldData(dryRun: boolean): Promise<{ tasks: number; attachments: number; trash_days: number; archive_days: number }> {
    // ВАЖНО: для объекта в корзине срок считается от deleted_at, иначе давно завершённая задача,
    // удалённая сегодня, была бы стёрта ближайшей же чисткой — из корзины её никто не успел бы вернуть.
    const oldT = await pool.query(
      `select id from tasks where (deleted_at is not null and deleted_at < now() - ($1::int * interval '1 day'))
                               or (deleted_at is null and archived = true and completed_at is not null and completed_at < now() - ($2::int * interval '1 day'))`,
      [TRASH_DAYS, ARCHIVE_DAYS]);
    const taskIds = oldT.rows.map((r) => r.id as string);
    const attCnt = taskIds.length
      ? (await pool.query(
          `select count(*)::int as n from attachments where entity_type='task' and entity_id = any($1::uuid[])`,
          [taskIds])).rows[0].n as number
      : 0;
    if (dryRun) return { tasks: taskIds.length, attachments: attCnt, trash_days: TRASH_DAYS, archive_days: ARCHIVE_DAYS };
    // вложения (файлы MinIO + строки) — вручную, т.к. attachments полиморфные (без FK-каскада)
    for (const id of taskIds) await wipeAttachments(pool, 'task', id);
    if (taskIds.length) {
      await pool.query(`delete from tasks where id = any($1::uuid[])`, [taskIds]);   // дочерние (комменты/метки/связи/соисполнители) — каскадом
    }
    return { tasks: taskIds.length, attachments: attCnt, trash_days: TRASH_DAYS, archive_days: ARCHIVE_DAYS };
  }
  // предпросмотр (сколько удалится, ничего не трогая) и ручной запуск — только админ
  app.get('/api/admin/cleanup/preview', requireAuth, requireRole('admin'), async (_req: AuthedRequest, res) => {
    try { res.json({ ok: true, preview: await cleanupOldData(true) }); } catch (e) { oops(res, e); }
  });
  app.post('/api/admin/cleanup', requireAuth, requireRole('admin'), async (_req: AuthedRequest, res) => {
    try { res.json({ ok: true, deleted: await cleanupOldData(false) }); } catch (e) { oops(res, e); }
  });
  // авто-запуск: через минуту после старта и далее раз в сутки
  async function autoCleanup(reason: string): Promise<void> {
    try { const r = await cleanupOldData(false);
      if (r.tasks) console.log(`[cleanup ${reason}] удалено задач=${r.tasks} вложений=${r.attachments} (корзина старше ${r.trash_days} дн., архив старше ${r.archive_days} дн.)`);
    } catch (e) { console.error('[cleanup] ошибка:', (e as Error).message); }
  }
  setTimeout(() => { void autoCleanup('startup'); }, 60_000);
  setInterval(() => { void autoCleanup('daily'); }, 24 * 60 * 60 * 1000);
}
