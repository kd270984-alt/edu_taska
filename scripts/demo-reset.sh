#!/usr/bin/env bash
# ДЕМО-КОМАНДА: стирает ВСЕ данные Таски и сажает трёх вымышленных сотрудников с задачами.
# Нужен для обучения и для первого знакомства: сразу есть что посмотреть.
#
#   логин    пароль   кто
#   admin    123456   Анна Соколова — администратор
#   manager  123456   Игорь Волков  — руководитель (обычный пользователь)
#   user     123456   Мария Лебедева — сотрудник
#
# ⚠️ УДАЛЯЕТ ВСЁ: людей, задачи, метки, комментарии, вложения. Учётка телеграм-агента
#    (AGENT_EMAIL из .env) не трогается — иначе бот отвалится.
# ⚠️ Пароли 123456 — только для демонстрации. Перед настоящей работой смените их в профилях.
#
# Запуск из папки проекта:  bash scripts/demo-reset.sh [адрес]     (по умолчанию http://127.0.0.1:8088)
# Нужны: docker compose, curl, python3.
set -euo pipefail
cd "$(dirname "$0")/.."
BASE="${1:-http://127.0.0.1:8088}"
PGU=$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2); PGD=$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2)
AGENT=$(grep -E '^AGENT_EMAIL=' .env | cut -d= -f2 | tr -d ' '); AGENT="${AGENT:-agent@taska.local}"
PASS=123456

echo "1/4 хеш пароля"
HASH=$(docker compose exec -T api sh -lc "cd /app && npx --yes tsx -e \"import {hashPassword} from './src/auth.ts'; console.log(hashPassword('$PASS'))\"" | tail -1)
[ -n "$HASH" ] || { echo "не смог посчитать хеш пароля — контейнер api запущен?" >&2; exit 1; }

echo "2/4 чистка базы и хранилища"
docker compose exec -T postgres psql -U "$PGU" -d "$PGD" -q <<SQL
begin;
delete from comments; delete from task_tags; delete from task_co_assignees; delete from attachments;
delete from tasks; delete from tags;
delete from users where email <> '$AGENT';
insert into users(name, email, password_hash, role, active, avatar_no) values
  ('Анна Соколова',  'admin',   '$HASH', 'admin',  true, 0),
  ('Игорь Волков',   'manager', '$HASH', 'member', true, 4),
  ('Мария Лебедева', 'user',    '$HASH', 'member', true, 8);
commit;
SQL
# файлы вложений и аватарок в MinIO — подчистую
docker compose exec -T api sh -lc 'cd /app && node -e "
const M=require(\"minio\"); const [h,p]=(process.env.MINIO_ENDPOINT||\"minio:9000\").split(\":\");
const mc=new M.Client({endPoint:h,port:+p||9000,useSSL:false,accessKey:process.env.MINIO_ROOT_USER,secretKey:process.env.MINIO_ROOT_PASSWORD});
const b=process.env.MINIO_BUCKET||\"attachments\"; const names=[];
mc.bucketExists(b).then(ok=>{ if(!ok) return; const st=mc.listObjects(b,\"\",true);
 st.on(\"data\",o=>names.push(o.name)); st.on(\"end\",async()=>{ if(names.length) await mc.removeObjects(b,names); console.log(\"файлов удалено:\",names.length); }); });
"' 2>/dev/null || echo "хранилище: пропущено"

echo "3/4 задачи через API (как их создали бы люди)"
python3 - "$BASE" "$PASS" <<'PY'
import json, subprocess, sys, datetime
base, pw = sys.argv[1], sys.argv[2]
def call(tok, path, body=None, method=None):
    a=['curl','-s','-X', method or ('POST' if body is not None else 'GET'), base+path, '-H','Content-Type: application/json']
    if tok: a += ['-H','Authorization: Bearer '+tok]
    if body is not None: a += ['-d', json.dumps(body, ensure_ascii=False)]
    out=subprocess.run(a, capture_output=True, text=True).stdout
    try: return json.loads(out)
    except Exception: return {}
def login(email): 
    r=call(None,'/api/auth/login',{'email':email,'password':pw}); tok=r.get('token')
    if not tok: sys.exit('не вошёл как '+email+': '+json.dumps(r, ensure_ascii=False))
    return tok
T={u:login(u) for u in ('admin','manager','user')}
users={u['email']:u['id'] for u in call(T['admin'],'/api/users').get('users',[])}
# метки заводит администратор
for nm,ck in [('Клиенты','blue'),('Срочно','red'),('Склад','yellow'),('Офис','green'),('Финансы','purple')]:
    call(T['admin'],'/api/tags',{'name':nm,'color_key':ck})
tags={t['name']:t['id'] for t in call(T['admin'],'/api/tags').get('tags',[])}
today=datetime.date.today()
D=lambda off:(today+datetime.timedelta(days=off)).isoformat()
# (кто, смещение дня, время, название, метки, соисполнители, описание)
PLAN={
 'admin':[(-2,'10:00','Согласовать бюджет на четвёртый квартал',['Финансы'],['manager'],'<div>Свести цифры по отделам.</div><div class="cl-item"><span class="cl-box" contenteditable="false"></span>Собрать заявки</div><div class="cl-item"><span class="cl-box" contenteditable="false"></span>Показать директору</div>'),
   (0,'09:30','Планёрка с руководителями',['Офис'],['manager','user'],''),
   (0,None,'Подписать договор с «Северстрой»',['Клиенты','Срочно'],[],'<div>Договор согласован юристами, осталась подпись.</div>'),
   (1,'14:00','Собеседование на должность менеджера',['Офис'],[],''),
   (1,None,'Проверить отчёт по продажам за неделю',['Финансы'],['manager'],''),
   (2,'11:00','Встреча с банком по кредитной линии',['Финансы'],[],''),
   (3,None,'Обновить регламент отпусков',['Офис'],[],''),
   (4,'16:00','Итоги месяца с командой',['Офис'],['manager','user'],''),
   (7,None,'Продлить страховку офиса',['Офис','Финансы'],[],''),
   (9,None,'Заказать новогодние подарки клиентам',['Клиенты'],['user'],'')],
 'manager':[(-1,'12:00','Отправить коммерческое предложение «Ремстрой»',['Клиенты'],[],''),
   (0,'11:30','Созвон с поставщиком по срокам',['Склад','Срочно'],[],'<div>Уточнить дату поставки плитки.</div>'),
   (0,None,'Подготовить смету для «Уютного дома»',['Клиенты'],['user'],''),
   (1,'10:00','Проверить остатки на складе',['Склад'],[],''),
   (1,None,'Согласовать график доставок на неделю',['Склад'],[],''),
   (2,'15:00','Показ объекта заказчику',['Клиенты'],[],''),
   (3,None,'Собрать отзывы с последних трёх объектов',['Клиенты'],['user'],''),
   (5,'13:00','Обучение новых сотрудников по складу',['Склад','Офис'],[],''),
   (6,None,'Пересчитать цены с учётом новых закупок',['Финансы'],[],''),
   (8,None,'План продаж на следующий месяц',['Финансы'],[],'')],
 'user':[(-1,None,'Позвонить клиенту по рекламации',['Клиенты','Срочно'],[],''),
   (0,'10:00','Выставить счета за неделю',['Финансы'],[],''),
   (0,None,'Разобрать почту и ответить клиентам',['Клиенты'],[],''),
   (1,'09:00','Принять поставку на склад',['Склад'],[],'<div class="cl-item"><span class="cl-box" contenteditable="false"></span>Сверить по накладной</div><div class="cl-item"><span class="cl-box" contenteditable="false"></span>Сфотографировать брак</div>'),
   (1,'15:30','Записать клиента на замер',['Клиенты'],[],''),
   (2,None,'Обновить прайс на сайте',['Офис'],[],''),
   (3,'12:00','Отвезти документы в налоговую',['Финансы'],[],''),
   (4,None,'Заказать канцелярию в офис',['Офис'],[],''),
   (6,None,'Подготовить фото объектов для соцсетей',['Клиенты'],[],''),
   (10,None,'Инвентаризация склада',['Склад'],[],'')]}
ids={}
for who,items in PLAN.items():
    for off,tm,name,tg,co,desc in items:
        b={'name':name,'due_date':D(off),'description':desc or None}
        if tm: b['due_time']=tm
        if tg: b['tag_ids']=[tags[x] for x in tg if x in tags]
        if co: b['co_assignees']=[users[x] for x in co if x in users]
        r=call(T[who],'/api/tasks',b); tid=r.get('task',{}).get('id'); ids[(who,name)]=tid
# подзадачи, комментарии, повторение — чтобы карточки были живыми
p=ids[('manager','Подготовить смету для «Уютного дома»')]
for sname in ['Замерить помещение','Посчитать материалы','Отправить смету клиенту']:
    call(T['manager'],'/api/tasks',{'name':sname,'due_date':D(1),'parent_id':p,'assignee_id':users['user']})
call(T['user'],'/api/tasks/'+p+'/comments',{'text':'Замер сделаю завтра утром, материалы посчитаю к обеду.'})
call(T['manager'],'/api/tasks/'+p+'/comments',{'text':'Хорошо. Смету нужно отправить до среды.'})
call(T['admin'],'/api/tasks/'+ids[('admin','Планёрка с руководителями')],{'recurrence_type':'weekly','recurrence_days':[1]},'PATCH')
call(T['user'],'/api/tasks/'+ids[('user','Выставить счета за неделю')],{'recurrence_type':'weekly','recurrence_days':[5]},'PATCH')
# пара завершённых — чтобы архив не был пустым
for who,name in [('manager','Отправить коммерческое предложение «Ремстрой»'),('user','Позвонить клиенту по рекламации')]:
    call(T[who],'/api/tasks/'+ids[(who,name)],{'archived':True,'completed_at':datetime.datetime.now().isoformat()},'PATCH')
n=sum(len(v) for v in PLAN.values())
print(f'создано задач: {n} + 3 подзадачи, меток: {len(tags)}, завершённых: 2')
PY

echo "4/4 готово. Вход: admin / manager / user, пароль $PASS — $BASE"
