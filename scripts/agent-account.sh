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

docker compose exec -T postgres psql -U "$PGU" -d "$PGD" -q <<SQL
insert into users(name, email, password_hash, role, active)
values('Телеграм-агент', '$EMAIL', '$HASH', 'member', true)
on conflict (email) do update set password_hash = excluded.password_hash, active = true;
SQL

# пароль нужен боту — кладём его в .env рядом с остальными настройками
if grep -qE '^AGENT_PASSWORD=' .env; then
  tmp=$(mktemp); sed "s|^AGENT_PASSWORD=.*|AGENT_PASSWORD=$PASS|" .env > "$tmp" && mv "$tmp" .env && chmod 600 .env
else
  printf '\nAGENT_PASSWORD=%s\n' "$PASS" >> .env
fi

echo "учётка агента готова: $EMAIL"
echo "пароль: $PASS"
echo "он же вписан в .env (AGENT_PASSWORD). В списке «Команда» эта учётка не показывается — она служебная."
