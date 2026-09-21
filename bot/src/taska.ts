// Клиент Таски для бота. Агент входит СВОЕЙ учёткой, а действует от имени человека:
// заголовок X-Telegram-Id говорит серверу, за кого работать, и права проверяются как у него.
export const API = (process.env.TASKA_URL || 'http://api:3000').replace(/\/+$/, '');
const EMAIL = process.env.AGENT_EMAIL || 'agent@taska.local';
const PASSWORD = process.env.AGENT_PASSWORD || '';

let token = '';

async function login(): Promise<void> {
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const d = await r.json().catch(() => ({}) as Record<string, unknown>);
  if (!r.ok || !(d as { token?: string }).token) {
    throw new Error(`агент не смог войти в Таску: ${(d as { error?: string }).error || r.status}`);
  }
  token = (d as { token: string }).token;
}

export interface ApiOpts { method?: string; body?: unknown; telegramId?: string }

// Один запрос к Таске. Токен протух — один раз перевходим и повторяем.
export async function api<T = any>(path: string, opts: ApiOpts = {}, retry = true): Promise<T> {
  if (!token) await login();
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.telegramId) headers['X-Telegram-Id'] = opts.telegramId;
  const r = await fetch(`${API}${path}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (r.status === 401 && retry) { token = ''; return api<T>(path, opts, false); }
  const d = await r.json().catch(() => ({}) as Record<string, unknown>);
  if (!r.ok) {
    const msg = (d as { error?: string }).error || '';
    if (r.status === 403) throw new Error(msg === 'forbidden' ? 'в Таске на это нет прав' : msg);
    if (r.status === 404) throw new Error('такой задачи в Таске нет');
    if (r.status >= 500) throw new Error('Таска сейчас не отвечает');
    throw new Error(msg || `Таска ответила ${r.status}`);
  }
  return d as T;
}

export interface Task {
  id: string; name: string; due_date: string; due_time: string | null;
  description: string | null; archived: boolean; assignee_id: string; parent_id: string | null;
  tags?: string[];
}

// День в часовом поясе приложения, а НЕ в UTC: иначе поздним вечером бот считает «сегодня» вчерашним днём.
export const APP_TZ = process.env.APP_TZ || 'Europe/Moscow';
export const isoDay = (d: Date): string => d.toLocaleDateString('sv-SE', { timeZone: APP_TZ });
export const weekdayOf = (d: Date): string => d.toLocaleDateString('ru-RU', { timeZone: APP_TZ, weekday: 'long' });
export const dayOf = (t: Task): string => String(t.due_date || '').slice(0, 10);
