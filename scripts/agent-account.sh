#!/usr/bin/env bash
# Заводит служебную учётку телеграм-агента и вписывает её пароль в .env.
#
# Зачем скрипт: по README учётку заводят руками через сайт — а помощник ученика в браузер
# зайти не может и пароля администратора не знает. На прогонах этот шаг ломался дважды,
# поэтому теперь он делается одной командой.
#
#   bash scripts/agent-account.sh            # пароль придумает сам
#   bash scripts/agent-account.sh мой_пароль # или возьмёт ваш
#
# Повторный запуск не ломает ничего: учётка одна и та же, ей просто меняется пароль.
# Смена пароля обрывает ВСЕ прежние входы агента (поколение входов +1, миграция 0006, проверка 16.11):
# иначе токен, полученный по утёкшему паролю, жил бы ещё 90 дней и с заголовком X-Telegram-Id работал бы
# за любого привязанного человека. Бот на 401 сам входит заново по AGENT_PASSWORD; запущенный бот
# скрипт пересоздаёт, чтобы он взял новый пароль из .env (docker compose restart .env не перечитывает).
# Нужны: docker compose (система должна быть запущена).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "нет файла .env — сначала настройте его по README" >&2; exit 1; }

EMAIL=$(grep -E '^AGENT_EMAIL=' .env | cut -d= -f2 | awk '{print $1}'); EMAIL="${EMAIL:-agent@taska.local}"
PGU=$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2 | awk '{print $1}')
PGD=$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2 | awk '{print $1}')
PASS="${1:-$(openssl rand -hex 12)}"

HASH=$(docker compose exec -T api sh -lc "cd /app && npx --yes tsx -e \"import {hashPassword} from './src/auth.ts'; console.log(hashPassword('$PASS'))\"" | tail -1)
[ -n "$HASH" ] || { echo "не смог посчитать хеш пароля — контейнер api запущен?" >&2; exit 1; }

# Столбца поколения входов нет — api после обновления не перезапускали (миграция 0006 ещё не прошла).
# Тогда не меняем ничего: иначе прежние входы агента остались бы жить, а в .env лёг бы пароль,
# которого нет в базе.
HAS_TV=$(docker compose exec -T postgres psql -U "$PGU" -d "$PGD" -tAq -c \
  "select count(*) from information_schema.columns where table_schema = current_schema() and table_name = 'users' and column_name = 'token_version'" | tr -d '[:space:]\r')
[ "$HAS_TV" = 1 ] || { echo "Таска ещё работает на прежнем коде (после обновления api не перезапускали). Сначала: docker compose restart api — потом повторите эту команду." >&2; exit 1; }

EXISTED=$(docker compose exec -T postgres psql -U "$PGU" -d "$PGD" -tAq -c "select count(*) from users where email = '$EMAIL'" | tr -d '[:space:]\r')

# ON_ERROR_STOP: ошибка SQL — ненулевой код, и пароль в .env не попадёт (без него psql молча выходит с 0)
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$PGU" -d "$PGD" -q <<SQL
insert into users(name, email, password_hash, role, active)
values('Телеграм-агент', '$EMAIL', '$HASH', 'member', true)
on conflict (email) do update set password_hash = excluded.password_hash, active = true,
  token_version = users.token_version + 1;
SQL

# пароль нужен боту — кладём его в .env рядом с остальными настройками
if grep -qE '^AGENT_PASSWORD=' .env; then
  tmp=$(mktemp); sed "s|^AGENT_PASSWORD=.*|AGENT_PASSWORD=$PASS|" .env > "$tmp" && mv "$tmp" .env && chmod 600 .env
else
  printf '\nAGENT_PASSWORD=%s\n' "$PASS" >> .env
fi

# Запущенный бот держит прежний пароль в памяти: его прежний вход уже закрыт, а перевойти он сможет
# только с новым паролем. Пересоздаём ТОЛЬКО бота (--no-deps: api и база не трогаются) — он прочитает .env заново.
BOT_RESTARTED=0
# (running или restarting: перезапуски docker тоже не перечитывают .env; остановленного руками бота не поднимаем)
if [ -n "$(docker compose --profile bot ps -q --status running --status restarting bot 2>/dev/null)" ]; then
  if docker compose --profile bot up -d --no-deps --force-recreate bot >/dev/null 2>&1; then BOT_RESTARTED=1
  else echo "⚠️ Бот запущен, но перезапустить его не вышло. Сделайте: docker compose --profile bot up -d --force-recreate bot — иначе он не войдёт в Таску." >&2; fi
fi

echo "учётка агента готова: $EMAIL"
echo "пароль: $PASS"
echo "он же вписан в .env (AGENT_PASSWORD). В списке «Команда» эта учётка не показывается — она служебная."
[ "$EXISTED" = 1 ] && echo "прежние входы агента закрыты — с прежним паролем и прежним токеном агент больше не работает."
[ $BOT_RESTARTED = 1 ] && echo "бот перезапущен с новым паролем."
exit 0
