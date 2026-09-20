// Телеграм-агент: связка «человек в Телеграме ↔ пользователь Таски» и работа ОТ ЕГО ИМЕНИ.
//
// Как это устроено и почему так:
//  1. Агент — обычная учётка Таски (почта в AGENT_EMAIL). Он входит по паролю и получает токен,
//     как любой другой клиент. Своих прав на чужие задачи у него НЕТ.
//  2. Человек в своём профиле нажимает «Подключить телеграм» и получает шестизначный код на 10 минут.
//     Код он отправляет боту — бот меняет код на постоянную связку telegram_id ↔ user_id.
//     Пароль в переписке не звучит ни разу.
//  3. Дальше агент шлёт обычные запросы к API, добавляя заголовок X-Telegram-Id. Сервер находит
//     связку и ПОДМЕНЯЕТ токен в запросе на токен этого человека — все проверки прав ниже по коду
//     работают как для него самого. Не агент или нет связки — заголовок просто игнорируется.
import type { Express, Response, NextFunction } from 'express';
import type { Pool } from 'pg';
import crypto from 'node:crypto';
import { requireAuth, verifyToken, signToken, type AuthedRequest } from './auth.ts';

const AGENT_EMAIL = (process.env.AGENT_EMAIL || '').toLowerCase();
const CODE_TTL_MIN = 10;

function isAgentEmail(email?: string): boolean {
  return !!AGENT_EMAIL && (email || '').toLowerCase() === AGENT_EMAIL;
}

// Подмена «за кого работаем»: ставится ДО маршрутов, поэтому requireAuth ниже видит уже нужного человека.
export function agentOnBehalf(pool: Pool) {
  return async (req: AuthedRequest, res: Response, next: NextFunction): Promise<void> => {
    const tgId = String(req.headers['x-telegram-id'] || '').trim();
    if (!tgId) { next(); return; }
    const h = req.headers.authorization || '';
    const caller = h.startsWith('Bearer ') ? verifyToken(h.slice(7)) : null;
    if (!caller || !isAgentEmail(caller.email)) { next(); return; }   // заголовок от НЕ агента не значит ничего
    try {
      const r = await pool.query(
        `select u.id, u.email, u.role, u.name, u.active
           from telegram_links l join users u on u.id = l.user_id
          where l.telegram_id = $1`, [tgId]);
      const u = r.rows[0];
      if (!u || !u.active) {
        res.status(403).json({ ok: false, error: 'Этот телеграм не привязан к пользователю Таски' });
        return;
      }
      req.headers.authorization = 'Bearer ' + signToken({ id: u.id, email: u.email, role: u.role, name: u.name });
      next();
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  };
}

export function registerAgent(app: Express, pool: Pool): void {
  const fail = (res: Response, code: number, error: string) => res.status(code).json({ ok: false, error });

  // Код привязки — берёт сам человек в своём профиле
  app.post('/api/agent/code', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const code = String(crypto.randomInt(100000, 1000000));   // шесть цифр
      await pool.query('delete from telegram_codes where user_id = $1 or expires_at < now()', [req.user!.id]);
      await pool.query(
        `insert into telegram_codes(code, user_id, expires_at) values($1,$2, now() + interval '${CODE_TTL_MIN} minutes')`,
        [code, req.user!.id]);
      res.json({ ok: true, code, expires_in_min: CODE_TTL_MIN });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
  });

  // Кто привязан к моей учётке (для профиля)
  app.get('/api/agent/link', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const r = await pool.query('select telegram_id, username, created_at from telegram_links where user_id = $1', [req.user!.id]);
      res.json({ ok: true, link: r.rows[0] || null });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
  });

  // Отвязать свой телеграм
  app.delete('/api/agent/link', requireAuth, async (req: AuthedRequest, res) => {
    try {
      await pool.query('delete from telegram_links where user_id = $1', [req.user!.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
  });

  // Обмен кода на связку — это умеет только агент
  app.post('/api/agent/link', requireAuth, async (req: AuthedRequest, res) => {
    if (!isAgentEmail(req.user!.email)) return fail(res, 403, 'только агент');
    const { code, telegram_id, username } = req.body ?? {};
    if (!code || !telegram_id) return fail(res, 400, 'нужны code и telegram_id');
    try {
      const c = await pool.query('select user_id from telegram_codes where code = $1 and expires_at > now()', [String(code).trim()]);
      if (!c.rows[0]) return fail(res, 400, 'Код неверный или истёк. Возьмите новый в профиле Таски.');
      const userId = c.rows[0].user_id as string;
      await pool.query(
        `insert into telegram_links(telegram_id, user_id, username) values($1,$2,$3)
           on conflict (telegram_id) do update set user_id = excluded.user_id, username = excluded.username`,
        [String(telegram_id), userId, username ? String(username) : null]);
      await pool.query('delete from telegram_codes where code = $1', [String(code).trim()]);
      const u = await pool.query('select name from users where id = $1', [userId]);
      res.json({ ok: true, user: { id: userId, name: u.rows[0]?.name } });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
  });

  // Кто стоит за этим телеграмом — агент спрашивает перед работой
  app.get('/api/agent/resolve', requireAuth, async (req: AuthedRequest, res) => {
    if (!isAgentEmail(req.user!.email)) return fail(res, 403, 'только агент');
    const tgId = String(req.query.telegram_id || '').trim();
    if (!tgId) return fail(res, 400, 'нужен telegram_id');
    try {
      const r = await pool.query(
        `select u.id, u.name from telegram_links l join users u on u.id = l.user_id
          where l.telegram_id = $1 and u.active`, [tgId]);
      res.json({ ok: true, linked: !!r.rows[0], user: r.rows[0] || null });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
  });
}
