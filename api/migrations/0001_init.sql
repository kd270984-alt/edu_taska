-- 0001_init.sql — схема учебной Таски (календарь + задачи).
-- Единственный вид — календарь: задача всегда стоит в конкретном дне.
-- Дата задачи ОБЯЗАТЕЛЬНА: задача живёт в дне календаря.

create type user_role       as enum ('admin','manager','member','viewer');
create type recurrence_type as enum ('none','daily','weekly','monthly','yearly');

-- Люди
create table users (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  email         text not null unique,
  password_hash text,
  role          user_role not null default 'member',
  avatar_key    text,                      -- файл аватара в объектном хранилище
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- Метки задач (цветные, до двух на задачу)
create table tags (
  id        uuid primary key default gen_random_uuid(),
  name      text not null,
  color_key text
);

-- Задачи
create table tasks (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null,
  due_date                date not null,             -- обязательна: задача стоит в дне календаря
  due_time                time,                      -- время — по желанию
  assignee_id             uuid references users(id) on delete set null,
  author_id               uuid references users(id) on delete set null,
  parent_id               uuid references tasks(id) on delete cascade,   -- подзадача
  description             text,
  archived                boolean not null default false,                -- завершена → в архив
  completed_at            timestamptz,
  deleted_at              timestamptz,                                   -- корзина (мягкое удаление)
  deleted_by              uuid references users(id) on delete set null,
  recurrence_type         recurrence_type not null default 'none',
  recurrence_days         int[],
  recurrence_day_of_month int,
  recurrence_date         date,
  created_at              timestamptz not null default now()
);
create index tasks_due_idx      on tasks(due_date);
create index tasks_assignee_idx on tasks(assignee_id);
create index tasks_parent_idx   on tasks(parent_id);

-- Соисполнители задачи
create table task_co_assignees (
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  primary key (task_id, user_id)
);

-- Метки на задаче (до двух, порядок важен)
create table task_tags (
  task_id uuid not null references tasks(id) on delete cascade,
  tag_id  uuid not null references tags(id)  on delete cascade,
  pos     int  not null default 0,
  primary key (task_id, tag_id)
);

-- Комментарии задачи
create table comments (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references tasks(id) on delete cascade,
  author_id  uuid references users(id) on delete set null,
  text       text not null,
  created_at timestamptz not null default now()
);
create index comments_task_idx on comments(task_id);

-- Вложения (файлы лежат в объектном хранилище, здесь — карточка файла)
create table attachments (
  id           uuid primary key default gen_random_uuid(),
  entity_type  text not null,            -- сейчас только 'task'
  entity_id    uuid not null,
  filename     text not null,
  storage_key  text not null,
  content_type text,
  size_bytes   bigint,
  created_at   timestamptz not null default now()
);
create index attachments_entity_idx on attachments(entity_type, entity_id);
