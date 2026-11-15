#!/usr/bin/env bash
# ДЕМО-КОМАНДА ЗАНОВО: стирает ВСЕ данные Таски и сажает трёх вымышленных сотрудников с задачами —
# ровно то, что Таска заводит сама при первом запуске (код посадки общий: api/src/demo-seed.ts).
#
#   логин    пароль                           кто
#   admin    новый случайный (скрипт покажет) Анна Соколова — администратор
#   manager  нет — войти нельзя               Игорь Волков  — руководитель (обычный пользователь)
#   user     нет — войти нельзя               Мария Лебедева — сотрудник
#   Игорю и Марии пароль задаёт администратор карандашом в «Команде», если они нужны для показа.
#
# ⚠️ УДАЛЯЕТ ВСЁ: людей, задачи, метки, комментарии, вложения. Учётка телеграм-агента
#    (AGENT_EMAIL из .env) не трогается — иначе бот отвалится. Данные CRM остаются (bash scripts/crm-demo.sh reset).
# ⚠️ Прежний пароль администратора перестаёт действовать — новый скрипт печатает в конце.
#
# Запуск из папки проекта:
#   bash scripts/demo-reset.sh          — покажет, что будет стёрто, и спросит «да/нет»
#   bash scripts/demo-reset.sh --yes    — без вопроса (для помощника — только после «да» человека)
# Без терминала и без --yes ничего не стирает, код 3. Старый вызов с адресом (… demo-reset.sh https://…)
# тоже понимается: адрес больше не нужен и пропускается.
# База меняется одной транзакцией: при сбое она остаётся как была. Нужен docker compose.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f docker-compose.yml ] && [ -f .env ] || { echo "Нет docker-compose.yml или .env — запустите скрипт в папке Таски" >&2; exit 1; }

YES=0
for a in "$@"; do
  case "$a" in
    --yes) YES=1 ;;
    -*) echo "непонятный ключ: $a (есть только --yes)" >&2; exit 2 ;;
    *) ;;   # прежний параметр — адрес Таски; больше не нужен
  esac
done

# учётка агента из .env: последняя строка, без пробелов и комментария
AGENT=$({ grep -E '^AGENT_EMAIL=' .env || true; } | tail -1 | cut -d= -f2- | sed -E 's/(^|[[:space:]])#.*$//' | tr -d ' "\r')
AGENT="${AGENT:-agent@taska.local}"

api_up(){ docker compose exec -T api node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; }
[ -n "$(docker compose ps -q api 2>/dev/null)" ] || { echo "Таска не запущена — сначала: docker compose up -d" >&2; exit 1; }
if ! api_up; then
  echo "Жду, пока Таска запустится…" >&2
  for _ in $(seq 1 150); do api_up && break; sleep 2; done
  api_up || { echo "Таска не ответила за 5 минут — посмотрите журнал: docker compose logs api --tail 50" >&2; exit 1; }
fi
cli(){ docker compose exec -T -e KEEP_EMAIL="$AGENT" api node_modules/.bin/tsx src/demo-cli.ts "$1"; }

NOW=$(cli count)
Q="Сейчас в Таске: $NOW. Стереть ВСЁ это и посадить демо-команду заново? Учётка агента $AGENT останется."
if [ "$YES" != 1 ]; then
  if [ -t 0 ]; then
    read -r -p "$Q [да/нет] " ans
    case "$ans" in д|да|Да|ДА|y|Y|yes) ;; *) echo "Отменено, ничего не стёрто."; exit 3 ;; esac
  else
    echo "$Q" >&2
    echo "Ничего не сделано: стирание — только с явным согласием. Чтобы подтвердить, повторите с --yes: bash scripts/demo-reset.sh --yes" >&2
    exit 3
  fi
fi

echo "1/3 база: стираю и сажаю демо-команду (одной транзакцией)"
set +e; OUT=$(cli reset); RC=$?; set -e
case "$RC" in
  0) echo "$OUT" ;;
  4) ;;   # демо посажено, записка не сохранилась — строки входа в OUT, покажем их в конце
  *) echo "Не вышло — база осталась как была. Подробности выше; журнал: docker compose logs api --tail 50" >&2; exit 1 ;;
esac

echo "2/3 хранилище: удаляю файлы вложений и аватарок"
# файлы вложений и аватарок в MinIO — подчистую
docker compose exec -T api sh -lc 'cd /app && node -e "
const M=require(\"minio\"); const [h,p]=(process.env.MINIO_ENDPOINT||\"minio:9000\").split(\":\");
const mc=new M.Client({endPoint:h,port:+p||9000,useSSL:false,accessKey:process.env.MINIO_ROOT_USER,secretKey:process.env.MINIO_ROOT_PASSWORD});
const b=process.env.MINIO_BUCKET||\"attachments\"; const names=[];
mc.bucketExists(b).then(ok=>{ if(!ok) return; const st=mc.listObjects(b,\"\",true);
 st.on(\"data\",o=>names.push(o.name)); st.on(\"end\",async()=>{ if(names.length) await mc.removeObjects(b,names); console.log(\"файлов удалено:\",names.length); }); });
"' 2>/dev/null || echo "хранилище: пропущено"

echo "3/3 готово. Вход:"
if [ "$RC" = 0 ]; then cli show; else printf '%s\n' "$OUT"; fi
