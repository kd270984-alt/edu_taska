// Слой нейросетей: один и тот же агент говорит с OpenAI, Claude (Anthropic) или Kimi (Moonshot).
// Решение владельца 11.11.2026: боту подходит ключ OpenAI, Claude или Kimi. Голосовые распознаёт только
// OpenAI, поэтому они работают, лишь когда в .env есть OPENAI_API_KEY — при любой нейросети для текста.
//
// Договорённость с порталом academy (менять только вместе с ним):
//   AI_PROVIDER = openai | anthropic | moonshot   (строки нет — openai, как было раньше)
//   OPENAI_API_KEY / ANTHROPIC_API_KEY / MOONSHOT_API_KEY — ключ выбранной нейросети
//   AGENT_MODEL — необязательная замена модели
//
// История разговора у каждой нейросети своя по форме (элементы Responses API у OpenAI, сообщения
// Messages API у Claude, сообщения chat completions у Kimi). Нейросеть выбирается один раз при запуске,
// поэтому в одной истории формы не смешиваются.
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { isoDay, weekdayOf } from './taska.ts';

export type Provider = 'openai' | 'anthropic' | 'moonshot';

const ALIASES: Record<string, Provider> = {
  openai: 'openai', anthropic: 'anthropic', claude: 'anthropic', moonshot: 'moonshot', kimi: 'moonshot',
};
const asked = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
export const PROVIDER: Provider = ALIASES[asked] || 'openai';
if (asked && !ALIASES[asked]) {
  console.error(`AI_PROVIDER=${asked} — такой нейросети бот не знает, беру openai. Можно: openai, anthropic, moonshot.`);
}

const NAMES: Record<Provider, string> = { openai: 'OpenAI', anthropic: 'Claude', moonshot: 'Kimi' };
const KEY_VARS: Record<Provider, string> = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', moonshot: 'MOONSHOT_API_KEY' };
const CABINETS: Record<Provider, string> = { openai: 'platform.openai.com', anthropic: 'platform.claude.com', moonshot: 'platform.kimi.ai' };
export const PROVIDER_NAME = NAMES[PROVIDER];
export const KEY_VAR = KEY_VARS[PROVIDER];
const KEY = String(process.env[KEY_VAR] || '').trim();
export const MODEL_READY = !!KEY;   // без ключа модели агент молчит, но привязка и команды работают

const DEFAULT_MODEL: Record<Provider, string> = {
  openai: 'gpt-5',                  // как было до 11.11.2026
  anthropic: 'claude-sonnet-5-5',   // решение владельца 11.11.2026: вдвое дешевле Opus, для бота задач хватает
  moonshot: 'kimi-k3.1-pro',        // флагман Kimi; серию K2 новым аккаунтам не дают с 31.10.2026
};
const FAMILY: Record<Provider, RegExp> = { openai: /^(gpt|chatgpt|o\d)/i, anthropic: /^claude/i, moonshot: /^(kimi|moonshot)/i };

// ⚠️ В старых .env стоит AGENT_MODEL=gpt-5 (так было в примере). Ученик переключился на Claude —
//    строка осталась, и бот просил бы у Anthropic модель OpenAI. Чужую модель не берём.
function pickModel(): string {
  const want = String(process.env.AGENT_MODEL || '').trim();
  const def = DEFAULT_MODEL[PROVIDER];
  if (!want) return def;
  const foreign = (Object.keys(FAMILY) as Provider[]).some((p) => p !== PROVIDER && FAMILY[p].test(want));
  if (foreign) {
    console.error(`AGENT_MODEL=${want} — это модель другой нейросети, а выбрана ${PROVIDER_NAME}. Беру ${def}.`);
    return def;
  }
  return want;
}
export const MODEL = pickModel();

// Глубина «размышлений» для Claude и Kimi. Низкая: бот отвечает в Телеграме, ждать минуту человек не будет.
// AGENT_EFFORT — необязательная настройка для продвинутых. У OpenAI ничего не меняем — там всё как было.
const EFFORTS: Record<Provider, string[]> = { openai: [], anthropic: ['low', 'medium', 'high', 'xhigh', 'max'], moonshot: ['low', 'high', 'max'] };
const EFFORT = (() => {
  const want = String(process.env.AGENT_EFFORT || '').trim().toLowerCase();
  if (want && PROVIDER !== 'openai' && !EFFORTS[PROVIDER].includes(want)) {
    console.error(`AGENT_EFFORT=${want} — у ${PROVIDER_NAME} так нельзя (${EFFORTS[PROVIDER].join(', ')}). Беру low.`);
    return 'low';
  }
  return want || 'low';
})();
// effort понимают Claude 4.6 и новее (и Opus 4.5); у старых моделей это ошибка 400
const CLAUDE_EFFORT = /^claude-(opus|sonnet|haiku|fable|mythos)-[5-9]|^claude-(opus|sonnet)-4-[5-9]/i.test(MODEL);
// reasoning_effort есть только у K3; у K2 вместо него другой параметр
const KIMI_EFFORT = /^kimi-k3/i.test(MODEL);

// Голос → текст. Только ключом OpenAI (у Claude и Kimi распознавания речи нет).
export const VOICE_SWITCH = (process.env.AGENT_VOICE || 'on') !== 'off';
export const VOICE_KEY = !!String(process.env.OPENAI_API_KEY || '').trim();
export const VOICE_READY = VOICE_SWITCH && VOICE_KEY;

// Адрес Kimi. MOONSHOT_BASE_URL — только для проверок с поддельным сервером (и для площадки .cn).
const MOONSHOT_URL = (process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.ai/v1').replace(/\/+$/, '');

export const datePrefix = (now: Date): string => `[Сегодня ${isoDay(now)}, ${weekdayOf(now)}] `;

// ---------------------------------------------------------------------------------------------
// Ошибки нейросети → понятные слова

export type ErrKind = 'bad_key' | 'no_money' | 'region' | 'model' | 'rate' | 'down' | 'history' | 'other';

export function errKind(e: unknown): ErrKind {
  const x = e as any;
  const status = typeof x?.status === 'number' ? x.status : 0;
  // Anthropic кладёт в .error всё тело {type:'error', error:{type,message}}; OpenAI и Kimi — сразу {type,code,message}
  const inner = x?.error?.error ?? x?.error ?? {};
  const words = [x?.code, x?.type, inner?.type, inner?.code, inner?.message, x?.message].filter(Boolean).join(' ');
  if (!status) {
    if (x instanceof OpenAI.APIConnectionError || x instanceof Anthropic.APIConnectionError) return 'down';
    return /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket|timed? ?out/i.test(words) ? 'down' : 'other';
  }
  // нет денег: OpenAI — 429 insufficient_quota, Anthropic — 402 или 400 «credit balance is too low»,
  // Kimi — 429 exceeded_current_quota_error. Проверяем раньше 429: иначе это выглядело бы как «лимит запросов»
  if (status === 402 || /insufficient_quota|exceeded_current_quota|billing|credit balance|balance is insufficient|quota is insufficient/i.test(words)) return 'no_money';
  if (status === 401) return 'bad_key';
  if (status === 403) return /country|region|territor|location|not allowed|not supported/i.test(words) ? 'region' : 'other';
  if (status === 404) return 'model';
  if (status === 429) return 'rate';
  if (status >= 500) return 'down';
  // остальные 400 — почти всегда испорченная история разговора: тот же запрос упадёт снова, её надо начать заново
  if (status === 400) return 'history';
  return 'other';
}

// Для строки BOT_STATUS: портал понимает только эти коды
export const statusCode = (k: ErrKind): string => (k === 'bad_key' || k === 'no_money' || k === 'region' ? k : 'other');

// Что сказать человеку в Телеграме
export function humanError(k: ErrKind): string {
  switch (k) {
    case 'bad_key': return `Нейросеть ${PROVIDER_NAME} не принимает ключ. Его нужно проверить: строка ${KEY_VAR} в настройках бота.`;
    case 'no_money': return `На счёте нейросети ${PROVIDER_NAME} закончились деньги. Пополните баланс в кабинете ${CABINETS[PROVIDER]} и повторите просьбу.`;
    case 'region': return `Нейросеть ${PROVIDER_NAME} не принимает запросы из страны, где стоит сервер бота.`;
    case 'model': return `Нейросеть ${PROVIDER_NAME} не знает модель ${MODEL}. Проверьте строку AGENT_MODEL в настройках бота.`;
    case 'rate': return 'Модель сейчас не отвечает (лимит запросов). Попробуйте через минуту.';
    case 'down': return `Нейросеть ${PROVIDER_NAME} сейчас не отвечает. Попробуйте через минуту.`;
    default: return 'Что-то сломалось на моей стороне. Попробуйте ещё раз, а если повторится — скажите владельцу.';
  }
}

// Что написать в журнал. Ключи в тексте ошибки маскируем: OpenAI, например, повторяет хвост ключа.
export function logError(k: ErrKind, e: unknown): string {
  const what: Record<ErrKind, string> = {
    bad_key: `ключ не подошёл (${KEY_VAR})`, no_money: 'на счёте нет денег', region: 'не пускает из страны сервера',
    model: `нет модели ${MODEL}`, rate: 'лимит запросов', down: 'не отвечает', history: 'не приняла историю разговора', other: 'ошибка',
  };
  const raw = String((e as Error)?.message || e || '').replace(/(sk|key)[-_][\w*.\-]{4,}/gi, '***').slice(0, 300);
  return `нейросеть ${PROVIDER_NAME} (${MODEL}): ${what[k]} — ${raw}`;
}

// ---------------------------------------------------------------------------------------------
// Одна крошечная проверка при запуске: ключ, деньги, страна. Стоит доли цента.
// ⚠️ При неудаче бот НЕ завершается: restart: always гонял бы его по кругу — и каждый круг заново
//    ставил бы зависимости и снова платно стучался в нейросеть. Привязка и команды работают и так.

export type CheckResult = { ok: true } | { ok: false; code: string; why: string };

export async function checkModel(): Promise<CheckResult> {
  if (!MODEL_READY) return { ok: false, code: 'no_key', why: `ключ не задан — впишите ${KEY_VAR} в .env` };
  try {
    if (PROVIDER === 'anthropic') {
      await new Anthropic({ apiKey: KEY, maxRetries: 0, timeout: 30_000 }).messages.create({
        model: MODEL, max_tokens: 32, messages: [{ role: 'user', content: 'ping' }],
        ...(CLAUDE_EFFORT ? { output_config: { effort: 'low' as const } } : {}),
      });
    } else if (PROVIDER === 'moonshot') {
      await moonshotClient(30_000, 0).chat.completions.create({
        model: MODEL, messages: [{ role: 'user', content: 'ping' }], max_completion_tokens: 32,
        ...(KIMI_EFFORT ? { reasoning_effort: 'low' } : {}),
      } as any);
    } else {
      await new OpenAI({ maxRetries: 0, timeout: 30_000 }).responses.create({
        model: MODEL, input: 'ping', max_output_tokens: 16, store: false,
      });
    }
    return { ok: true };
  } catch (e) {
    const k = errKind(e);
    return { ok: false, code: statusCode(k), why: logError(k, e) };
  }
}

// ---------------------------------------------------------------------------------------------
// «Мотор» нейросети: агент ведёт петлю сам, мотор лишь делает один шаг и складывает его в историю.

export interface FnTool { type: 'function'; name: string; description: string; parameters: Record<string, unknown> }
export interface Call { id: string; name: string; args: string }           // args — JSON-строка
export interface Step { text: string; calls: Call[]; incomplete: boolean; trace: string }
export interface ToolOut { call: Call; output: string }

export interface Engine {
  search: boolean;                                                // есть ли сейчас поиск в интернете
  prepare(): Promise<void>;                                       // перед ходом (Kimi: узнать, есть ли поиск)
  begin(history: any[], userText: string, now: Date): void;       // сообщение человека → в историю
  step(history: any[], instructions: string, tools: FnTool[]): Promise<Step>;
  results(history: any[], outs: ToolOut[]): void;                 // результаты наших инструментов → в историю
  own(call: Call): Promise<string | null>;                        // инструмент самой нейросети (не наш) — или null
}

const failed = (output: string) => output.startsWith('ошибка:');

// ---- OpenAI: Responses API, ровно как было до 11.11.2026 ----
function openaiEngine(): Engine {
  let c: OpenAI | null = null;
  const client = (): OpenAI => (c ||= new OpenAI());   // лениво: без ключа модуль не должен падать при загрузке
  return {
    search: true,
    async prepare() { /* поиск у OpenAI есть всегда */ },
    begin(h, text) { h.push({ role: 'user', content: text }); },
    async step(h, instructions, tools) {
      const res: any = await client().responses.create({
        model: MODEL,
        instructions,
        input: h as any,
        tools: [...tools, { type: 'web_search' }] as any,   // плюс поиск в интернете, когда вопрос не про задачи
        store: false,                                       // переписку держим у себя, на стороне модели не храним
      });
      const out: any[] = res.output || [];
      h.push(...out);                                       // ответ модели целиком — он же контекст следующего шага
      return {
        text: String(res.output_text || '').trim(),         // текст ТОЛЬКО этого шага: старое обещание — не ответ
        calls: out.filter((o) => o?.type === 'function_call').map((o) => ({ id: o.call_id, name: o.name, args: o.arguments || '' })),
        incomplete: String(res.status || '') === 'incomplete',
        trace: out.map((o) => o?.type + (o?.name ? ':' + o.name : '')).join(', ')
          + ' | статус: ' + res.status + ' | причина: ' + JSON.stringify(res.incomplete_details || null),
      };
    },
    results(h, outs) {
      for (const o of outs) h.push({ type: 'function_call_output', call_id: o.call.id, output: o.output });
    },
    async own() { return null; },
  };
}

// ---- Claude: родной Messages API ----

// Базовый поиск, без «динамической фильтрации»: та запускает выполнение кода на стороне Anthropic
// и приносит в историю блоки и контейнеры, которые боту задач не нужны. Поиск у Anthropic включён
// по умолчанию; если администратор организации его выключил — запрос с ним даёт 400, и бот работает без поиска.
const CLAUDE_SEARCH = { type: 'web_search_20250305' as const, name: 'web_search' as const, max_uses: 3 };
const REFUSAL = 'С этой просьбой я помочь не могу. Давайте про задачи.';

// Между ходами человека из ответов Claude оставляем только текст и вызовы наших инструментов.
// ⚠️ Почему (замечание критика 11.11.2026): блоки «размышлений» привязаны к разговору. У новых аккаунтов
//    Anthropic (с 31.08.2026, то есть у всех учеников) любая правка истории — обрезка начала (trimHistory),
//    другой system — вместе со старыми размышлениями даёт 400. Убрать их все разрешено, и тогда правки
//    ничего не ломают. Заодно уходят результаты поиска: нести их в каждый следующий запрос дорого.
//    Внутри одного хода (цепочка вызовов инструментов) размышления остаются — без них нельзя.
export function tidyClaude(h: any[]): any[] {
  const msgs: any[] = h.map((m) => {
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) return m;
    const content = m.content.flatMap((b: any) =>
      b?.type === 'text' && String(b.text || '').trim() ? [{ type: 'text', text: b.text }]
        : b?.type === 'tool_use' ? [{ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} }]
          : []);
    return { role: 'assistant', content };
  });
  // Пара «вызов ↔ результат» должна быть целой: вызов без результата (ход оборвался по таймауту)
  // или результат без вызова Anthropic не примет. Половинки выбрасываем.
  const isResults = (m: any) => m?.role === 'user' && Array.isArray(m.content);
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m?.role === 'assistant' && Array.isArray(m.content)) {
      const next = msgs[i + 1];
      const answered = new Set(isResults(next) ? next.content.filter((b: any) => b?.type === 'tool_result').map((b: any) => b.tool_use_id) : []);
      m.content = m.content.filter((b: any) => b.type !== 'tool_use' || answered.has(b.id));
      const asked = new Set(m.content.filter((b: any) => b.type === 'tool_use').map((b: any) => b.id));
      if (isResults(next)) next.content = next.content.filter((b: any) => b?.type !== 'tool_result' || asked.has(b.tool_use_id));
    } else if (isResults(m) && !(msgs[i - 1]?.role === 'assistant')) {
      m.content = m.content.filter((b: any) => b?.type !== 'tool_result');   // результаты без вызова перед ними
    }
  }
  return msgs.filter((m) => !(Array.isArray(m?.content) && !m.content.length));
}

// Аварийный ремонт: Anthropic всё же не принял размышления — убираем их из всей истории (это разрешено).
export function stripThinking(h: any[]): boolean {
  let changed = false;
  for (const m of h) {
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const kept = m.content.filter((b: any) => b?.type !== 'thinking' && b?.type !== 'redacted_thinking');
    if (kept.length !== m.content.length) { m.content = kept; changed = true; }
  }
  if (changed) h.splice(0, h.length, ...h.filter((m) => !(Array.isArray(m?.content) && !m.content.length)));
  return changed;
}

function anthropicEngine(): Engine {
  let c: Anthropic | null = null;
  const client = (): Anthropic => (c ||= new Anthropic({ apiKey: KEY, timeout: 80_000 }));
  const eng: Engine = {
    search: true,
    async prepare() { /* поиск узнаём по первому ответу */ },
    // ⚠️ Дату НЕ пишем в system: он меняется в полночь посреди разговора. Дата едет в сообщении человека.
    begin(h, text, now) {
      h.splice(0, h.length, ...tidyClaude(h));
      h.push({ role: 'user', content: datePrefix(now) + text });
    },
    async step(h, system, tools) {
      const fn = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as any }));
      const ask = (withSearch: boolean) => client().messages.create({
        model: MODEL,
        max_tokens: 16000,
        system,
        messages: h,
        tools: withSearch ? [...fn, CLAUDE_SEARCH] : fn,
        cache_control: { type: 'ephemeral' },               // system и инструменты одинаковы — берём из кеша, дешевле
        ...(CLAUDE_EFFORT ? { output_config: { effort: EFFORT as any } } : {}),
      });
      const send = async (): Promise<Anthropic.Message> => {
        try {
          return await ask(eng.search);
        } catch (e) {
          if (!(e instanceof Anthropic.BadRequestError)) throw e;
          const msg = String(e.message || '');
          if (eng.search && /web.?search/i.test(msg)) {
            const res = await ask(false);                   // и без поиска не вышло — наверх уйдёт уже эта ошибка
            eng.search = false;
            console.error('Поиск в интернете у Claude выключен в настройках организации — работаю без него.');
            return res;
          }
          if (/signature|different conversation/i.test(msg) && stripThinking(h)) {
            console.error('Claude не принял старые размышления в истории — убрал их и повторил запрос.');
            return await ask(eng.search);
          }
          throw e;
        }
      };
      const texts: string[] = [];
      const calls: Call[] = [];
      const trace: string[] = [];
      let incomplete = false;
      // pause_turn: Anthropic прервал долгий поиск — отправляем ответ обратно как есть, он продолжит
      for (let i = 0; i < 4; i++) {
        const res = await send();
        trace.push(res.content.map((b) => b.type + ((b as any).name ? ':' + (b as any).name : '')).join(', ') + ' | ' + res.stop_reason);
        if (res.stop_reason === 'refusal') {
          h.push({ role: 'assistant', content: [{ type: 'text', text: REFUSAL }] });
          return { text: REFUSAL, calls: [], incomplete: false, trace: trace.join(' / ') };
        }
        if (res.content.length) h.push({ role: 'assistant', content: res.content });
        for (const b of res.content) {
          if (b.type === 'text') texts.push(b.text);
          if (b.type === 'tool_use') calls.push({ id: b.id, name: b.name, args: JSON.stringify(b.input ?? {}) });
        }
        if (res.stop_reason === 'max_tokens') incomplete = true;
        if (res.stop_reason !== 'pause_turn') break;
        if (i === 3) incomplete = true;
      }
      return { text: texts.join('').trim(), calls, incomplete, trace: trace.join(' / ') };
    },
    results(h, outs) {
      // все результаты — одним сообщением: так Claude и дальше вызывает инструменты параллельно
      h.push({
        role: 'user',
        content: outs.map((o) => ({ type: 'tool_result', tool_use_id: o.call.id, content: o.output, ...(failed(o.output) ? { is_error: true } : {}) })),
      });
    },
    async own() { return null; },
  };
  return eng;
}

// ---- Kimi: chat completions, совместимый с OpenAI ----

function moonshotClient(timeout = 80_000, maxRetries = 2): OpenAI {
  // organization/project — null: иначе SDK подхватил бы OPENAI_ORG_ID из окружения и отправил его в Kimi
  return new OpenAI({ apiKey: KEY, baseURL: MOONSHOT_URL, organization: null, project: null, timeout, maxRetries });
}

// Поиск в интернете у Kimi — их «официальный инструмент» (Formula): объявление берём у Kimi,
// вызов исполняем тоже у Kimi, результат кладём в историю как есть. Оплата — за каждый поиск.
// Недоступен — бот работает без поиска, задачи от этого не страдают.
const KIMI_SEARCH = '/formulas/moonshot/web-search:latest';

// Ход оборвался по таймауту посреди вызова инструментов — в истории остался вызов без результата.
// Kimi такую историю не примет (400), и разговор пришлось бы начинать заново. Выбрасываем недоделанный
// вызов вместе с его частичными результатами; остальные сообщения — как есть, с reasoning_content.
export function tidyKimi(h: any[]): any[] {
  const out: any[] = [];
  for (let i = 0; i < h.length; i++) {
    const m = h[i];
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      let j = i + 1;
      const answered = new Set<string>();
      while (j < h.length && h[j]?.role === 'tool') answered.add(h[j++].tool_call_id);
      if (m.tool_calls.every((t: any) => answered.has(t.id))) out.push(...h.slice(i, j));
      i = j - 1;
      continue;
    }
    if (m?.role === 'tool') continue;   // результат без вызова перед ним
    out.push(m);
  }
  return out;
}

function moonshotEngine(): Engine {
  let c: OpenAI | null = null;
  const client = (): OpenAI => (c ||= moonshotClient());
  let searchTools: any[] | null = null;       // null — ещё не спрашивали
  let retryAt = 0;
  const names = (): Set<string> => new Set((searchTools || []).map((t) => t?.function?.name).filter(Boolean));
  const eng: Engine = {
    search: false,
    async prepare() {
      if (searchTools !== null && (searchTools.length || Date.now() < retryAt)) return;
      try {
        const d: any = await client().get(`${KIMI_SEARCH}/tools`, { timeout: 15_000, maxRetries: 0 });
        searchTools = (d?.tools || []).filter((t: any) => t?.type === 'function' && t?.function?.name);
      } catch (e) {
        searchTools = [];
        console.error('Поиск в интернете у Kimi сейчас недоступен — работаю без него:', logError(errKind(e), e));
      }
      if (!searchTools?.length) retryAt = Date.now() + 10 * 60_000;   // спросим снова через 10 минут
      eng.search = !!searchTools?.length;
    },
    // ⚠️ Дата — в сообщении человека, а system постоянный: у K3 «размышления» сохраняются между ходами.
    begin(h, text, now) {
      h.splice(0, h.length, ...tidyKimi(h));
      h.push({ role: 'user', content: datePrefix(now) + text });
    },
    async step(h, system, tools) {
      const fn = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      const ask = (extra: any[]) => client().chat.completions.create({
        model: MODEL,
        messages: [{ role: 'system', content: system }, ...h],
        tools: [...fn, ...extra],
        ...(KIMI_EFFORT ? { reasoning_effort: EFFORT } : {}),   // по умолчанию у Kimi max — медленно и дорого
      } as any) as Promise<any>;
      let res: any;
      try {
        res = await ask(eng.search ? searchTools! : []);
      } catch (e) {
        if (!(eng.search && (e as any)?.status === 400)) throw e;
        res = await ask([]);                                   // поиск сломал запрос — без него
        searchTools = []; retryAt = Date.now() + 10 * 60_000; eng.search = false;
        console.error('Kimi не принял инструмент поиска — работаю без него:', logError(errKind(e), e));
      }
      const choice = res?.choices?.[0];
      const msg = choice?.message || { role: 'assistant', content: '' };
      h.push(msg);                                             // сообщение целиком, вместе с reasoning_content — так велит Kimi
      return {
        text: String(msg.content || '').trim(),
        calls: (msg.tool_calls || []).map((t: any) => ({ id: t.id, name: t.function?.name, args: t.function?.arguments || '' })),
        incomplete: choice?.finish_reason === 'length',
        trace: (msg.tool_calls || []).map((t: any) => 'вызов:' + t.function?.name).join(', ') + ' | ' + choice?.finish_reason,
      };
    },
    results(h, outs) {
      for (const o of outs) h.push({ role: 'tool', tool_call_id: o.call.id, name: o.call.name, content: o.output });
    },
    async own(call) {
      if (!names().has(call.name)) return null;
      try {
        const d: any = await client().post(`${KIMI_SEARCH}/fibers`, { body: { name: call.name, arguments: call.args }, timeout: 60_000 });
        const out = d?.context?.output ?? d?.context?.encrypted_output;
        if (out === undefined || out === null || out === '') return 'поиск ничего не вернул';
        return typeof out === 'string' ? out : JSON.stringify(out);
      } catch (e) {
        return 'ошибка: поиск не сработал — ' + logError(errKind(e), e);
      }
    },
  };
  return eng;
}

let _engine: Engine | null = null;
export function engine(): Engine {
  return (_engine ||= PROVIDER === 'anthropic' ? anthropicEngine() : PROVIDER === 'moonshot' ? moonshotEngine() : openaiEngine());
}
