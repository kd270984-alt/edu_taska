// Собственно агент: разговор человека в Телеграме → инструменты поверх API Таски.
// Модель — OpenAI (Responses API), петлю ведём вручную: видно, что происходит на каждом шаге.
import OpenAI from 'openai';
import { api, isoDay, weekdayOf, dayOf, type Task } from './taska.ts';

export const MODEL_READY = !!process.env.OPENAI_API_KEY;   // без ключа модели агент молчит, но привязка работает
let _client: OpenAI | null = null;
const client = (): OpenAI => (_client ||= new OpenAI());   // лениво: без ключа модуль не должен падать при загрузке
const MODEL = process.env.AGENT_MODEL || 'gpt-5';
const MAX_STEPS = 8;
const DEBUG = process.env.AGENT_DEBUG === '1';   // AGENT_DEBUG=1 — печатать в журнал вызовы инструментов                // столько раз подряд агент может взяться за инструмент

const tools: any[] = [
  {
    type: 'function',
    name: 'list_tasks',
    description: 'Задачи человека за период. Без аргументов — на сегодня. Возвращает id, название, дату, время.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'первый день периода, ГГГГ-ММ-ДД' },
        to: { type: 'string', description: 'последний день периода, ГГГГ-ММ-ДД' },
        include_done: { type: 'boolean', description: 'показывать ли завершённые (по умолчанию нет)' },
      },
    },
  },
  {
    type: 'function',
    name: 'create_task',
    description: 'Создать задачу. Дата обязательна — задача живёт в дне календаря.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'о чём задача, коротко' },
        due_date: { type: 'string', description: 'день задачи, ГГГГ-ММ-ДД' },
        due_time: { type: 'string', description: 'время ЧЧ:ММ, если человек его назвал' },
        description: { type: 'string', description: 'подробности, если человек их дал' },
        tags: { type: 'array', items: { type: 'string' }, description: 'названия существующих меток, не больше двух' },
      },
      required: ['name', 'due_date'],
    },
  },
  {
    type: 'function',
    name: 'update_task',
    description: 'Изменить существующую задачу: перенести на другой день, поправить время или название.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        due_date: { type: 'string', description: 'новый день, ГГГГ-ММ-ДД' },
        due_time: { type: 'string', description: 'новое время ЧЧ:ММ; пустая строка снимает время' },
        name: { type: 'string', description: 'новое название' },
      },
      required: ['task_id'],
    },
  },
  {
    type: 'function',
    name: 'complete_task',
    description: 'Завершить задачу — она уходит в архив.',
    parameters: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  {
    type: 'function',
    name: 'list_tags',
    description: 'Какие метки заведены в Таске. Новые метки заводит только администратор — придумывать свои нельзя.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'set_task_tags',
    description: 'Задать метки задачи из уже существующих. ЗАМЕНЯЕТ весь набор: что не перечислено — снимется. Больше двух не бывает. Пустой список снимает все метки.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' }, description: 'названия меток, как они заведены в Таске' },
      },
      required: ['task_id', 'tags'],
    },
  },
  {
    type: 'function',
    name: 'find_tasks',
    description: 'Найти задачи по слову в названии или описании — когда человек называет задачу словами, а не датой.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, include_done: { type: 'boolean' } },
      required: ['query'],
    },
  },
];

const short = (t: Task) => ({
  id: t.id, название: t.name, день: dayOf(t),
  ...(t.due_time ? { время: String(t.due_time).slice(0, 5) } : {}),
  ...(t.parent_id ? { подзадача: true } : {}),
  ...(t.archived ? { завершена: true } : {}),
  ...(t.tags && t.tags.length ? { меток: t.tags.length } : {}),
});

interface Tag { id: string; name: string }

// Метки заводит только администратор, поэтому бот умеет лишь ВЫБИРАТЬ из готовых:
// что не нашлось по названию — честно возвращаем как «нет такой метки».
async function setTags(taskId: string, names: unknown, tgId: string, replace = true): Promise<string> {
  const want = Array.isArray(names) ? names.map((n) => String(n).trim()).filter(Boolean) : [];
  const all = (await api<{ tags: Tag[] }>('/api/tags', { telegramId: tgId })).tags || [];
  const nameOf = (id: string) => all.find((t) => t.id === id)?.name || id;
  const ids: string[] = [];
  const missing: string[] = [];
  const overflow: string[] = [];
  for (const n of want) {
    const t = all.find((x) => x.name.toLowerCase() === n.toLowerCase())
      || all.find((x) => x.name.toLowerCase().startsWith(n.toLowerCase()));
    if (!t) { missing.push(n); continue; }
    if (ids.includes(t.id)) continue;
    if (ids.length >= 2) { overflow.push(t.name); continue; }   // на задачу больше двух меток не вешается
    ids.push(t.id);
  }
  // Ни одна метка не опознана — НИЧЕГО не пишем: PUT заменяет весь набор и снял бы то, что уже стоит.
  if (want.length && !ids.length) {
    return JSON.stringify({ ничего_не_изменено: true, нет_таких_меток: missing,
      подсказка: 'новые метки заводит только администратор в самой Таске' });
  }
  const before = replace ? [] : ((await api<{ task: Task }>(`/api/tasks/${taskId}`, { telegramId: tgId })).task.tags || []);
  const final = [...new Set([...before, ...ids])].slice(0, 2);
  await api(`/api/tasks/${taskId}/tags`, { method: 'PUT', body: { tag_ids: final }, telegramId: tgId });
  return JSON.stringify({
    метки_на_задаче: final.map(nameOf),
    ...(missing.length ? { нет_таких_меток: missing, подсказка: 'новые метки заводит только администратор в самой Таске' } : {}),
    ...(overflow.length ? { не_поместились: overflow, причина: 'на задачу можно не больше двух меток' } : {}),
  });
}

async function runTool(name: string, input: any, tgId: string): Promise<string> {
  const all = async (done: boolean) =>
    (await api<{ tasks: Task[] }>(`/api/tasks${done ? '?archived=1' : ''}`, { telegramId: tgId })).tasks || [];
  switch (name) {
    case 'list_tasks': {
      const from = input.from || isoDay(new Date());
      const to = input.to || from;
      const list = (await all(false)).filter((t) => dayOf(t) >= from && dayOf(t) <= to);
      if (input.include_done) list.push(...(await all(true)).filter((t) => dayOf(t) >= from && dayOf(t) <= to));
      list.sort((a, b) => (dayOf(a) + (a.due_time || '')).localeCompare(dayOf(b) + (b.due_time || '')));
      return JSON.stringify({ период: from === to ? from : `${from} — ${to}`, задачи: list.map(short) });
    }
    case 'create_task': {
      const body: Record<string, unknown> = { name: input.name, due_date: input.due_date };
      if (input.due_time) body.due_time = input.due_time;
      if (input.description) body.description = input.description;
      let tagInfo: Record<string, unknown> | undefined;
      if (Array.isArray(input.tags) && input.tags.length) {
        const all = (await api<{ tags: Tag[] }>('/api/tags', { telegramId: tgId })).tags || [];
        const ids: string[] = [], missing: string[] = [];
        for (const n of input.tags.map((x: unknown) => String(x).trim()).filter(Boolean)) {
          const t = all.find((x) => x.name.toLowerCase() === n.toLowerCase())
            || all.find((x) => x.name.toLowerCase().startsWith(n.toLowerCase()));
          if (t && !ids.includes(t.id) && ids.length < 2) ids.push(t.id); else if (!t) missing.push(n);
        }
        if (ids.length) body.tag_ids = ids;   // сервер повесит их в том же запросе — частичного результата не будет
        tagInfo = {
          метки: ids.map((id) => all.find((t) => t.id === id)!.name),
          ...(missing.length ? { нет_таких_меток: missing, подсказка: 'новые метки заводит только администратор в самой Таске' } : {}),
        };
      }
      const d = await api<{ task: Task }>('/api/tasks', { method: 'POST', body, telegramId: tgId });
      return JSON.stringify({ создана: short(d.task), ...(tagInfo ? tagInfo : {}) });
    }
    case 'list_tags': {
      const d = await api<{ tags: Tag[] }>('/api/tags', { telegramId: tgId });
      return JSON.stringify({ метки: (d.tags || []).map((t) => t.name) });
    }
    case 'set_task_tags':
      return setTags(input.task_id, input.tags, tgId);
    case 'update_task': {
      const body: Record<string, unknown> = {};
      if (input.due_date) body.due_date = input.due_date;
      if (input.name) body.name = input.name;
      if ('due_time' in input) body.due_time = input.due_time || null;   // пустое значение снимает время
      if (!Object.keys(body).length) return JSON.stringify({ ошибка: 'не указано ни одно поле для изменения' });
      const d = await api<{ task: Task }>(`/api/tasks/${input.task_id}`, { method: 'PATCH', body, telegramId: tgId });
      return JSON.stringify({ изменена: short(d.task) });
    }
    case 'complete_task': {
      const d = await api<{ task: Task }>(`/api/tasks/${input.task_id}`, {
        method: 'PATCH', telegramId: tgId,
        body: { archived: true, completed_at: new Date().toISOString() },
      });
      return JSON.stringify({ завершена: short(d.task) });
    }
    case 'find_tasks': {
      const q = String(input.query || '').toLowerCase();
      const list = [...(await all(false)), ...(input.include_done ? await all(true) : [])]
        .filter((t) => (t.name + ' ' + (t.description || '')).toLowerCase().includes(q));
      return JSON.stringify({ найдено: list.slice(0, 20).map(short), всего: list.length, показано: Math.min(20, list.length) });
    }
    default:
      return `неизвестный инструмент ${name}`;
  }
}

function systemPrompt(userName: string): string {
  const now = new Date();
  return [
    `Ты — помощник по задачам в планировщике «Таска». Пишешь в Телеграме с человеком по имени ${userName}.`,
    `Сегодня ${isoDay(now)}, ${weekdayOf(now)}.`,
    '',
    'Что ты умеешь (и только это):',
    '- показывать задачи человека за день или период, искать их по слову;',
    '- создавать задачу (название, день, время, описание, метки из уже заведённых);',
    '- вешать и снимать метки у уже существующей задачи — из тех, что заведены в Таске;',
    '- переносить задачу на другой день, менять время и название, снимать время;',
    '- понимать голосовые: я расшифровываю запись в текст и работаю по ней;',
    '- завершать задачу — она уходит в архив;',
    '- искать в интернете, если вопрос не про задачи.',
    '',
    'Чего ты НЕ умеешь — так и говори прямо, не придумывай обходных путей:',
    '- прикладывать файлы и картинки К ЗАДАЧЕ как вложение (это человек делает сам в Таске);',
    '- заводить новые метки (их создаёт администратор в Таске), назначать задачу на другого человека,',
    '  ставить напоминания и будильники, писать кому-то ещё, работать с почтой и календарями;',
    '- удалять задачи и возвращать их из архива;',
    '- обходить права Таски: наблюдатель задачи не создаёт и не меняет, а завершить задачу может только',
    '  её ответственный. Пришёл отказ «в Таске на это нет прав» — так и скажи, это не поломка.',
    '',
    'Честность важнее услужливости:',
    '- НИКОГДА не говори, что сделал действие, если инструмент его не выполнил. Не получилось — скажи, что не вышло и почему.',
    '- Не выдавай обходной путь за просьбу: не дописывай метку или файл в название задачи, чтобы «как будто получилось».',
    '- Не обещай сделать что-то позже или напомнить — ты не возвращаешься к разговору сам.',
    '',
    'Как себя вести:',
    '- Отвечай коротко и по-русски, как деловой коллега. Без вступлений и без списков там, где хватит фразы.',
    '- Сделал действие — скажи, что именно сделал: название задачи и день.',
    '- У задачи ВСЕГДА есть день. Человек не назвал день — считай, что это сегодня, и скажи об этом в ответе.',
    '- «Завтра», «в пятницу», «через неделю» переводи в дату сам, от сегодняшнего дня.',
    '- Прежде чем менять или завершать задачу, найди её (list_tasks или find_tasks) и убедись, что это она.',
    '- Нашёл несколько похожих — спроси, какую именно, и перечисли их коротко.',
    '- Не выдумывай задачи и даты: всё, что рассказываешь о задачах, бери из инструментов.',
    '- Метки только из тех, что уже заведены (list_tags). Своих не придумывай и в название их не вписывай:',
    '  нет подходящей — так и скажи, что такую метку заводит администратор.',
    '- Задачи — рабочие. Ни советов, ни рассуждений сверх просьбы.',
  ].join('\n');
}

export type Turn = any;   // элемент истории Responses API: сообщение, вызов инструмента или его результат

// Один ход разговора: история + новое сообщение → ответ человеку (историю дополняем на месте).
// Что агент успел сделать за ход — чтобы при обрыве честно сказать об этом человеку.
export interface TurnResult { reply: string; did: string[]; truncated: boolean }

const DONE_WORDS: Record<string, string> = {
  create_task: 'создал задачу', update_task: 'изменил задачу', complete_task: 'завершил задачу',
  set_task_tags: 'поменял метки',
};

export async function answer(history: Turn[], userText: string, tgId: string, userName: string): Promise<TurnResult> {
  history.push({ role: 'user', content: userText });
  const did: string[] = [];          // только то, что РЕАЛЬНО отработало без ошибки
  let reply = '';
  let truncated = false;
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await client().responses.create({
      model: MODEL,
      instructions: systemPrompt(userName),
      input: history as any,
      tools: [...tools, { type: 'web_search' }],   // плюс поиск в интернете, когда вопрос не про задачи
      store: false,                               // переписку держим у себя, на стороне модели не храним
    });
    const out: any[] = (res as any).output || [];
    const status = String((res as any).status || '');
    if (DEBUG) console.error('[шаг ' + step + '] ' + out.map((o) => o?.type + (o?.name ? ':' + o.name : '')).join(', ')
      + ' | текст: ' + JSON.stringify(String((res as any).output_text || '').slice(0, 200))
      + ' | статус: ' + status + ' | причина: ' + JSON.stringify((res as any).incomplete_details || null));
    reply = String((res as any).output_text || '').trim();   // берём текст ТОЛЬКО этого шага: старое обещание — не ответ
    history.push(...(out as any[]));              // ответ модели целиком — он же контекст следующего шага
    if (status === 'incomplete') truncated = true;
    const calls = out.filter((o) => o?.type === 'function_call');
    if (!calls.length) break;
    for (const c of calls) {
      let result: string;
      let ok = false;
      try {
        const args = c.arguments ? JSON.parse(c.arguments) : {};
        result = await runTool(c.name, args, tgId);
        ok = !result.startsWith('ошибка:') && !result.includes('"ошибка"');
      } catch (e) {
        result = `ошибка: ${(e as Error).message}`;
      }
      if (ok && DONE_WORDS[c.name]) {
        let what = '';
        try { const r = JSON.parse(result); const t: any = r.создана || r.изменена || r.завершена; if (t?.название) what = ` «${t.название}»` + (t.день ? ` на ${t.день}` : ''); } catch { /* не страшно */ }
        did.push(DONE_WORDS[c.name] + what);
      }
      if (DEBUG) console.error('   → ' + c.name + '(' + String(c.arguments).slice(0, 120) + ') = ' + result.slice(0, 200));
      history.push({ type: 'function_call_output', call_id: c.call_id, output: result } as any);
    }
    if (step === MAX_STEPS - 1) truncated = true;   // вышли по счётчику: модель не успела подвести итог
  }
  if (!reply) {
    // Текста нет, а дело сделано — говорить «не понял» нельзя: человек повторит и получит дубль.
    reply = did.length ? 'Готово: ' + did.join('; ') + '.' : 'Не понял просьбу. Скажите иначе?';
  } else if (truncated && did.length) {
    reply += '\n\n(Разговор оборвался на половине. Успел: ' + did.join('; ') + '. Проверьте в Таске.)';
  }
  return { reply, did, truncated };
}
