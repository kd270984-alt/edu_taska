import type { Pool, PoolClient } from 'pg';

// ДЕМО ДЛЯ CRM: вымышленный торговый дом «Плёнка и Короб» — оптом продаёт упаковку и расходники
// для складов (решение владельца 11.11.2026: CRM простая, «просто демо»).
// Правила вымышленности: почты только в зоне .example, телефоны +7 900 000-…, без ИНН и реквизитов —
// выдуманный ИНН может совпасть с настоящим.
// Трогает ТОЛЬКО таблицы crm_*: люди, задачи и метки Таски остаются как были.

type Company = { key: string; name: string; contact: string; phone: string; email: string; city: string; note: string };
type Deal = { title: string; company: string; stage: string; amount: number; who: number; days: number; note?: string };
type Product = { category: string; name: string; unit: string; price: number };

const COMPANIES: Company[] = [
  { key: 'kedr', name: 'Кедр-Мебель', contact: 'Олег Смирнов, закупщик', phone: '+7 900 000-01-01', email: 'zakupki@kedr-mebel.example', city: 'Киров', note: 'Мебельная фабрика. Берут стрейч и уголки каждый месяц.' },
  { key: 'vostok', name: 'Склад-Сервис Восток', contact: 'Ирина Ковалёва, начальник склада', phone: '+7 900 000-01-02', email: 'sklad@sklad-vostok.example', city: 'Подольск', note: 'Ответственное хранение, 12 000 паллетомест.' },
  { key: 'len', name: 'Лён и Хлопок онлайн', contact: 'Дарья Морозова, логистика', phone: '+7 900 000-01-03', email: 'logistika@len-hlopok.example', city: 'Иваново', note: 'Интернет-магазин домашнего текстиля. Сезон — осень и весна.' },
  { key: 'luga', name: 'Молочная ферма Луговая', contact: 'Сергей Беляев, главный инженер', phone: '+7 900 000-01-04', email: 'snab@lugovaya-ferma.example', city: 'Вологда', note: 'Молочный комбинат, две линии паллетирования.' },
  { key: 'polka', name: 'Торговая сеть «Полка»', contact: 'Наталья Гусева, категорийный менеджер', phone: '+7 900 000-01-05', email: 'zakupki@set-polka.example', city: 'Тверь', note: '40 магазинов и свой распределительный центр.' },
  { key: 'yug', name: 'Фулфилмент Юг-Пак', contact: 'Артём Ершов, директор', phone: '+7 900 000-01-06', email: 'info@yug-pak.example', city: 'Краснодар', note: 'Собирает заказы для маркетплейсов.' },
  { key: 'kolos', name: 'Пекарня «Колосок»', contact: 'Елена Фёдорова, снабжение', phone: '+7 900 000-01-07', email: 'snab@kolosok-pek.example', city: 'Тула', note: 'Хлеб и выпечка, развоз по магазинам области.' },
  { key: 'agro', name: 'Агродистрибуция Черноземье', contact: 'Виктор Панов, коммерческий директор', phone: '+7 900 000-01-08', email: 'sales@agro-chernozem.example', city: 'Воронеж', note: 'Дистрибьютор, покупает партиями раз в квартал.' },
  { key: 'plast', name: 'Прогресс-Пласт', contact: 'Михаил Орлов, отдел снабжения', phone: '+7 900 000-01-09', email: 'omts@progress-plast.example', city: 'Самара', note: 'Завод пластиковых изделий.' },
  { key: 'farm', name: 'Фарм-Логистик Волга', contact: 'Ольга Никитина, заведующая складом', phone: '+7 900 000-01-10', email: 'sklad@farm-volga.example', city: 'Казань', note: 'Аптечный склад, нужна маркировка каждой коробки.' },
  { key: 'lapa', name: 'Зоомагазин «Лапа и Хвост»', contact: 'Кирилл Зайцев, владелец', phone: '+7 900 000-01-11', email: 'hello@lapa-hvost.example', city: 'Нижний Новгород', note: 'Интернет-магазин зоотоваров.' },
  { key: 'oka', name: 'СтройДвор Ока', contact: 'Андрей Соловьёв, логист', phone: '+7 900 000-01-12', email: 'logist@stroydvor-oka.example', city: 'Рязань', note: 'Стройматериалы оптом, отгрузки на поддонах.' },
];

// who — кому отдать сделку: 0 — админ, дальше остальные люди Таски в порядке заведения (по кругу).
// В демо-команде Таски это Анна Соколова, Игорь Волков и Мария Лебедева. days — сколько дней назад заведена.
const DEALS: Deal[] = [
  { title: 'Заявка с сайта: короба для фулфилмента', company: 'yug', stage: 'new', amount: 0, who: 2, days: 1, note: 'Сумму назовём после звонка.' },
  { title: 'Скотч с логотипом, пробная партия', company: 'lapa', stage: 'new', amount: 43500, who: 3, days: 2 },
  { title: 'Защитная упаковка для мебели', company: 'kedr', stage: 'need', amount: 300000, who: 2, days: 6, note: 'Сумма примерная — ждём объёмы на квартал.' },
  { title: 'Термоэтикетки для аптечного склада', company: 'farm', stage: 'need', amount: 63000, who: 1, days: 5 },
  { title: 'Стреппинг для отгрузок', company: 'oka', stage: 'need', amount: 95000, who: 0, days: 8 },
  { title: 'Поддоны 1 200 шт + стрейч', company: 'vostok', stage: 'offer', amount: 980000, who: 1, days: 10 },
  { title: 'Гофрокороба для хлеба и выпечки', company: 'kolos', stage: 'offer', amount: 126000, who: 3, days: 9 },
  { title: 'Риббоны и этикетки на квартал', company: 'agro', stage: 'offer', amount: 88400, who: 0, days: 12 },
  { title: 'Годовой контракт на машинную стрейч-плёнку', company: 'luga', stage: 'talks', amount: 1380000, who: 1, days: 20, note: 'Просят отсрочку 30 дней.' },
  { title: 'Пластиковые поддоны для цеха', company: 'plast', stage: 'talks', amount: 468000, who: 1, days: 15 },
  { title: 'Стрейч и короба для распределительного центра', company: 'polka', stage: 'talks', amount: 352000, who: 0, days: 14 },
  { title: 'Этикетки и риббоны для РЦ', company: 'polka', stage: 'invoice', amount: 146000, who: 0, days: 18 },
  { title: 'Воздушно-пузырьковая плёнка, 120 рулонов', company: 'kedr', stage: 'invoice', amount: 198000, who: 2, days: 11 },
  { title: 'Короба трёх размеров на сезон', company: 'len', stage: 'won', amount: 214000, who: 3, days: 25 },
  { title: 'Поддоны б/у, 500 шт', company: 'agro', stage: 'won', amount: 195000, who: 0, days: 32 },
  { title: 'Стрейч-плёнка ручная, 300 рулонов', company: 'vostok', stage: 'won', amount: 117000, who: 1, days: 40 },
  { title: 'Короба для замороженной продукции', company: 'kolos', stage: 'lost', amount: 74000, who: 3, days: 28, note: 'Отказ: выбрали поставщика с доставкой в тот же день.' },
  { title: 'Натяжители стреппинга, 10 шт', company: 'plast', stage: 'lost', amount: 69000, who: 1, days: 35, note: 'Отказ: закупку перенесли на следующий год.' },
];

// Цены — за единицу, с НДС, в рублях
const PRODUCTS: Product[] = [
  { category: 'Стрейч-плёнка', name: 'Стрейч-плёнка ручная 500 мм × 20 мкм, 1,5 кг', unit: 'рулон', price: 390 },
  { category: 'Стрейч-плёнка', name: 'Стрейч-плёнка машинная 500 мм × 23 мкм, 16 кг', unit: 'рулон', price: 3450 },
  { category: 'Стрейч-плёнка', name: 'Мини-стрейч 100 мм × 20 мкм', unit: 'рулон', price: 95 },
  { category: 'Гофрокороба', name: 'Гофрокороб 300×200×150, Т-22', unit: 'шт', price: 34 },
  { category: 'Гофрокороба', name: 'Гофрокороб 400×300×300, Т-23', unit: 'шт', price: 62 },
  { category: 'Гофрокороба', name: 'Гофрокороб 600×400×400, Т-24', unit: 'шт', price: 118 },
  { category: 'Скотч и стреппинг', name: 'Скотч прозрачный 48 мм × 66 м', unit: 'шт', price: 79 },
  { category: 'Скотч и стреппинг', name: 'Скотч с логотипом 48 мм × 66 м (от 300 шт)', unit: 'шт', price: 145 },
  { category: 'Скотч и стреппинг', name: 'Лента ПП для стреппинга 12 мм × 2000 м', unit: 'бухта', price: 1900 },
  { category: 'Скотч и стреппинг', name: 'Пряжки для стреппинга 12 мм, 1000 шт', unit: 'упак.', price: 850 },
  { category: 'Поддоны', name: 'Поддон деревянный 1200×800, новый', unit: 'шт', price: 690 },
  { category: 'Поддоны', name: 'Поддон деревянный 1200×800, б/у 1 сорт', unit: 'шт', price: 390 },
  { category: 'Поддоны', name: 'Поддон пластиковый 1200×800', unit: 'шт', price: 3900 },
  { category: 'Защитная упаковка', name: 'Воздушно-пузырьковая плёнка 1,2 × 100 м', unit: 'рулон', price: 1650 },
  { category: 'Защитная упаковка', name: 'Уголок защитный 50×50×1000 мм', unit: 'шт', price: 32 },
  { category: 'Маркировка', name: 'Термоэтикетки 58×40, 1000 шт', unit: 'рулон', price: 210 },
  { category: 'Маркировка', name: 'Риббон воск 110 мм × 300 м', unit: 'шт', price: 520 },
  { category: 'Скотч и стреппинг', name: 'Натяжитель стреппинга ручной', unit: 'шт', price: 6900 },
];

export type CrmCounts = { companies: number; deals: number; products: number };

export async function crmCounts(db: Pool | PoolClient): Promise<CrmCounts> {
  const r = await db.query(`select (select count(*) from crm_companies)::int as companies,
                                   (select count(*) from crm_deals)::int as deals,
                                   (select count(*) from crm_products)::int as products`);
  return r.rows[0];
}

// Стереть данные CRM (и только их)
export async function clearCrm(pool: Pool): Promise<CrmCounts> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const before = await crmCounts(client);
    await client.query('delete from crm_deals; delete from crm_companies; delete from crm_products;');
    await client.query('commit');
    return before;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

// Загрузить демо. Без reset — только в ПУСТУЮ CRM: свои данные ученика не затираем никогда.
export async function loadCrmDemo(pool: Pool, opts: { reset?: boolean } = {}): Promise<CrmCounts & { loaded: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    // две загрузки разом (кнопка и команда) не должны задвоить демо
    await client.query(`select pg_advisory_xact_lock(hashtext('crm_demo'))`);
    const now = await crmCounts(client);
    if (!opts.reset && (now.companies || now.deals || now.products)) {
      await client.query('rollback');
      return { loaded: false, ...now };
    }
    await client.query('delete from crm_deals; delete from crm_companies; delete from crm_products;');

    // Продавцы — люди Таски. Служебную учётку телеграм-агента и наблюдателей не берём: сделки им вести незачем.
    const agent = String(process.env.AGENT_EMAIL || '').trim().toLowerCase();
    const people = (await client.query(
      `select id from users where active = true and role <> 'viewer' and lower(email) <> $1
        order by (role = 'admin') desc, created_at, name`, [agent],
    )).rows.map((r) => r.id as string);
    const ownerOf = (who: number) => (people.length ? people[who % people.length] : null);

    const ids: Record<string, string> = {};
    for (const c of COMPANIES) {
      const r = await client.query(
        `insert into crm_companies(name, contact_name, phone, email, city, note, created_at, updated_at)
         values($1,$2,$3,$4,$5,$6, now() - interval '45 days', now() - interval '45 days') returning id`,
        [c.name, c.contact, c.phone, c.email, c.city, c.note],
      );
      ids[c.key] = r.rows[0].id;
    }
    for (const d of DEALS) {
      await client.query(
        `insert into crm_deals(title, company_id, stage, amount, owner_id, note, created_at, updated_at)
         values($1,$2,$3,$4,$5,$6, now() - make_interval(days => $7), now() - make_interval(days => $7))`,
        [d.title, ids[d.company], d.stage, d.amount, ownerOf(d.who), d.note ?? null, d.days],
      );
    }
    for (const p of PRODUCTS) {
      await client.query('insert into crm_products(category, name, unit, price) values($1,$2,$3,$4)',
        [p.category, p.name, p.unit, p.price]);
    }
    await client.query('commit');
    return { loaded: true, companies: COMPANIES.length, deals: DEALS.length, products: PRODUCTS.length };
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
