// Телеграм-бот Таски: личная переписка, long polling (вебхук и домен не нужны).
// Главное правило: человек получает ответ ВСЕГДА — даже когда Таска легла, модель молчит,
// а сообщение пришло картинкой, стикером или голосом.
import { api } from './taska.ts';
import { answer, MODEL_READY, type Turn } from './agent.ts';
import { attachmentKind, noTextReply, attachmentNote } from './msgkind.ts';
import { transcribeTelegramFile } from './stt.ts';
import { chunks, trimHistory, TG_LIMIT } from './parts.ts';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG = `https://api.telegram.org/bot${TOKEN}`;
const VOICE_ON = (process.env.AGENT_VOICE || 'on') !== 'off';
const HISTORY_TURNS = 8;           // сколько последних ходов разговора помним
const TURN_TIMEOUT_MS = 90_000;    // столько ждём модель, дальше — честно признаёмся

const histories = new Map<string, Turn[]>();
const queues = new Map<string, Promise<void>>();   // по одному ходу на человека: иначе история перемешается
const groupWarned = new Set<number>();

if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN не задан. Возьмите токен у @BotFather и впишите его в .env');
  process.exit(1);
}
process.on('unhandledRejection', (e) => console.error('необработанный сбой:', e));

async function tg<T = any>(method: string, body: unknown): Promise<T> {
  const r = await fetch(`${TG}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}) as any);
  if (!d.ok) throw new Error(`Телеграм: ${d.description || r.status}`);
  return d.result as T;
}

async function send(chatId: number | string, text: string): Promise<void> {
  const parts = chunks(String(text || '').trim() || '…');
  for (const part of parts) {
    try {
      await tg('sendMessage', { chat_id: chatId, text: part });
    } catch (e) {
      console.error('send:', (e as Error).message);
      try { await tg('sendMessage', { chat_id: chatId, text: 'Ответ не удалось отправить целиком. Спросите поуже.' }); }
      catch (e2) { console.error('send (повтор):', (e2 as Error).message); }
      return;
    }
  }
}

const HELP = [
  'Я помогаю с задачами в Таске прямо здесь.',
  '',
  'Можно просто писать словами или надиктовать голосом:',
  '• что у меня сегодня?',
  '• добавь задачу «позвонить клиенту» на завтра в 11',
  '• перенеси смету на пятницу',
  '• повесь на смету метку «Клиенты»',
  '• заверши планёрку',
  '',
  'Если запутались — напишите «забудь», и я начну разговор заново.',
].join('\n');

const LINK_HELP = [
  'Здравствуйте! Чтобы я видел ваши задачи, свяжите этот чат с вашей учётной записью в Таске.',
  '',
  'Откройте Таску → аватар справа сверху → «Мой профиль» → «Подключить телеграм».',
  'Там появится код из шести цифр — пришлите его мне сюда.',
].join('\n');

async function runTurn(chatId: number, tgId: string, name: string, text: string, kind: string, heard: string): Promise<void> {
  const history = histories.get(tgId) || [];
  const typing = setInterval(() => { void tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}); }, 4500);
  void tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  const heardLine = heard ? 'Расслышал: «' + heard + '»\n\n' : '';
  try {
    const res = await Promise.race([
      answer(history, text, tgId, name),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('ТАЙМАУТ')), TURN_TIMEOUT_MS)),
    ]);
    await send(chatId, heardLine + res.reply + (kind ? attachmentNote(kind) : ''));
  } catch (e) {
    const msg = (e as Error).message || '';
    const done = (history as any[]).length ? '' : '';
    let human: string;
    if (msg === 'ТАЙМАУТ') human = 'Долго не могу получить ответ модели. Повторите просьбу, пожалуйста.';
    else if (/No tool call found|Invalid value|previous response/i.test(msg)) {
      histories.delete(tgId);
      human = 'Разговор запутался, я начал его заново. Повторите последнюю просьбу.';
    } else if (/Таска|не отвечает|прав|задачи в Таске нет/i.test(msg)) human = 'Не вышло: ' + msg + '.';
    else if (/rate limit|429|quota|billing/i.test(msg)) human = 'Модель сейчас не отвечает (лимит запросов). Попробуйте через минуту.';
    else human = 'Что-то сломалось на моей стороне. Попробуйте ещё раз, а если повторится — скажите владельцу.';
    console.error('ход агента:', msg, done);
    await send(chatId, heardLine + human);
  } finally {
    clearInterval(typing);
    histories.set(tgId, trimHistory(history, HISTORY_TURNS));   // ход мог оборваться — историю всё равно приводим в порядок
  }
}

async function handle(m: any): Promise<void> {
  const chatId = m.chat.id;
  const from = m.from;
  const tgId = String(from.id);

  // 1) кто это. Таска недоступна — молчать нельзя
  let who: { linked: boolean; user: { name: string } | null };
  try {
    who = await api(`/api/agent/resolve?telegram_id=${encodeURIComponent(tgId)}`);
  } catch (e) {
    console.error('resolve:', (e as Error).message);
    await send(chatId, 'Таска сейчас не отвечает — попробуйте через минуту.');
    return;
  }

  const rawText = String(m.text || m.caption || '').trim();

  // 2) не привязан: ждём шесть цифр. Распознавание речи до привязки не запускаем — это чужие деньги
  if (!who.linked) {
    const code = rawText.match(/\b(\d{6})\b/)?.[1];
    if (!code) {
      const hint = /\d/.test(rawText) ? '\n\nЕсли это был код — пришлите ровно шесть цифр из профиля.' : '';
      await send(chatId, LINK_HELP + hint);
      return;
    }
    try {
      const d = await api<{ user: { name: string } }>('/api/agent/link', {
        method: 'POST', body: { code, telegram_id: tgId, username: from.username || null },
      });
      histories.delete(tgId);
      await send(chatId, `Готово, ${d.user.name}. Теперь я работаю с вашими задачами.\n\n${HELP}`);
    } catch (e) {
      await send(chatId, (e as Error).message);
    }
    return;
  }

  const name = who.user?.name || from.first_name || 'коллега';
  const cmd = rawText.toLowerCase();
  if (cmd === '/start' || cmd === '/help' || cmd === 'помощь') { await send(chatId, HELP); return; }
  if (cmd === '/reset' || cmd === 'забудь') { histories.delete(tgId); await send(chatId, 'Разговор начат заново.'); return; }
  if (cmd.startsWith('/')) { await send(chatId, 'Такой команды у меня нет.\n\n' + HELP); return; }

  // 3) голос → текст (подпись, если она есть, оставляем рядом)
  const voiceId = VOICE_ON ? (m.voice?.file_id || m.audio?.file_id || m.video_note?.file_id) : null;
  let body = rawText;
  let heard = '';
  let kind = attachmentKind(m);
  if (voiceId) {
    void tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    try {
      heard = await transcribeTelegramFile(voiceId, TOKEN);
    } catch (e) {
      await send(chatId, 'Не смог разобрать запись: ' + (e as Error).message + '. Напишите, пожалуйста, текстом.');
      return;
    }
    if (!heard) { await send(chatId, 'В записи не разобрал слов. Скажите ещё раз или напишите текстом.'); return; }
    body = rawText ? rawText + '. ' + heard : heard;
    kind = '';                       // голосовое — это речь, а не вложение к задаче
  }

  if (!MODEL_READY) {
    await send(chatId, 'Связь с Таской есть, а ключ модели не задан — понимать просьбы пока нечем.\n'
      + 'Впишите OPENAI_API_KEY в .env и перезапустите бота: docker compose --profile bot up -d --force-recreate bot');
    return;
  }
  if (!body) { await send(chatId, noTextReply(kind)); return; }   // стикер, картинка без подписи и прочее
  await runTurn(chatId, tgId, name, body, kind, heard);
}

// По одному ходу на человека: сообщения, пришедшие подряд, обрабатываем по очереди.
function enqueue(m: any): void {
  const tgId = String(m.from.id);
  const prev = queues.get(tgId) || Promise.resolve();
  const next = prev.then(() => handle(m)).catch(async (e) => {
    console.error('обработка:', (e as Error).message);
    try { await send(m.chat.id, 'Что-то сломалось на моей стороне. Повторите, пожалуйста.'); } catch { /* уже не помочь */ }
  });
  queues.set(tgId, next);
  void next.finally(() => { if (queues.get(tgId) === next) queues.delete(tgId); });
}

async function main(): Promise<void> {
  // Телеграм может не ответить с первого раза — это не повод падать в вечный перезапуск контейнера.
  let me: { username: string } | null = null;
  for (let i = 0; !me; i++) {
    try { me = await tg<{ username: string }>('getMe', {}); }
    catch (e) {
      const msg = (e as Error).message;
      if (/401|unauthorized|token/i.test(msg)) { console.error('Токен бота неверный:', msg); process.exit(1); }
      console.error(`Телеграм не отвечает (${msg}), повтор через 10 с`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  console.log(`бот @${me.username} слушает личные сообщения`);

  let offset = 0;
  for (;;) {
    try {
      const updates = await tg<any[]>('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'edited_message'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        const m = u.message || u.edited_message;
        if (!m || !m.from) continue;
        if (m.chat?.type !== 'private') {            // в группах не работаем, но сказать об этом надо один раз
          // Исключение — команда /id: бот называет id группы. Это нужно, когда тем же ботом
          // рассылают сообщения в группу (например, ведущий занятия): id иначе взять неоткуда,
          // а второй getUpdates с того же токена Телеграм не пускает.
          if (/^\/id(@\w+)?$/.test(String(m.text || '').trim())) { void send(m.chat.id, `id этой группы: ${m.chat.id}`); continue; }
          if (!groupWarned.has(m.chat.id)) {
            groupWarned.add(m.chat.id);
            void send(m.chat.id, 'В группах я не работаю — напишите мне в личку. Команда /id здесь покажет id группы.');
          }
          continue;
        }
        enqueue(m);
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (/409|terminated by other getUpdates/i.test(msg)) console.error('Похоже, где-то запущен второй экземпляр бота:', msg);
      else console.error('опрос Телеграма:', msg);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
