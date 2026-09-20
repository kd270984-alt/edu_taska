import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { Pool } from 'pg';
import { WebSocketServer, WebSocket } from 'ws';
import { migrate } from './migrate.ts';
import {
  hashPassword,
  verifyPasswordForgiving,
  normalizeLogin,
  loginFingerprint,
  signToken,
  verifyToken,
  sessionCookie,
  clearedSessionCookie,
  readCookie,
  SESSION_COOKIE,
  type AuthedRequest,
} from './auth.ts';
import { registerCrud } from './crud.ts';
import { registerAgent, agentOnBehalf } from './agent.ts';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const app = express();
// ⚠️ За Caddy настоящий адрес клиента приходит в X-Forwarded-For. Доверяем ОДНОМУ хопу —
// своему же прокси: так req.ip берёт адрес, который подставил Caddy, а не тот, что подделал клиент.
// Без этого тормоз перебора паролей обходился одним заголовком.
app.set('trust proxy', 1);
app.use(express.json({ limit: '12mb' }));   // вложения задач приходят base64
// Телеграм-агент: заголовок X-Telegram-Id подменяет «за кого работаем». Ставим ДО ВСЕХ маршрутов —
// иначе /api/auth/me и другие ранние маршруты отвечают самим агентом, и задача уезжает не тому человеку.
app.use(agentOnBehalf(pool));

// --- реалтайм: широковещание «что-то изменилось» по WS после любой успешной мутации ---
const wsClients = new Set<WebSocket>();
function broadcastChange(): void {
  const msg = JSON.stringify({ type: 'change' });
  for (const ws of wsClients) { if (ws.readyState === WebSocket.OPEN) { try { ws.send(msg); } catch { /* ignore */ } } }
}
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'OPTIONS') {
    // res.locals.silent — ответ, который НИЧЕГО не изменил (например, пустой автоперенос).
    // Будить им чужие вкладки незачем: иначе один сдвиг задачи размножается в веер опросов
    // (каждая вкладка на сигнал делает reload, а reload шлёт свой запрос переноса).
    res.on('finish', () => { if (res.statusCode >= 200 && res.statusCode < 300 && !res.locals.silent) broadcastChange(); });
  }
  next();
});

// CORS. ⚠️ Раньше здесь отражался ЛЮБОЙ источник вместе с Access-Control-Allow-Credentials — то есть
// любой сайт в интернете мог обращаться к нашему API от имени открытой сессии. Токен лежит не в куке,
// поэтому прямой кражи не было, но на боевом домене такой заслон держать нельзя.
// Теперь список свой: адрес приложения из APP_ORIGIN (через запятую, если их несколько).
// Пусто — значит фронт с того же домена, и кросс-доступ не нужен вовсе.
const ALLOWED_ORIGINS = String(process.env.APP_ORIGIN || '')
  .split(',').map((x) => x.trim().replace(/\/$/, '')).filter(Boolean);
app.use((req, res, next) => {
  const origin = String(req.headers.origin || '').replace(/\/$/, '');
  const sameHost = origin === `https://${req.headers.host}` || origin === `http://${req.headers.host}`;
  if (origin && (sameHost || ALLOWED_ORIGINS.includes(origin))) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
  }
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.get('/api/health', async (_req, res) => {
  try {
    const r = await pool.query('select now() as now, current_database() as db, version() as pg');
    res.json({
      ok: true,
      service: 'taska-edu-api',
      db: r.rows[0].db,
      time: r.rows[0].now,
      pg: String(r.rows[0].pg).split(' on ')[0],
    });
  } catch (e) {
    console.error('health error:', (e as Error).message);
    res.status(500).json({ ok: false, error: 'внутренняя ошибка' });
  }
});

app.get('/api/version', (_req, res) =>
  res.json({ name: 'taska-edu-api', version: '1.0.0' }),
);

// --- Auth ---
// Мягкий тормоз перебора. Теперь ответ честно различает «нет такого пользователя» и «пароль не подошёл» —
// это сильно помогает своим и немного помогает перебору, поэтому подстраховываемся.
// ВАЖНО: это НЕ блокировка. Аккаунт не запирается никогда, успешный вход не задерживается ни на миг —
// иначе мы бы своими руками сделали ровно ту беду, которую чиним («не пускает с верным паролем»).
const loginFails = new Map<string, { n: number; until: number }>();
function noteLoginFailure(ip: string): void {
  const now = Date.now(), cur = loginFails.get(ip);
  if (!cur || now > cur.until) loginFails.set(ip, { n: 1, until: now + 10 * 60_000 });
  else cur.n += 1;
  if (loginFails.size > 5000) for (const [k, v] of loginFails) if (now > v.until) loginFails.delete(k);
}
function loginFailureDelayMs(ip: string): number {
  const cur = loginFails.get(ip);
  if (!cur || Date.now() > cur.until || cur.n < 15) return 0;
  return Math.min(3000, (cur.n - 14) * 300);   // после 15 промахов за 10 минут — растущая пауза, максимум 3 сек
}

app.post('/api/auth/login', async (req, res) => {
  try {
    const { password } = req.body ?? {};
    const login = normalizeLogin((req.body ?? {}).email);
    if (!login || !password) {
      res.status(400).json({ ok: false, error: 'нужны логин и пароль' });
      return;
    }
    // Ищем регистронезависимо и ДЕТЕРМИНИРОВАННО: точное совпадение первым (без order by/limit при дублях
    // в разном регистре один и тот же пароль то подходил, то нет).
    // ВТОРОЙ ВАРИАНТ ПОИСКА — по имени без домена: люди вводят «ivanov» вместо «ivanov@example.com».
    // Это самая частая причина отказов входа. Принимаем короткую
    // форму, только если она указывает РОВНО на одного человека — иначе просим полный адрес.
    const short = !login.includes('@');
    const r = await pool.query(
      `select id, name, email, role, password_hash, active from users
        where lower(email) = $1
           or ($2 and lower(split_part(email, '@', 1)) = $1)
        order by (lower(email) = $1) desc, created_at
        limit 2`,
      [login, short],
    );
    const ip = String(req.ip || req.socket.remoteAddress || '');   // req.ip уважает trust proxy — подделать заголовком нельзя
    // короткая форма попала сразу в нескольких — не угадываем, просим полный адрес
    let ambiguous = short && r.rows.length > 1 && r.rows[0].email.toLowerCase() !== login;
    let u = ambiguous ? null : r.rows[0];
    // ПОСЛЕДНЯЯ ПОПЫТКА — разночтения транслитерации (ivanoff ↔ ivanov). Только если совпал ровно один человек.
    if (!u && !ambiguous) {
      const fp = loginFingerprint(login.split('@')[0]);
      if (fp.length >= 4) {
        const all = await pool.query('select id, name, email, role, password_hash, active from users');
        const near = all.rows.filter((z) => loginFingerprint(String(z.email).split('@')[0]) === fp);
        if (near.length === 1) u = near[0];
        else if (near.length > 1) ambiguous = true;
      }
    }
    if (!u || !u.active || !verifyPasswordForgiving(password, u.password_hash)) {
      // АУДИТ ВХОДА. Раньше в системе не было ни access-лога Caddy, ни записи о попытках входа, поэтому жалобу
      // «ввожу верный пароль, а он не пускает» нельзя было ни подтвердить, ни опровергнуть: неизвестно даже,
      // дошёл ли запрос. Пишем ТОЛЬКО факт и причину — пароль и хеш в лог не попадают.
      // reason уходит и в ответ: фронт обязан честно сказать, ЧТО не так — «неверный пароль» на несуществующий
      // логин заставляет человека менять верный пароль и биться в закрытую дверь.
      // ⚠️ Подсказка «нет такого логина / пароль не совпал» очень помогает своим, но и перебору тоже:
      // по ней составляют список живых логинов. Поэтому она гаснет, как только с адреса пошла серия
      // промахов (см. loginFailureDelayMs) — своему человеку она достанется, перебору нет.
      const noisy = loginFailureDelayMs(ip) > 0;
      const reason = noisy ? 'invalid' : (ambiguous ? 'ambiguous' : (!u ? 'no_user' : (!u.active ? 'inactive' : 'bad_password')));
      const why = { ambiguous: 'короткий логин у нескольких', no_user: 'нет такого email', inactive: 'аккаунт заблокирован', bad_password: 'пароль не совпал', invalid: 'серия промахов — подсказку не даём' }[reason];
      console.log(`login FAIL ${login} (${why}) ip=${ip}`);
      const wait = loginFailureDelayMs(ip);
      noteLoginFailure(ip);
      if (wait) await new Promise((r) => setTimeout(r, wait));
      res.status(401).json({ ok: false, error: 'invalid credentials', reason });
      return;
    }
    console.log(`login OK ${u.email} ip=${ip}`);
    const user = { id: u.id, email: u.email, role: u.role, name: u.name };
    const token = signToken(user);
    res.setHeader('Set-Cookie', sessionCookie(token));   // резервная копия сессии на случай чистки localStorage в мобильном браузере
    res.json({ ok: true, token, user });
  } catch (e) {
    console.error('login error:', (e as Error).message);
    res.status(500).json({ ok: false, error: 'внутренняя ошибка' });
  }
});

// Единственный эндпоинт, который принимает сессию из куки (все остальные — строго по заголовку Authorization).
// Так восстанавливается сессия после чистки localStorage мобильным браузером, и при этом нет почвы для CSRF:
// кука SameSite=Lax и на межсайтовые запросы не уходит, а этот эндпоинт ничего не меняет.
app.get('/api/auth/me', async (req: AuthedRequest, res) => {
  try {
    const h = req.headers.authorization || '';
    const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
    // Куку принимаем ТОЛЬКО у своего же сайта. CORS здесь отражает любой источник (нужно для превью),
    // поэтому чужой странице нельзя дать ни малейшего шанса вычитать по куке свежий токен.
    const origin = String(req.headers.origin || '');
    const sameSite = !origin || origin === `https://${req.headers.host}` || origin === `http://${req.headers.host}`;
    const jwtUser = (bearer && verifyToken(bearer)) || (sameSite ? verifyToken(readCookie(req.headers.cookie, SESSION_COOKIE)) : null);
    if (!jwtUser) {
      res.setHeader('Set-Cookie', clearedSessionCookie());
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
    // сверяем с БД: заблокированный (active=false) вылетает при следующей загрузке, не дожидаясь истечения JWT
    const r = await pool.query('select id, name, email, role, active, avatar_key, avatar_no, settings from users where id = $1', [jwtUser.id]);
    const u = r.rows[0];
    if (!u || !u.active) {
      res.setHeader('Set-Cookie', clearedSessionCookie());
      res.status(401).json({ ok: false, error: 'доступ отключён' });
      return;
    }
    // ПРОДЛЕНИЕ СЕССИИ: на каждом запуске приложения выдаём свежий токен на полный срок.
    // Пока человек пользуется Таской хотя бы раз в 90 дней, его больше НИКОГДА не выкинет по истечении.
    const fresh = signToken({ id: u.id, email: u.email, role: u.role, name: u.name });
    res.setHeader('Set-Cookie', sessionCookie(fresh));
    res.json({ ok: true, token: fresh, user: { id: u.id, name: u.name, email: u.email, role: u.role, avatar_key: u.avatar_key, avatar_no: u.avatar_no, settings: u.settings || {} } });
  } catch (e) {
    console.error('auth/me error:', (e as Error).message);
    res.status(500).json({ ok: false, error: 'внутренняя ошибка' });
  }
});

// «Выйти» должен гасить и резервную куку — иначе следующий запуск молча восстановил бы сессию
app.post('/api/auth/logout', (_req, res) => {
  res.setHeader('Set-Cookie', clearedSessionCookie());
  res.json({ ok: true });
});

registerAgent(app, pool);

// Задачи, метки, вложения, пользователи (CRUD с проверкой ролей и прав) — модуль crud.ts
registerCrud(app, pool);

// понятная ошибка вместо «оборванного» ответа, когда файл больше лимита multer (50 МБ)
app.use((err: any, _req: any, res: any, next: any) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ ok: false, error: 'файл больше 50 МБ' });
  if (err && err.name === 'MulterError') return res.status(400).json({ ok: false, error: 'не удалось принять файл: ' + err.message });
  return next(err);
});

const server = http.createServer(app);

// WebSocket: клиент подписывается и получает {type:'change'} при любой мутации → тихо перезагружает данные
// ⚠️ Подписка ТОЛЬКО со своим токеном. Раньше сюда пускали кого угодно и без счёта: данных канал
// не отдаёт (только сигнал «что-то изменилось»), но открыть тысячи соединений мог любой прохожий.
// Токен идёт в адресе (?tk=…): браузерный WebSocket не умеет слать заголовок Authorization.
const WS_MAX = 500;
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!req.url || !req.url.startsWith('/ws')) { socket.destroy(); return; }
  const tk = new URLSearchParams(String(req.url).split('?')[1] || '').get('tk') || '';
  if (!verifyToken(tk) || wsClients.size >= WS_MAX) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
wss.on('connection', (ws: WebSocket) => {
  wsClients.add(ws);
  ws.send(JSON.stringify({ type: 'hello' }));
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

// Если пользователей нет — создаём админа из ADMIN_EMAIL с временным паролем (печатается в лог 1 раз)
async function bootstrapAdmin(): Promise<void> {
  const { rows } = await pool.query('select count(*)::int as n from users');
  if (rows[0].n > 0) return;
  const email = process.env.ADMIN_EMAIL || 'admin@example.com';
  const pw = crypto.randomBytes(9).toString('base64url');
  await pool.query(
    `insert into users(name, email, password_hash, role, active) values($1,$2,$3,'admin',true)`,
    ['Администратор', email, hashPassword(pw)],
  );
  console.log(`ADMIN_BOOTSTRAP email=${email} temp_password=${pw}`);
}

const port = Number(process.env.API_PORT || 3000);

migrate(pool)
  .then(bootstrapAdmin)
  .then(() => {
    server.listen(port, '0.0.0.0', () => console.log(`taska-edu api listening on :${port}`));
  })
  .catch((e) => {
    console.error('startup failed:', (e as Error).message);
    process.exit(1);
  });
