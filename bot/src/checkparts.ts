// Проверка: длинный ответ дойдёт целиком, а история не порвётся посреди вызова инструмента.
import { chunks, trimHistory } from './parts.ts';

let ok = 0, bad = 0;
const check = (name: string, good: boolean, extra = '') => { good ? (ok++, console.log('  ✓', name, extra)) : (bad++, console.log('  ✗', name, extra)); };

// --- длинные ответы ---
const long = Array.from({ length: 400 }, (_, i) => `строка ${i}: задача про что-то важное`).join('\n');
const parts = chunks(long);
check('длинный ответ разрезан', parts.length > 1, `(${parts.length} частей)`);
check('каждая часть влезает в Телеграм', parts.every((p) => p.length <= 3900));
check('текст не потерян', parts.join('\n').replace(/\s+/g, ' ') === long.replace(/\s+/g, ' '));
const noBreaks = 'а'.repeat(9000);
check('текст без переносов тоже режется', chunks(noBreaks).every((p) => p.length <= 3900));
check('короткий ответ остаётся одним куском', chunks('привет').length === 1);

// --- обрезка истории ---
const turn = (n: number) => ([
  { role: 'user', content: 'просьба ' + n },
  { type: 'reasoning' },
  { type: 'function_call', call_id: 'c' + n, name: 'list_tasks', arguments: '{}' },
  { type: 'function_call_output', call_id: 'c' + n, output: '{}' },
  { type: 'message', role: 'assistant' },
]);
const hist = Array.from({ length: 12 }, (_, i) => turn(i)).flat();
const cutted = trimHistory(hist, 3);
const ids = (arr: any[], t: string) => arr.filter((x) => x.type === t).map((x) => x.call_id);
check('история обрезана', cutted.length < hist.length, `(${hist.length} → ${cutted.length})`);
check('первым идёт сообщение человека', (cutted[0] as any)?.role === 'user');
check('пары «вызов ↔ результат» целы',
  JSON.stringify(ids(cutted, 'function_call')) === JSON.stringify(ids(cutted, 'function_call_output')));
check('короткая история не трогается', trimHistory(turn(1), 8).length === 5);

console.log(`\nИтог: успешно ${ok}, провалов ${bad}`);
process.exit(bad ? 1 : 0);
