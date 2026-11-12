-- 0005_crm_demo.sql — CRM «для примера»: клиенты, сделки по этапам, короткий прайс.
-- Решение владельца 11.11.2026: простой раздел внутри Таски, а не отдельный сайт.
--
-- ⚠️ Миграция ТОЛЬКО ДОБАВЛЯЕТ таблицы с приставкой crm_ — таблицы Таски не меняются.
--    Раздел в меню появляется, лишь когда в .env стоит CRM_DEMO=1. Без этой строки таблицы
--    просто лежат пустыми, и у ученика, который CRM не ставил, ничего не меняется.
-- Этапы сделки хранятся коротким словом (new, need, …), а их названия и порядок живут в api/src/crm.ts:
-- переименовать этап можно правкой одной строки, без новой миграции.

-- Клиенты: компания и один контакт — для примера больше не нужно
create table if not exists crm_companies (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  contact_name text,                       -- контактное лицо
  phone        text,
  email        text,
  city         text,
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Сделки: компания, этап воронки, сумма, ответственный из людей Таски
create table if not exists crm_deals (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  company_id uuid not null references crm_companies(id) on delete cascade,   -- удалили клиента — уходят и его сделки
  stage      text not null default 'new',
  amount     numeric(14,2) not null default 0,
  owner_id   uuid references users(id) on delete set null,                   -- сотрудника удалили — сделка остаётся без ответственного
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists crm_deals_company_idx on crm_deals(company_id);
create index if not exists crm_deals_stage_idx   on crm_deals(stage);

-- Товары: короткий прайс
create table if not exists crm_products (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  category   text not null default 'Прочее',
  unit       text not null default 'шт',
  price      numeric(12,2) not null default 0,
  created_at timestamptz not null default now()
);
