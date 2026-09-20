// Проверка: на любое сообщение у бота есть ответ, а не молчание. Запуск: npm run checkmsg
import { attachmentKind, noTextReply, attachmentNote } from './msgkind.ts';

const cases: Array<{ name: string; m: any; voice?: boolean }> = [
  { name: 'фото с подписью', m: { photo: [{}], caption: 'Поставь задачу и вложи этот файл' } },
  { name: 'фото без подписи', m: { photo: [{}] } },
  { name: 'голосовое', m: { voice: { file_id: 'x' } }, voice: true },
  { name: 'стикер', m: { sticker: {} } },
  { name: 'документ с подписью', m: { document: {}, caption: 'смета' } },
  { name: 'геопозиция', m: { location: {} } },
  { name: 'обычный текст', m: { text: 'что у меня сегодня' } },
];

let bad = 0;
for (const c of cases) {
  const kind = attachmentKind(c.m);
  const body = String(c.m.text || c.m.caption || '').trim();
  // голосовые до noTextReply не доходят: их сначала расшифровывает stt, и дальше это обычная просьба
  const out = c.voice ? 'расшифровка записи → «ответ агента»'
    : body ? '«ответ агента»' + (kind ? attachmentNote(kind) : '') : noTextReply(kind);
  if (!out.trim()) { bad++; console.log('  ✗', c.name, '— бот промолчал бы'); continue; }
  console.log('  ✓', c.name, '→', out.replace(/\n+/g, ' ⏎ ').slice(0, 120));
}
console.log(bad ? `\nПровалов: ${bad}` : '\nМолчания нет ни на одном виде сообщений.');
process.exit(bad ? 1 : 0);
