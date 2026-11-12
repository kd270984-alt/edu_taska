import type { Express, NextFunction, Response } from 'express';
import type { Pool } from 'pg';
import { requireAuth, requireRole, type AuthedRequest } from './auth.ts';
import { crmCounts, loadCrmDemo } from './crm-demo.ts';

// CRM «ДЛЯ ПРИМЕРА» (решение владельца 11.11.2026): простой раздел внутри Таски —
// клиенты, сделки по этапам, короткий прайс. Ставится на занятии одним промптом.
//
// ⚠️ ВЫКЛЮЧЕНА ПО УМОЛЧАНИЮ. Включает строка CRM_DEMO=1 в .env (или bash scripts/crm-demo.sh on).
//    Выключена — все адреса /api/crm/* отвечают 404, а пункта в меню нет: у ученика, который
//    CRM не ставил, Таска выглядит и работает как раньше.
// Видимость — как решил владелец: все видят всех клиентов и все сделки, в воронке есть фильтр «Мои».
// Менять клиентов и сделки может любой сотрудник, прайс — только администратор.
export const CRM_ON = /^(1|on|yes|true)$/i.test(String(process.env.CRM_DEMO || '').trim());

// Этапы воронки. В базе — короткое слово, здесь — название и порядок: переименовать этап = поправить строку.
export const CRM_STAGES = [
  { key: 'new', name: 'Новая' },
  { key: 'need', name: 'Выявление потребности' },
  { key: 'offer', name: 'КП отправлено' },
  { key: 'talks', name: 'Переговоры' },
  { key: 'invoice', name: 'Счёт выставлен' },
  { key: 'won', name: 'Оплачено' },
  { key: 'lost', name: 'Проиграна' },
];
const STAGE_KEYS = new Set(CRM_STAGES.map((s) => s.key));

const fail = (res: Response, code: number, error: string) => res.status(code).json({ ok: false, error });
const oops = (res: Response, e: unknown) => {
  const code = (e as { code?: string }).code;
  if (code === '22P02') return fail(res, 400, 'некорректный формат данных');      // битый uuid
  if (code === '23503') return fail(res, 400, 'нет такого клиента или сотрудника');   // ссылка на несуществующее
  console.error('crm error:', (e as Error).message);
  return fail(res, 500, 'внутренняя ошибка');
};

// Текстовое поле: обрезаем края, пустое → null. Слишком длинное — понятный отказ, а не молчаливая обрезка.
class Bad extends Error {}
function text(v: unknown, label: string, max = 300): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (s.length > max) throw new Bad(`${label}: не длиннее ${max} знаков`);
  return s || null;
}
// Деньги: принимаем и число, и строку «1 380 000,50» — так их вводят люди. Отрицательных и мусора не берём.
function money(v: unknown, label: string): number {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[\s ₽]/g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n >= 1e12) throw new Bad(`${label}: нужно число не меньше нуля`);
  return Math.round(n * 100) / 100;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidOrNull(v: unknown, label: string): string | null {
  if (v == null || v === '') return null;
  if (!UUID_RE.test(String(v))) throw new Bad(`${label}: некорректная ссылка`);
  return String(v);
}
// Bad → 400 со словами для человека, остальное — как обычно
function handle(res: Response, e: unknown) {
  if (e instanceof Bad) return fail(res, 400, e.message);
  return oops(res, e);
}

// Частичное обновление: в SQL идут только колонки из белого списка, значения — параметрами
function patchSql(table: string, id: string, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  if (table !== 'crm_products') sets.push('updated_at = now()');
  return { sql: `update ${table} set ${sets.join(', ')} where id = $1 returning *`, params: [id, ...keys.map((k) => fields[k])] };
}

const WRITERS = requireRole('admin', 'manager', 'member');   // наблюдатель (viewer) только смотрит
const ADMIN = requireRole('admin');

const DEAL_SELECT = `select d.*, c.name as company_name
                       from crm_deals d join crm_companies c on c.id = d.company_id`;

export function registerCrm(app: Express, pool: Pool): void {
  // Раздел выключен — CRM для внешнего мира не существует (кроме вопроса «включена ли»)
  app.use('/api/crm', (req, res: Response, next: NextFunction) => {
    if (CRM_ON || req.path === '/status') return next();
    fail(res, 404, 'CRM выключена: включите её командой bash scripts/crm-demo.sh on');
  });

  // Фронт спрашивает при запуске: показывать ли пункт меню. Пустая CRM — повод предложить демо.
  app.get('/api/crm/status', requireAuth, async (_req: AuthedRequest, res) => {
    try {
      if (!CRM_ON) return res.json({ ok: true, enabled: false });
      const c = await crmCounts(pool);
      res.json({ ok: true, enabled: true, stages: CRM_STAGES, empty: !c.companies && !c.deals && !c.products, counts: c });
    } catch (e) { oops(res, e); }
  });

  // ---------- КЛИЕНТЫ ----------
  app.get('/api/crm/companies', requireAuth, async (_req: AuthedRequest, res) => {
    try {
      const r = await pool.query(
        `select c.*,
                count(d.id) filter (where d.stage not in ('won','lost'))::int as open_deals,
                coalesce(sum(d.amount) filter (where d.stage not in ('won','lost')), 0)::float8 as open_sum,
                coalesce(sum(d.amount) filter (where d.stage = 'won'), 0)::float8 as won_sum
           from crm_companies c left join crm_deals d on d.company_id = c.id
          group by c.id order by lower(c.name)`);
      res.json({ ok: true, companies: r.rows });
    } catch (e) { oops(res, e); }
  });

  const companyFields = (b: Record<string, unknown>, partial: boolean) => {
    const f: Record<string, unknown> = {};
    const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
    if (!partial || has('name')) {
      const name = text(b.name, 'Название', 200);
      if (!name) throw new Bad('Укажите название клиента');
      f.name = name;
    }
    if (has('contact_name')) f.contact_name = text(b.contact_name, 'Контакт', 200);
    if (has('phone')) f.phone = text(b.phone, 'Телефон', 60);
    if (has('email')) f.email = text(b.email, 'Почта', 200);
    if (has('city')) f.city = text(b.city, 'Город', 100);
    if (has('note')) f.note = text(b.note, 'Заметка', 2000);
    return f;
  };

  app.post('/api/crm/companies', requireAuth, WRITERS, async (req: AuthedRequest, res) => {
    try {
      const f = companyFields(req.body ?? {}, false);
      const keys = Object.keys(f);
      const r = await pool.query(
        `insert into crm_companies(${keys.join(', ')}) values(${keys.map((_, i) => '$' + (i + 1)).join(', ')}) returning *`,
        keys.map((k) => f[k]));
      res.status(201).json({ ok: true, company: r.rows[0] });
    } catch (e) { handle(res, e); }
  });

  app.patch('/api/crm/companies/:id', requireAuth, WRITERS, async (req: AuthedRequest, res) => {
    try {
      const f = companyFields(req.body ?? {}, true);
      if (!Object.keys(f).length) return fail(res, 400, 'нечего менять');
      const q = patchSql('crm_companies', req.params.id, f);
      const r = await pool.query(q.sql, q.params);
      if (!r.rows[0]) return fail(res, 404, 'клиент не найден');
      res.json({ ok: true, company: r.rows[0] });
    } catch (e) { handle(res, e); }
  });

  // Удаление клиента уносит и его сделки — фронт предупреждает об этом заранее
  app.delete('/api/crm/companies/:id', requireAuth, WRITERS, async (req: AuthedRequest, res) => {
    try {
      const n = await pool.query('select count(*)::int as n from crm_deals where company_id = $1', [req.params.id]);
      const r = await pool.query('delete from crm_companies where id = $1 returning id', [req.params.id]);
      if (!r.rows[0]) return fail(res, 404, 'клиент не найден');
      res.json({ ok: true, deleted_deals: n.rows[0].n });
    } catch (e) { oops(res, e); }
  });

  // ---------- СДЕЛКИ ----------
  app.get('/api/crm/deals', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const cid = req.query.company_id ? String(req.query.company_id) : '';
      const r = cid
        ? await pool.query(`${DEAL_SELECT} where d.company_id = $1 order by d.updated_at desc`, [cid])
        : await pool.query(`${DEAL_SELECT} order by d.updated_at desc`);
      // numeric приходит из pg строкой — отдаём числом, чтобы фронт не складывал строки
      res.json({ ok: true, deals: r.rows.map((d) => ({ ...d, amount: Number(d.amount) })) });
    } catch (e) { oops(res, e); }
  });

  const dealFields = (b: Record<string, unknown>, partial: boolean) => {
    const f: Record<string, unknown> = {};
    const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
    if (!partial || has('title')) {
      const title = text(b.title, 'Название', 200);
      if (!title) throw new Bad('Укажите название сделки');
      f.title = title;
    }
    if (!partial || has('company_id')) {
      const cid = uuidOrNull(b.company_id, 'Клиент');
      if (!cid) throw new Bad('Выберите клиента');
      f.company_id = cid;
    }
    if (has('stage') || !partial) {
      const st = b.stage == null || b.stage === '' ? 'new' : String(b.stage);
      if (!STAGE_KEYS.has(st)) throw new Bad('Нет такого этапа');
      f.stage = st;
    }
    if (has('amount')) f.amount = money(b.amount, 'Сумма');
    if (has('owner_id')) f.owner_id = uuidOrNull(b.owner_id, 'Ответственный');
    if (has('note')) f.note = text(b.note, 'Заметка', 2000);
    return f;
  };

  app.post('/api/crm/deals', requireAuth, WRITERS, async (req: AuthedRequest, res) => {
    try {
      const b = req.body ?? {};
      const f = dealFields(b, false);
      // ответственный не назван — сделка достаётся тому, кто её завёл (как задача в Таске)
      if (!Object.prototype.hasOwnProperty.call(b, 'owner_id')) f.owner_id = req.user!.id;
      const keys = Object.keys(f);
      const ins = await pool.query(
        `insert into crm_deals(${keys.join(', ')}) values(${keys.map((_, i) => '$' + (i + 1)).join(', ')}) returning id`,
        keys.map((k) => f[k]));
      const r = await pool.query(`${DEAL_SELECT} where d.id = $1`, [ins.rows[0].id]);
      res.status(201).json({ ok: true, deal: { ...r.rows[0], amount: Number(r.rows[0].amount) } });
    } catch (e) { handle(res, e); }
  });

  // Сюда же приходит перетаскивание карточки между колонками воронки: {stage: '…'}
  app.patch('/api/crm/deals/:id', requireAuth, WRITERS, async (req: AuthedRequest, res) => {
    try {
      const f = dealFields(req.body ?? {}, true);
      if (!Object.keys(f).length) return fail(res, 400, 'нечего менять');
      const q = patchSql('crm_deals', req.params.id, f);
      const u = await pool.query(q.sql, q.params);
      if (!u.rows[0]) return fail(res, 404, 'сделка не найдена');
      const r = await pool.query(`${DEAL_SELECT} where d.id = $1`, [req.params.id]);
      res.json({ ok: true, deal: { ...r.rows[0], amount: Number(r.rows[0].amount) } });
    } catch (e) { handle(res, e); }
  });

  app.delete('/api/crm/deals/:id', requireAuth, WRITERS, async (req: AuthedRequest, res) => {
    try {
      const r = await pool.query('delete from crm_deals where id = $1 returning id', [req.params.id]);
      if (!r.rows[0]) return fail(res, 404, 'сделка не найдена');
      res.json({ ok: true });
    } catch (e) { oops(res, e); }
  });

  // ---------- ТОВАРЫ (прайс) ----------
  app.get('/api/crm/products', requireAuth, async (_req: AuthedRequest, res) => {
    try {
      const r = await pool.query('select * from crm_products order by lower(category), lower(name)');
      res.json({ ok: true, products: r.rows.map((p) => ({ ...p, price: Number(p.price) })) });
    } catch (e) { oops(res, e); }
  });

  const productFields = (b: Record<string, unknown>, partial: boolean) => {
    const f: Record<string, unknown> = {};
    const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
    if (!partial || has('name')) {
      const name = text(b.name, 'Название', 200);
      if (!name) throw new Bad('Укажите название товара');
      f.name = name;
    }
    if (!partial || has('category')) f.category = text(b.category, 'Категория', 100) || 'Прочее';
    if (!partial || has('unit')) f.unit = text(b.unit, 'Единица', 30) || 'шт';
    if (!partial || has('price')) f.price = money(b.price, 'Цена');
    return f;
  };

  app.post('/api/crm/products', requireAuth, ADMIN, async (req: AuthedRequest, res) => {
    try {
      const f = productFields(req.body ?? {}, false);
      const keys = Object.keys(f);
      const r = await pool.query(
        `insert into crm_products(${keys.join(', ')}) values(${keys.map((_, i) => '$' + (i + 1)).join(', ')}) returning *`,
        keys.map((k) => f[k]));
      res.status(201).json({ ok: true, product: { ...r.rows[0], price: Number(r.rows[0].price) } });
    } catch (e) { handle(res, e); }
  });

  app.patch('/api/crm/products/:id', requireAuth, ADMIN, async (req: AuthedRequest, res) => {
    try {
      const f = productFields(req.body ?? {}, true);
      if (!Object.keys(f).length) return fail(res, 400, 'нечего менять');
      const q = patchSql('crm_products', req.params.id, f);
      const r = await pool.query(q.sql, q.params);
      if (!r.rows[0]) return fail(res, 404, 'товар не найден');
      res.json({ ok: true, product: { ...r.rows[0], price: Number(r.rows[0].price) } });
    } catch (e) { handle(res, e); }
  });

  app.delete('/api/crm/products/:id', requireAuth, ADMIN, async (req: AuthedRequest, res) => {
    try {
      const r = await pool.query('delete from crm_products where id = $1 returning id', [req.params.id]);
      if (!r.rows[0]) return fail(res, 404, 'товар не найден');
      res.json({ ok: true });
    } catch (e) { oops(res, e); }
  });

  // ---------- ДЕМО ----------
  // Кнопка «Загрузить пример» в пустой CRM. Только администратор и только в пустую CRM:
  // стереть и загрузить заново можно лишь командой bash scripts/crm-demo.sh reset — случайным щелчком
  // данные ученика не потерять.
  app.post('/api/crm/demo', requireAuth, ADMIN, async (_req: AuthedRequest, res) => {
    try {
      const r = await loadCrmDemo(pool, { reset: false });
      if (!r.loaded) return fail(res, 409, 'В CRM уже есть данные — пример загружается только в пустую CRM');
      res.status(201).json({ ok: true, ...r });
    } catch (e) { oops(res, e); }
  });
}
