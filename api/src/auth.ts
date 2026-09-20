import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';

// --- Пароли: scrypt (встроен в Node, без нативных сборок) ---
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Пароль «как ввели» и, если не подошёл, — без хвостовых пробелов: мобильные клавиатуры и вставка
// из заметок дописывают пробел/перевод строки, человек этого не видит и получает «неверный пароль».
// Пробелы ВНУТРИ пароля не трогаем — только края.
export function verifyPasswordForgiving(password: string, stored: string | null): boolean {
  if (verifyPassword(password, stored)) return true;
  const t = String(password ?? '').trim();
  return t !== password && t.length > 0 ? verifyPassword(t, stored) : false;
}

// Свёртка логина к «на слух»: русские фамилии латиницей пишут по-разному, и человек не обязан помнить,
// какой вариант ему выдали: человек набирает ivanoff, хотя в базе ivanov — и каждый раз читает
// «неверный пароль». Свёрнутые формы совпадают → пускаем, НО только если
// форма указывает ровно на одного человека; пароль при этом проверяется как обычно, никаких послаблений.
export function loginFingerprint(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/kh/g, 'h').replace(/ph/g, 'f').replace(/ck/g, 'k')
    .replace(/[yj]/g, 'i')
    .replace(/(.)\1+/g, '$1');
}

// Логин, введённый человеком: убираем края, невидимые символы (их дарит вставка из мессенджеров)
// и регистр (мобильная клавиатура пишет первую букву заглавной).
export function normalizeLogin(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\u200b-\u200f\u00a0\u2060\ufeff]/g, '')
    .trim()
    .toLowerCase();
}

// --- JWT ---
// Ключ подписи сессий берём ТОЛЬКО из окружения. Запасного значения в коде быть не должно:
// с ключом из исходников токен подделает любой, кто видел репозиторий, — а репозиторий уезжает ученикам.
const SECRET = process.env.JWT_SECRET || '';
if (!SECRET) {
  console.error('JWT_SECRET не задан. Откройте .env и впишите длинную случайную строку, например: openssl rand -hex 32');
  process.exit(1);
}
export interface JwtUser {
  id: string;
  email: string;
  role: string;
  name: string;
}
// Срок жизни сессии. Было 7 дней БЕЗ продления — ровно через неделю приложение молча выкидывало
// всех до единого (и телефон, и десктоп), человек читал это как «сломался пароль».
// Теперь 90 дней + продление на каждом запуске приложения (/api/auth/me отдаёт свежий токен).
export const TOKEN_DAYS = 90;
export function signToken(u: JwtUser): string {
  return jwt.sign(u, SECRET, { expiresIn: `${TOKEN_DAYS}d` });
}

// Резервная копия сессии в HttpOnly-куке. Нужна из-за мобильных браузеров: iOS Safari чистит
// localStorage у сайтов, куда не заходили ~7 дней, и токен исчезает вместе с ним — человек видит
// экран входа «на ровном месте». Кука переживает эту чистку и принимается ТОЛЬКО эндпоинтом
// восстановления /api/auth/me (все остальные — строго по заголовку Authorization), поэтому
// подделать межсайтовый запрос ею нельзя; плюс SameSite=Lax не пускает её в кросс-сайт запросы.
export const SESSION_COOKIE = 'taska_session';
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${TOKEN_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
}
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
export function readCookie(header: string | undefined, name: string): string {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
export function verifyToken(token: string): JwtUser | null {
  try {
    return jwt.verify(token, SECRET) as JwtUser;
  } catch {
    return null;
  }
}

// --- Middleware ---
export interface AuthedRequest extends Request {
  user?: JwtUser;
}
export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const u = token ? verifyToken(token) : null;
  if (!u) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }
  req.user = u;
  next();
}
export function requireRole(...roles: string[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ ok: false, error: 'forbidden' });
      return;
    }
    next();
  };
}
