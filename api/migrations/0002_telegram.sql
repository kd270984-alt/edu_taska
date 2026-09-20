-- 0002_telegram.sql — связка «человек в Телеграме ↔ пользователь Таски».
-- Агент ходит в API под своей учёткой, но действует ОТ ИМЕНИ человека: сервер
-- находит связку по telegram_id и дальше проверяет права как у этого человека.

-- Постоянная связка (её делает сам человек, подтвердив код из своего профиля)
create table telegram_links (
  telegram_id text primary key,                                   -- id пользователя в Телеграме
  user_id     uuid not null references users(id) on delete cascade,
  username    text,                                               -- @имя, только чтобы человек видел, кто привязан
  created_at  timestamptz not null default now()
);
create index telegram_links_user_idx on telegram_links(user_id);

-- Одноразовый код привязки: человек берёт его в профиле и отправляет боту
create table telegram_codes (
  code       text primary key,
  user_id    uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
