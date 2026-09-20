-- Встроенные аватарки: номер картинки из набора (0..19). Своя загруженная фотография
-- (avatar_key) всегда важнее — номер используется, когда фотографии нет.
alter table users add column if not exists avatar_no smallint;

-- Раздаём РАЗНЫЕ картинки тем, у кого номера ещё нет: подряд по набору, чтобы у соседей
-- по команде аватарки не совпадали.
with n as (
  select id, ((row_number() over (order by created_at, id)) - 1) % 20 as k
    from users where avatar_no is null
)
update users u set avatar_no = n.k from n where n.id = u.id;
