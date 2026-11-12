// Телеграм-бот Таски: личная переписка, long polling (вебхук и домен не нужны).
// Главное правило: человек получает ответ ВСЕГДА — даже когда Таска легла, модель молчит,
// а сообщение пришло картинкой, стикером или голосом.
import './env-clean.ts';   // первым: комментарии из старого .env не становятся значениями
import { api, API } from './taska.ts';
import { answer, Aborted, type Turn } from './agent.ts';
import {
  MODEL_READY, KEY_VAR, PROVIDER, PROVIDER_NAME, MODEL, VOICE_READY, VOICE_KEY, VOICE_WHY,
  checkModel, checkVoice, errKind, humanError, logError, voiceError, voiceLog,
} from './llm.ts';
import { attachmentKind, noTextReply, attachmentNote, voiceOffReply } from './msgkind.ts';
import { transcribeTelegramFile } from './stt.ts';
import { chunks, trimHistory, TG_LIMIT } from './parts.ts';
import { botStatus, TG_API } from './status.ts';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG = `${TG_API}/bot${TOKEN}`;
const HISTORY_TURNS = 8;           // сколько последних ходов разговора помним
// столько ждём модель, дальше — честно признаёмся. AGENT_TURN_TIMEOUT_S — только для проверок (checkproviders)
const TURN_TIMEOUT_MS = (Number(process.env.AGENT_TURN_TIMEOUT_S) || 90) * 1000;
// Первый опрос Телеграма — короткий. Портал ждёт «poll=ok», а длинный опрос (50 с) без сообщений
// вернулся бы только через 50 с. И короче нельзя: второй экземпляр бота (старый сервер с тем же токеном)
// повторяет опрос раз в несколько секунд — за 10 с он успевает перебить наш, и мы честно видим 409.
const FIRST_POLL_S = 10;

const histories = new Map<string, Turn[]>();
const queues = new Map<string, Promise<void>>();   // по одному ходу на человека: иначе история перемешается
const groupWarned = new Set<number>();

if (!TOKEN) {
  botStatus('telegram=fail', 'code=bad_token');
  console.error('TELEGRAM_BOT_TOKEN не задан. Возьмите токен у @BotFather и впишите его в .env');
  process.exit(1);
}
process.on('unhandledRejection', (e) => console.error('необработанный сбой:', e));

// Ошибка Телеграма с его кодом: 401/404 на getMe — неверный токен, 409 на getUpdates — второй экземпляр.
class TgError extends Error {
  constructor(message: string, readonly code: number) { super(message); }
}

async function tg<T = any>(method: string, body: unknown): Promise<T> {
  const r = await fetch(`${TG}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}) as any);
  if (!d.ok) throw new TgError(`Телеграм: ${d.description || r.status}`, Number(d.error_code || r.status) || 0);
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

// Функция, а не строка: голос может выключиться при запуске (ключ OpenAI не подошёл) — уже после загрузки модуля
const HELP = (): string => [
  'Я помогаю с задачами в Таске прямо здесь.',
  '',
  VOICE_READY ? 'Можно просто писать словами или надиктовать голосом:' : 'Можно просто писать словами:',
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

async function runTurn(chatId: number, tgId: string, name: string, text: string, kind: string, heard: string, note = ''): Promise<void> {
  const history = histories.get(tgId) || [];
  // Ход работает с копией истории: если он не уложился во время, его недоделанные шаги в историю не попадут.
  const work = [...history];
  const stop = new AbortController();
  const did: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saved: any[] = work;
  const typing = setInterval(() => { void tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}); }, 4500);
  void tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  const heardLine = heard ? 'Расслышал: «' + heard + '»\n\n' : '';
  let reset = false;
  try {
    const res = await Promise.race([
      answer(work, text, tgId, name, { signal: stop.signal, did }),
      new Promise<never>((_, rej) => { timer = setTimeout(() => { stop.abort(); rej(new Aborted()); }, TURN_TIMEOUT_MS); }),
    ]);
    await send(chatId, heardLine + res.reply + (kind ? attachmentNote(kind) : '') + note);
  } catch (e) {
    const msg = (e as Error).message || '';
    // Нейросеть ответила ошибкой — называем причину словами: «нет денег», «ключ не подошёл», «страна».
    // Раньше нехватка денег выдавалась за «лимит запросов, попробуйте через минуту» — и человек ждал зря.
    const kind = msg === 'ТАЙМАУТ' ? null : errKind(e);
    let human: string;
    if (msg === 'ТАЙМАУТ') {
      saved = history;              // недоделанный ход забываем; что успели — говорим, чтобы не было дублей
      human = 'Долго не могу получить ответ модели.' + (did.length
        ? ' Но успел: ' + did.join('; ') + '. Проверьте в Таске, прежде чем повторять.'
        : ' Повторите просьбу, пожалуйста.');
    }
    else if (kind === 'history' || /No tool call found|Invalid value|previous response/i.test(msg)) {
      reset = true;
      human = 'Разговор запутался, я начал его заново. Повторите последнюю просьбу.';
    } else if (kind && kind !== 'other') human = humanError(kind);
    else if (/Таска|не отвечает|прав|задачи в Таске нет/i.test(msg)) human = 'Не вышло: ' + msg + '.';
    else if (/rate limit|429|quota|billing/i.test(msg)) human = humanError('rate');
    else human = humanError('other');
    console.error('ход агента:', kind ? logError(kind, e) : msg);
    await send(chatId, heardLine + human);
  } finally {
    clearInterval(typing);
    clearTimeout(timer);
    // ⚠️ Раньше «начал заново» не срабатывало: catch удалял историю, а finally тут же клал её обратно.
    if (reset) histories.delete(tgId);
    else histories.set(tgId, trimHistory(saved, HISTORY_TURNS));   // ход мог оборваться — историю всё равно приводим в порядок
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
      await send(chatId, `Готово, ${d.user.name}. Теперь я работаю с вашими задачами.\n\n${HELP()}`);
    } catch (e) {
      await send(chatId, (e as Error).message);
    }
    return;
  }

  const name = who.user?.name || from.first_name || 'коллега';
  const cmd = rawText.toLowerCase();
  if (cmd === '/start' || cmd === '/help' || cmd === 'помощь') { await send(chatId, HELP()); return; }
  if (cmd === '/reset' || cmd === 'забудь') { histories.delete(tgId); await send(chatId, 'Разговор начат заново.'); return; }
  if (cmd.startsWith('/')) { await send(chatId, 'Такой команды у меня нет.\n\n' + HELP()); return; }

  // 3) ключа нейросети нет — понимать просьбы нечем. Говорим это ДО распознавания речи: оно платное.
  if (!MODEL_READY) {
    await send(chatId, `Связь с Таской есть, а ключ нейросети ${PROVIDER_NAME} не задан — понимать просьбы пока нечем.\n`
      + `Впишите ${KEY_VAR} в .env и перезапустите бота: docker compose --profile bot up -d --force-recreate bot`);
    return;
  }

  // 4) голос → текст (подпись, если она есть, оставляем рядом). Речь распознаёт только OpenAI.
  const voiceId = m.voice?.file_id || m.audio?.file_id || m.video_note?.file_id || null;
  let body = rawText;
  let heard = '';
  let kind = attachmentKind(m);
  let note = '';
  if (voiceId && !VOICE_READY) {
    const off = VOICE_WHY || voiceOffReply(VOICE_KEY);   // ключ OpenAI есть, но не подошёл — так и говорим
    if (!rawText) { await send(chatId, off); return; }
    kind = '';                       // подпись к записи выполним, а про саму запись скажем честно
    note = '\n\n(Саму запись я не слушал. ' + off + ')';
  } else if (voiceId) {
    void tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    try {
      heard = await transcribeTelegramFile(voiceId, TOKEN);
    } catch (e) {
      // Ошибка OpenAI (ключ, деньги, страна) — понятными словами, без английского текста и хвоста ключа.
      // Свои ошибки (запись слишком длинная, Телеграм не отдал файл) уже написаны по-русски.
      const st = typeof (e as any)?.status === 'number' || /APIConnection/.test((e as any)?.constructor?.name || '');
      const k = st ? errKind(e) : null;
      console.error('распознавание голоса:', k ? voiceLog(k, e) : (e as Error).message);
      await send(chatId, k ? voiceError(k) : 'Не смог разобрать запись: ' + (e as Error).message + '. Напишите, пожалуйста, текстом.');
      return;
    }
    if (!heard) { await send(chatId, 'В записи не разобрал слов. Скажите ещё раз или напишите текстом.'); return; }
    body = rawText ? rawText + '. ' + heard : heard;
    kind = '';                       // голосовое — это речь, а не вложение к задаче
  }

  if (!body) { await send(chatId, noTextReply(kind, VOICE_READY)); return; }   // стикер, картинка без подписи и прочее
  await runTurn(chatId, tgId, name, body, kind, heard, note);
}

// По одному ходу на человека: сообщения, пришедшие подряд, обрабатываем по очереди.
function enqueue(m: any): void {
  const tgId = String(m.from.id);
  const prev = queues.get(tgId) || Promise.resolve();
  const next = prev.then(() => taskaReady).then(() => handle(m)).catch(async (e) => {
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
      // 401 — токен отозван или чужой; 404 — в токене опечатка, и Телеграм не находит такого бота вовсе
      if ((e instanceof TgError && (e.code === 401 || e.code === 404)) || /401|unauthorized|token/i.test(msg)) {
        botStatus('telegram=fail', 'code=bad_token');
        console.error('Токен бота неверный:', msg);
        process.exit(1);
      }
      console.error(`Телеграм не отвечает (${msg}), повтор через 10 с`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  botStatus('telegram=ok', `bot=@${me.username}`);
  console.log(`бот @${me.username} слушает личные сообщения`);

  // Нейросеть проверяем сразу: ключ, деньги, страна. Не вышло — говорим, но работаем дальше
  // (привязка и команды не нужны нейросети), а на просьбы человек получит понятную причину.
  const check = await checkModel();
  if (check.ok) {
    botStatus('model=ok', `provider=${PROVIDER}`, `model=${MODEL}`);
    console.log(`нейросеть ${PROVIDER_NAME} (${MODEL}) отвечает`);
  } else {
    botStatus('model=fail', `provider=${PROVIDER}`, `code=${check.code}`);
    console.error('НЕЙРОСЕТЬ НЕ ОТВЕЧАЕТ:', check.why);
  }
  await checkVoice(check);         // ключ OpenAI для голоса: при Claude/Kimi его выше не проверяли
  botStatus(`voice=${VOICE_READY ? 'on' : 'off'}`);
  if (!VOICE_READY && !VOICE_WHY) {
    console.log(VOICE_KEY ? 'голосовые выключены (AGENT_VOICE=off)' : 'голосовые выключены: их распознаёт только OpenAI, а OPENAI_API_KEY в .env нет');
  }

  // Связь с Таской проверяем СРАЗУ, а не при первом сообщении. Иначе в журнале стоит бодрое
  // «слушает сообщения», а человек в Телеграме получает «Таска сейчас не отвечает» — и ищи причину.
  // Заодно проверяется пароль учётки агента: api() перед запросом входит в Таску.
  // ⚠️ Но с терпением: бот и api стартуют вместе, а api сперва ставит зависимости и открывает базу —
  //    первые полминуты-минуту Таски просто ещё нет. Раньше бот в этот момент писал «НЕТ СВЯЗИ»,
  //    и новичок решал, что всё сломано. Теперь ждём до двух минут; неверный пароль агента
  //    ожиданием не лечится — о нём говорим сразу.
  // ⚠️ Ждём Таску ПАРАЛЛЕЛЬНО с опросом Телеграма (замечание критика 12.11.2026): портал ждёт «poll=ok»
  //    150 с, а одно ожидание Таски — до 120 с. Сообщения, пришедшие за это время, не теряются:
  //    их обработка сама дождётся Таски (enqueue → taskaReady).
  taskaReady = waitTaska();
  await poll();
}

let taskaReady: Promise<void> = Promise.resolve();

async function waitTaska(): Promise<void> {
  let ready = false, why = '';
  for (let i = 0; i < 24 && !ready; i++) {
    try { await api('/api/health'); ready = true; }
    catch (e) {
      why = (e as Error).message;
      // ждём, пока Таска недоступна по сети или отвечает 5xx; «неверный пароль» ожиданием не лечится
      if (!/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket|timeout|: 5\d\d$|не отвечает/i.test(why)) break;
      if (i === 0) console.log(`жду Таску (${API}) — она ещё запускается…`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  if (ready) console.log(`Таска отвечает (${API}) — бот готов`);
  else {
    console.error(`НЕТ СВЯЗИ С ТАСКОЙ (${API}): ${why}`);
    console.error('Проверьте TASKA_URL в docker-compose.yml и AGENT_EMAIL/AGENT_PASSWORD в .env.');
  }
}

async function poll(): Promise<void> {
  let offset = 0;
  let first = true;
  let polled = '';                 // что последним сказали порталу про опрос: '' | 'ok' | 'twin'
  let unhooked = false;            // вебхук уже выключали
  for (;;) {
    try {
      const updates = await tg<any[]>('getUpdates', {
        offset, timeout: first ? FIRST_POLL_S : 50, allowed_updates: ['message', 'edited_message'],
      });
      first = false;
      if (polled !== 'ok') { botStatus('poll=ok'); polled = 'ok'; }
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
      // 409 — этот же токен опрашивает кто-то ещё: обычно старый сервер ученика, где бот ещё работает
      // 409 бывает и по другой причине: у бота включён вебхук (токен раньше отдавали другой программе).
      // Это не «второй экземпляр» — совет «отозвать токен» был бы неверным. Вебхук боту не нужен: выключаем.
      if (/webhook/i.test(msg)) {
        if (!unhooked) {             // выключаем один раз: не вышло — дальше просто пишем в журнал, без частых повторов
          unhooked = true;
          console.error('У бота был включён вебхук — выключаю его, иначе Телеграм не отдаёт сообщения:', msg);
          try { await tg('deleteWebhook', { drop_pending_updates: false }); continue; }
          catch (e2) { console.error('не удалось выключить вебхук:', (e2 as Error).message); }
        } else console.error('у бота снова включён вебхук — кто-то включает его другой программой:', msg);
      } else if ((e instanceof TgError && e.code === 409) || /409|terminated by other getUpdates/i.test(msg)) {
        if (polled !== 'twin') { botStatus('poll=fail', 'code=twin'); polled = 'twin'; }
        console.error('Похоже, где-то запущен второй экземпляр бота:', msg);
      } else console.error('опрос Телеграма:', msg);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
