-- 0003_user_settings.sql — настройки интерфейса на человека, а не на браузер.
-- Ширина карточки задачи (и что появится дальше) следует за учётной записью: сел за другой
-- компьютер — вид тот же. Раньше это жило в localStorage и на новом устройстве сбрасывалось.
alter table users add column if not exists settings jsonb not null default '{}'::jsonb;
