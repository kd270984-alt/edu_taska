// Проверка бота с каждой нейросетью БЕЗ настоящих ключей и без сети: поддельные Телеграм, Таска,
// OpenAI, Claude (Anthropic) и Kimi (Moonshot) поднимаются здесь же на 127.0.0.1, а бот запускается
// как есть (src/index.ts) и смотрит на них через переменные адресов. Запуск: npm run checkproviders
//
// Что проверяем: задача из текста по каждой нейросети (с вызовом инструмента), голос с ключом OpenAI
// и без него, ошибки ключа (401 / нет денег / страна / ключа нет), второй экземпляр бота (409),
// неверный токен, строки BOT_STATUS для портала и что ключи не попадают в журнал. С 12.11.2026 ещё:
// «лимит запросов» не путается с «нет денег», ключ OpenAI для голоса при Claude/Kimi, вебхук вместо
// второго экземпляра, опрос Телеграма не ждёт Таску, долгий ход не доделывается в фоне.
// ⚠️ «Второй экземпляр» здесь упрощён: поддельный Телеграм всегда отвечает 409. Настоящую гонку двух ботов
//    (кто опросил позже, тот и выиграл) так не воспроизвести.
import http from 'node:http';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

let ok = 0, bad = 0;
const check = (name: string, good: boolean, extra = '') => {
  good ? (ok++, console.log('  ✓', name)) : (bad++, console.log('  ✗', name, extra));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// Поддельные сервисы — один сервер, разные начала адреса

interface World {
  token: string;                    // токен бота: TWIN — второй экземпляр (409), BAD — неверный
  inbox: any[];                     // сообщения человека — отдаём по одному, после ответа на предыдущее
  sent: string[];                   // что бот написал в Телеграм
  delivered: number;
  tasks: any[];                     // что бот создал в Таске
  llm: Record<string, any[]>;       // запросы к нейросетям
  unhooked?: boolean;               // бот выключил вебхук
  taskaFrom?: number;               // до этого момента Таска «ещё запускается» (503)
}
let W: World = { token: "", inbox: [], sent: [], delivered: 0, tasks: [], llm: { openai: [], anthropic: [], moonshot: [] } };
const fresh = (token: string, inbox: any[]): World => ({ token, inbox, sent: [], delivered: 0, tasks: [], llm: { openai: [], anthropic: [], moonshot: [] } });

const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); })();

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const p of req) parts.push(p as Buffer);
  return Buffer.concat(parts).toString('utf8');
}

let updateId = 0;
async function telegram(method: string, token: string, body: any, res: http.ServerResponse): Promise<void> {
  if (token === 'BAD') return json(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
  if (method === 'getMe') return json(res, 200, { ok: true, result: { id: 1, is_bot: true, username: 'check_bot' } });
  if (method === 'getUpdates') {
    if (token === 'HOOK' && !W.unhooked) return json(res, 409, { ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first" });
    if (token === 'TWIN') return json(res, 409, { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' });
    // следующее сообщение — только когда на предыдущее уже ответили: так проверяем и второй ход разговора
    if (W.delivered < W.inbox.length && W.sent.length >= W.delivered) {
      const m = W.inbox[W.delivered++];
      return json(res, 200, { ok: true, result: [{ update_id: ++updateId, message: { message_id: updateId, chat: { id: 501, type: 'private' }, from: { id: 501, first_name: 'Аня' }, ...m } }] });
    }
    await sleep(150);
    return json(res, 200, { ok: true, result: [] });
  }
  if (method === 'sendMessage') { W.sent.push(String(body.text)); return json(res, 200, { ok: true, result: {} }); }
  if (method === 'deleteWebhook') { W.unhooked = true; return json(res, 200, { ok: true, result: true }); }
  if (method === 'sendChatAction') return json(res, 200, { ok: true, result: true });
  if (method === 'getFile') return json(res, 200, { ok: true, result: { file_id: body.file_id, file_size: 1000, file_path: 'voice/file_1.oga' } });
  return json(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
}

function taska(path: string, method: string, body: any, res: http.ServerResponse): void {
  if (path === '/api/auth/login') return json(res, 200, { token: 'agent-token' });
  if (path === '/api/health') return W.taskaFrom && Date.now() < W.taskaFrom ? json(res, 503, { error: 'starting' }) : json(res, 200, { ok: true });
  if (path.startsWith('/api/agent/resolve')) return json(res, 200, { linked: true, user: { id: 'u1', name: 'Аня' } });
  if (path === '/api/tags') return json(res, 200, { tags: [] });
  if (path.startsWith('/api/tasks') && method === 'GET') return json(res, 200, { tasks: W.tasks });
  if (path === '/api/tasks' && method === 'POST') {
    const t = { id: 't' + (W.tasks.length + 1), name: body.name, due_date: body.due_date, due_time: body.due_time || null, tags: [] };
    W.tasks.push(t);
    return json(res, 201, { task: t });
  }
  return json(res, 404, { error: 'нет такого адреса' });
}

const toolArgs = { name: 'Позвонить клиенту', due_date: tomorrow, due_time: '11:00' };

// OpenAI: Responses API (текст) и transcriptions (голос). Ключ решает, какая ошибка.
function openai(path: string, key: string, body: any, res: http.ServerResponse): void {
  if (key === 'sk-test-401') return json(res, 401, { error: { message: `Incorrect API key provided: ${key}.`, type: 'invalid_request_error', code: 'invalid_api_key' } });
  if (key === 'sk-test-quota') return json(res, 429, { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' } });
  // «лимит запросов» со ссылкой на billing в тексте — это НЕ «нет денег»
  if (key === 'sk-test-rate') return json(res, 429, { error: { message: 'Rate limit reached for gpt-5 in organization org-x on requests per min (RPM): Limit 3. Add a payment method to your account to increase your rate limit. Visit https://platform.openai.com/account/billing to add a payment method.', type: 'requests', code: 'rate_limit_exceeded' } });
  if (path === '/models') return json(res, 200, { object: 'list', data: [{ id: 'gpt-4o-transcribe', object: 'model', created: 1, owned_by: 'openai' }] });
  // список моделей отдаётся и при пустом счёте — деньги кончаются только на распознавании
  if (key === 'sk-test-voicequota') return json(res, 429, { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' } });
  if (path === '/audio/transcriptions') return json(res, 200, { text: 'добавь задачу позвонить клиенту на завтра в 11' });
  if (path !== '/responses') return json(res, 404, { error: { message: 'not found' } });
  W.llm.openai.push(body);
  const msg = (text: string) => ({ type: 'message', id: 'm' + W.llm.openai.length, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
  if (body.input === 'ping') return json(res, 200, { id: 'r0', object: 'response', status: 'completed', output: [msg('pong')] });
  // смотрим только на текущий ход: после последнего сообщения человека
  const input: any[] = body.input || [];
  let lastUser = -1;
  input.forEach((i: any, n: number) => { if (i?.role === 'user') lastUser = n; });
  const done = input.slice(lastUser + 1).some((i: any) => i?.type === 'function_call_output');
  const output = done
    ? [msg(`Создал задачу «Позвонить клиенту» на ${tomorrow} в 11:00.`)]
    : [{ type: 'function_call', id: 'fc1', call_id: 'call_1', name: 'create_task', arguments: JSON.stringify(toolArgs), status: 'completed' }];
  json(res, 200, { id: 'r' + W.llm.openai.length, object: 'response', status: 'completed', output });
}

// Claude: Messages API. В ответах — блоки «размышлений» с подписью: бот не должен нести их в следующий ход.
async function anthropic(path: string, key: string, body: any, res: http.ServerResponse): Promise<void> {
  if (key === 'ak-test-401') return json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
  if (key === 'ak-test-402') return json(res, 402, { type: 'error', error: { type: 'billing_error', message: 'Your credit balance is too low to access the Anthropic API.' } });
  if (path !== '/v1/messages') return json(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'not found' } });
  W.llm.anthropic.push(body);
  const base = { id: 'msg_' + W.llm.anthropic.length, type: 'message', role: 'assistant', model: body.model, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
  const msgs = body.messages || [];
  if (msgs.length === 1 && msgs[0].content === 'ping') return json(res, 200, { ...base, content: [{ type: 'text', text: 'pong' }], stop_reason: 'end_turn' });
  const last = msgs[msgs.length - 1];
  const think = { type: 'thinking', thinking: 'обдумываю', signature: 'sig-' + W.llm.anthropic.length };
  if (Array.isArray(last?.content) && last.content.some((b: any) => b?.type === 'tool_result')) {
    // «медленный» ключ: после вызова инструмента задумывается дольше, чем бот ждёт ход
    // и потом снова зовёт create_task: если бы бот доделывал ход в фоне, появилась бы лишняя задача
    if (key === 'ak-test-slow') {
      await sleep(4000);
      if (res.destroyed || res.writableEnded) return;
      return json(res, 200, { ...base, content: [{ type: 'tool_use', id: 'toolu_late' + W.llm.anthropic.length, name: 'create_task', input: { ...toolArgs, name: 'Лишняя задача из фона' } }], stop_reason: 'tool_use' });
    }
    return json(res, 200, { ...base, content: [think, { type: 'text', text: `Создал задачу «Позвонить клиенту» на ${tomorrow}.` }], stop_reason: 'end_turn' });
  }
  json(res, 200, { ...base, content: [think, { type: 'tool_use', id: 'toolu_' + W.llm.anthropic.length, name: 'create_task', input: toolArgs }], stop_reason: 'tool_use' });
}

// Kimi: chat completions, совместимый с OpenAI. Поиска (Formula) у поддельного нет — 404.
function moonshot(path: string, key: string, body: any, res: http.ServerResponse): void {
  if (key === 'mk-test-403') return json(res, 403, { error: { message: 'Your region is not supported by this service.', type: 'permission_denied_error' } });
  if (path !== '/chat/completions') return json(res, 404, { error: { message: 'not found', type: 'resource_not_found_error' } });
  W.llm.moonshot.push(body);
  const msgs = body.messages || [];
  const reply = (message: any, finish: string) => json(res, 200, {
    id: 'c' + W.llm.moonshot.length, object: 'chat.completion', created: 1, model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', reasoning_content: 'думаю ' + W.llm.moonshot.length, ...message }, finish_reason: finish }],
  });
  if (msgs.length === 1 && msgs[0].content === 'ping') return reply({ content: 'pong' }, 'stop');
  if (msgs[msgs.length - 1]?.role === 'tool') return reply({ content: `Создал задачу «Позвонить клиенту» на ${tomorrow}.` }, 'stop');
  reply({ content: '', tool_calls: [{ id: 'create_task:0', type: 'function', function: { name: 'create_task', arguments: JSON.stringify(toolArgs) } }] }, 'tool_calls');
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '';
  let raw = '';
  try { raw = await readBody(req); } catch { return; }   // бот оборвал запрос (таймаут хода) — это нормально
  let body: any = {};
  if ((req.headers['content-type'] || '').includes('json')) { try { body = JSON.parse(raw || '{}'); } catch { body = {}; } }
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  let m: RegExpMatchArray | null;
  if ((m = url.match(/^\/tg\/file\/bot[^/]+\//))) { res.writeHead(200); return res.end(Buffer.from('OggS-поддельная-запись')); }
  if ((m = url.match(/^\/tg\/bot([^/]+)\/(\w+)/))) return telegram(m[2], m[1], body, res);
  if (url.startsWith('/taska')) return taska(url.slice(6), req.method || 'GET', body, res);
  if (url.startsWith('/openai/v1')) return openai(url.slice(10), bearer, body, res);
  if (url.startsWith('/anthropic')) return anthropic(url.slice(10).split('?')[0], String(req.headers['x-api-key'] || bearer)   /* SDK 1.x шлёт ключ в Authorization */, body, res);
  if (url.startsWith('/moonshot/v1')) return moonshot(url.slice(12), bearer, body, res);
  json(res, 404, {});
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// ---------------------------------------------------------------------------------------------
// Запуск настоящего бота против поддельного мира

interface Run { out: string; status: string[]; exitCode: number | null }

async function runBot(env: Record<string, string>, world: World, until: (w: World, out: string) => boolean, ms = 20_000): Promise<Run> {
  W = world;
  // Окружение — чистое: ключи с этой машины в проверку попасть не должны
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),   // в пути бывают пробелы
    env: {
      PATH: process.env.PATH || '', HOME: process.env.HOME || '', TZ: 'Europe/Moscow',
      TELEGRAM_BOT_TOKEN: world.token, TELEGRAM_API_URL: `${BASE}/tg`, TASKA_URL: `${BASE}/taska`,
      AGENT_EMAIL: 'agent@taska.local', AGENT_PASSWORD: 'check',
      OPENAI_BASE_URL: `${BASE}/openai/v1`, ANTHROPIC_BASE_URL: `${BASE}/anthropic`, MOONSHOT_BASE_URL: `${BASE}/moonshot/v1`,
      ...env,
    },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  let exitCode: number | null = null;
  const exited = new Promise<void>((r) => child.on('exit', (c) => { exitCode = c; r(); }));
  const t0 = Date.now();
  while (Date.now() - t0 < ms && exitCode === null && !until(world, out)) await sleep(100);
  await sleep(300);   // дать дописать журнал
  if (exitCode === null) { child.kill('SIGTERM'); await exited; }
  const status = out.split('\n').filter((l) => l.startsWith('BOT_STATUS ')).map((l) => l.trim());
  if (process.env.CHECK_DEBUG === '1') console.log(out);
  return { out, status, exitCode };
}

const has = (r: Run, line: string) => r.status.includes(line);
const noSecrets = (r: Run, ...keys: string[]) => keys.every((k) => !r.out.includes(k));
const answered = (n: number) => (w: World) => w.sent.length >= n;
const text = (t: string) => ({ text: t });
const voice = { voice: { file_id: 'voice-1', duration: 3 } };
const ask = 'добавь задачу позвонить клиенту на завтра в 11';

// 1) OpenAI — как было: задача из текста, голос, поиск в интернете
console.log('\nOpenAI (как было до 11.11.2026):');
{
  const r = await runBot({ OPENAI_API_KEY: 'sk-test-good' }, fresh('T1', [text(ask), voice]), answered(2));
  check('строка telegram=ok', has(r, 'BOT_STATUS telegram=ok bot=@check_bot'), r.status.join(' | '));
  check('строка model=ok provider=openai model=gpt-5', has(r, 'BOT_STATUS model=ok provider=openai model=gpt-5'), r.status.join(' | '));
  check('строка voice=on', has(r, 'BOT_STATUS voice=on'));
  check('строка poll=ok', has(r, 'BOT_STATUS poll=ok'));
  check('задача создана из текста', W.tasks.length >= 1 && W.tasks[0].name === 'Позвонить клиенту' && W.tasks[0].due_date === tomorrow, JSON.stringify(W.tasks));
  check('ответ человеку о задаче', /Создал задачу/.test(W.sent[0] || ''), W.sent[0]);
  const req = W.llm.openai.find((b) => Array.isArray(b.input));
  check('модель gpt-5, поиск в интернете на месте, store=false', req?.model === 'gpt-5' && req.tools.some((t: any) => t.type === 'web_search') && req.store === false);
  check('в system — сегодняшняя дата (как было)', /Сегодня \d{4}-\d\d-\d\d/.test(req?.instructions || ''));
  check('голосовое расшифровано и выполнено', /Расслышал/.test(W.sent[1] || '') && W.tasks.length === 2, W.sent[1]);
  check('ключ не попал в журнал', noSecrets(r, 'sk-test-good'));
}

// 2) Claude: задача из текста, второй ход без старых размышлений, постоянный system, голос без ключа OpenAI
console.log('\nClaude (ANTHROPIC_API_KEY, без ключа OpenAI):');
{
  const r = await runBot({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'ak-test-good' }, fresh('T2', [text(ask), text('и ещё одну такую же'), voice]), answered(3));
  check('строка model=ok provider=anthropic model=claude-sonnet-5-5', has(r, 'BOT_STATUS model=ok provider=anthropic model=claude-sonnet-5-5'), r.status.join(' | '));
  check('строка voice=off', has(r, 'BOT_STATUS voice=off'));
  check('строка poll=ok', has(r, 'BOT_STATUS poll=ok'));
  check('задача создана из текста', W.tasks.length === 2 && W.tasks[0].name === 'Позвонить клиенту', JSON.stringify(W.tasks));
  check('ответ человеку о задаче', /Создал задачу/.test(W.sent[0] || ''), W.sent[0]);
  const reqs = W.llm.anthropic.filter((b) => !(b.messages.length === 1 && b.messages[0].content === 'ping'));
  check('инструменты переданы в формате Claude', reqs[0]?.tools?.some((t: any) => t.name === 'create_task' && t.input_schema));
  check('результат инструмента вернулся как tool_result', reqs[1]?.messages.at(-1)?.content?.[0]?.type === 'tool_result');
  check('внутри хода размышления сохранены', reqs[1]?.messages.some((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'thinking')));
  const second = reqs[2];   // первый запрос второго хода
  check('между ходами размышлений в истории нет', !!second && !second.messages.some((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'thinking')), JSON.stringify(second?.messages).slice(0, 300));
  check('system одинаковый во всех запросах и без даты', reqs.every((b) => b.system === reqs[0].system) && !/Сегодня \d{4}/.test(reqs[0].system));
  check('дата — в сообщении человека', /^\[Сегодня \d{4}-\d\d-\d\d/.test(reqs[0]?.messages.at(-1)?.content || ''));
  check('голосовое без ключа OpenAI — вежливый отказ', /Голосовые понимаю только с ключом OpenAI/.test(W.sent[2] || ''), W.sent[2]);
  check('ключ не попал в журнал', noSecrets(r, 'ak-test-good'));
}

// 3) Kimi: задача из текста, reasoning_content сохраняется, низкая «глубина», поиск недоступен — без него
console.log('\nKimi (MOONSHOT_API_KEY):');
{
  const r = await runBot({ AI_PROVIDER: 'moonshot', MOONSHOT_API_KEY: 'mk-test-good' }, fresh('T3', [text(ask)]), answered(1));
  check('строка model=ok provider=moonshot model=kimi-k3.1-pro', has(r, 'BOT_STATUS model=ok provider=moonshot model=kimi-k3.1-pro'), r.status.join(' | '));
  check('строка voice=off', has(r, 'BOT_STATUS voice=off'));
  check('задача создана из текста', W.tasks.length === 1 && W.tasks[0].due_date === tomorrow, JSON.stringify(W.tasks));
  check('ответ человеку о задаче', /Создал задачу/.test(W.sent[0] || ''), W.sent[0]);
  const reqs = W.llm.moonshot.filter((b) => b.messages.length > 1);
  check('reasoning_effort=low и инструменты-функции', reqs[0]?.reasoning_effort === 'low' && reqs[0]?.tools?.some((t: any) => t.function?.name === 'create_task'));
  check('сообщение с вызовом передано целиком (с reasoning_content)', reqs[1]?.messages.some((m: any) => m.role === 'assistant' && m.reasoning_content && m.tool_calls));
  check('результат инструмента — сообщение role=tool', reqs[1]?.messages.at(-1)?.role === 'tool');
  check('ключ не попал в журнал', noSecrets(r, 'mk-test-good'));
}

// 4) Ошибки ключа: строка для портала + понятные слова человеку
console.log('\nОшибки ключа:');
{
  let r = await runBot({ OPENAI_API_KEY: 'sk-test-401' }, fresh('T4', [text(ask)]), answered(1));
  check('OpenAI 401 → model=fail code=bad_key', has(r, 'BOT_STATUS model=fail provider=openai code=bad_key'), r.status.join(' | '));
  check('человеку: «не принимает ключ»', /не принимает ключ/.test(W.sent[0] || ''), W.sent[0]);
  check('ключ из текста ошибки замаскирован в журнале', noSecrets(r, 'sk-test-401'));

  r = await runBot({ OPENAI_API_KEY: 'sk-test-quota' }, fresh('T5', [text(ask)]), answered(1));
  check('OpenAI 429 insufficient_quota → code=no_money', has(r, 'BOT_STATUS model=fail provider=openai code=no_money'), r.status.join(' | '));
  check('человеку: «закончились деньги», а не «лимит»', /закончились деньги/.test(W.sent[0] || ''), W.sent[0]);

  r = await runBot({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'ak-test-402' }, fresh('T6', [text(ask)]), answered(1));
  check('Claude 402 → code=no_money', has(r, 'BOT_STATUS model=fail provider=anthropic code=no_money'), r.status.join(' | '));
  check('человеку: «закончились деньги»', /закончились деньги/.test(W.sent[0] || ''), W.sent[0]);

  r = await runBot({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'ak-test-401' }, fresh('T7', []), (_w, o) => o.includes('model=fail'));
  check('Claude 401 → code=bad_key', has(r, 'BOT_STATUS model=fail provider=anthropic code=bad_key'), r.status.join(' | '));

  r = await runBot({ AI_PROVIDER: 'moonshot', MOONSHOT_API_KEY: 'mk-test-403' }, fresh('T8', [text(ask)]), answered(1));
  check('Kimi 403 (страна) → code=region', has(r, 'BOT_STATUS model=fail provider=moonshot code=region'), r.status.join(' | '));
  check('человеку: про страну сервера', /из страны/.test(W.sent[0] || ''), W.sent[0]);

  r = await runBot({ AI_PROVIDER: 'anthropic', OPENAI_API_KEY: 'sk-test-good' }, fresh('T9', [text(ask)]), answered(1));
  check('выбран Claude, а ключа Claude нет → code=no_key', has(r, 'BOT_STATUS model=fail provider=anthropic code=no_key'), r.status.join(' | '));
  check('человеку: какую строку вписать', /ANTHROPIC_API_KEY/.test(W.sent[0] || ''), W.sent[0]);
  check('голос при этом работает (ключ OpenAI есть) → voice=on', has(r, 'BOT_STATUS voice=on'));

  r = await runBot({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'ak-test-good', AGENT_MODEL: 'gpt-5' }, fresh('T10', []), (_w, o) => o.includes('model='));
  check('старая строка AGENT_MODEL=gpt-5 при Claude не мешает', has(r, 'BOT_STATUS model=ok provider=anthropic model=claude-sonnet-5-5'), r.status.join(' | '));
}

// 4б) Замечания критика 12.11.2026
console.log('\nЛимит, голос, Kimi, долгий ход:');
{
  let r = await runBot({ OPENAI_API_KEY: 'sk-test-rate' }, fresh('T12', [text(ask)]), answered(1));
  check('OpenAI 429 «лимит запросов» со ссылкой на billing → НЕ no_money', has(r, 'BOT_STATUS model=fail provider=openai code=other'), r.status.join(' | '));
  check('человеку: «лимит запросов», а не «закончились деньги»', /лимит запросов/.test(W.sent[0] || '') && !/деньги/.test(W.sent[0] || ''), W.sent[0]);

  r = await runBot({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'ak-test-good', OPENAI_API_KEY: 'sk-test-401' }, fresh('T13', [voice]), answered(1));
  check('Claude + неверный ключ OpenAI → voice=off', has(r, 'BOT_STATUS voice=off') && !has(r, 'BOT_STATUS voice=on'), r.status.join(' | '));
  check('на голосовое — по-русски: ключ OpenAI не подошёл', /OpenAI, а она не принимает ключ/.test(W.sent[0] || '') && !/Incorrect/.test(W.sent[0] || ''), W.sent[0]);
  check('причина выключения голоса — в журнале, ключа там нет', /голосовые выключены: ключ OpenAI/.test(r.out) && noSecrets(r, 'sk-test-401'));

  r = await runBot({ AI_PROVIDER: 'moonshot', MOONSHOT_API_KEY: 'mk-test-good', OPENAI_API_KEY: 'sk-test-voicequota' }, fresh('T14', [voice]), answered(1));
  check('Kimi + ключ OpenAI без денег: при запуске voice=on (список моделей отдаётся)', has(r, 'BOT_STATUS voice=on'), r.status.join(' | '));
  check('на голосовое — «у OpenAI закончились деньги», без английского', /закончились деньги/.test(W.sent[0] || '') && !/quota/i.test(W.sent[0] || ''), W.sent[0]);
  check('ошибка голоса записана в журнал', /распознавание голоса: голосовые \(OpenAI\): no_money/.test(r.out));
  const ping = W.llm.moonshot.find((b) => b.messages.length === 1);
  check('проверка Kimi при запуске — без поля предела длины', !!ping && !('max_completion_tokens' in ping) && !('max_tokens' in ping), JSON.stringify(ping));

  // Таска запускается 6 с: опрос Телеграма идёт сразу, а сообщение ждёт Таску и не теряется
  const w = fresh('T15', [text(ask)]); w.taskaFrom = Date.now() + 6000;
  r = await runBot({ OPENAI_API_KEY: 'sk-test-good' }, w, answered(1));
  const iPoll = r.out.indexOf('BOT_STATUS poll=ok'), iTaska = r.out.indexOf('Таска отвечает');
  check('poll=ok раньше, чем Таска поднялась', iPoll >= 0 && iTaska > iPoll, `poll@${iPoll} taska@${iTaska}`);
  check('сообщение, пришедшее до Таски, выполнено после её запуска', /Создал задачу/.test(W.sent[0] || '') && W.tasks.length === 1, W.sent[0]);

  // Долгий ход (ждём 2 с, модель думает 4 с): после «долго не могу» ход в фоне не доделывается
  let at = 0;
  r = await runBot({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'ak-test-slow', AGENT_TURN_TIMEOUT_S: '2' },
    fresh('T16', [text(ask), text('и ещё одну')]),
    (w2) => { if (w2.sent.length >= 2 && !at) at = Date.now(); return !!at && Date.now() - at > 5000; }, 30_000);
  check('человеку: «долго», но что успел — сказано', /Долго не могу/.test(W.sent[0] || '') && /успел: создал задачу «Позвонить клиенту»/.test(W.sent[0] || ''), W.sent[0]);
  const turns = W.llm.anthropic.filter((b) => !(b.messages.length === 1 && b.messages[0].content === 'ping'));
  const second = turns.find((b, i) => i > 0 && b.messages.at(-1)?.role === 'user' && typeof b.messages.at(-1)?.content === 'string');
  check('недоделанный ход не попал в историю следующего', !!second && second.messages.length === 1, JSON.stringify(second?.messages)?.slice(0, 200));
  check('после таймаута задачи в фоне не появляются (2 хода — 2 задачи)', W.tasks.length === 2, String(W.tasks.length));
}

// 5) Телеграм: второй экземпляр и неверный токен
console.log('\nТелеграм:');
{
  let r = await runBot({ OPENAI_API_KEY: 'sk-test-good' }, fresh('TWIN', []), (_w, o) => o.includes('poll=fail'));
  check('409 → poll=fail code=twin', has(r, 'BOT_STATUS poll=fail code=twin'), r.status.join(' | '));
  check('poll=ok при этом не написан', !r.status.some((s) => s.includes('poll=ok')));

  r = await runBot({ OPENAI_API_KEY: 'sk-test-good' }, fresh('HOOK', []), (_w, o) => o.includes('poll=ok'));
  check('409 из-за вебхука → бот выключил вебхук и работает (poll=ok)', W.unhooked === true && has(r, 'BOT_STATUS poll=ok'), r.status.join(' | '));
  check('вебхук — не «второй экземпляр»: poll=fail code=twin не написан', !has(r, 'BOT_STATUS poll=fail code=twin'));

  r = await runBot({ OPENAI_API_KEY: 'sk-test-good' }, fresh('BAD', []), () => false, 15_000);
  check('неверный токен → telegram=fail code=bad_token', has(r, 'BOT_STATUS telegram=fail code=bad_token'), r.status.join(' | '));
  check('бот завершился', r.exitCode === 1, String(r.exitCode));

  r = await runBot({ OPENAI_API_KEY: 'sk-test-good', TELEGRAM_BOT_TOKEN: '' }, fresh('', []), () => false, 15_000);
  check('токена нет → telegram=fail code=bad_token', has(r, 'BOT_STATUS telegram=fail code=bad_token'), r.status.join(' | '));
}

// 6) Строки состояния — строго по договорённости с порталом
console.log('\nФормат строк BOT_STATUS:');
{
  const r = await runBot({ AI_PROVIDER: 'kimi', MOONSHOT_API_KEY: 'mk-test-good' }, fresh('T11', []), (_w, o) => o.includes('poll='));
  const allowed = [
    /^BOT_STATUS telegram=ok bot=@\S+$/, /^BOT_STATUS telegram=fail code=bad_token$/,
    /^BOT_STATUS model=ok provider=(openai|anthropic|moonshot) model=\S+$/,
    /^BOT_STATUS model=fail provider=(openai|anthropic|moonshot) code=(bad_key|no_money|region|no_key|other)$/,
    /^BOT_STATUS voice=(on|off)$/, /^BOT_STATUS poll=ok$/, /^BOT_STATUS poll=fail code=twin$/,
  ];
  check('AI_PROVIDER=kimi понят как moonshot', has(r, 'BOT_STATUS model=ok provider=moonshot model=kimi-k3.1-pro'), r.status.join(' | '));
  check('каждая строка — одна из договорённых', r.status.length >= 4 && r.status.every((s) => allowed.some((a) => a.test(s))), r.status.join(' | '));
}

server.close();
console.log(`\nИтог: успешно ${ok}, провалов ${bad}`);
process.exit(bad ? 1 : 0);
