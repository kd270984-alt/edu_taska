// Проверка связки бота с Таской БЕЗ модели: вход агента, работа от имени человека,
// создание, перенос и завершение задачи. Запуск: npm run selftest -- <telegram_id>
import { api, isoDay, dayOf, type Task } from './taska.ts';

const tgId = process.argv[2];
if (!tgId) { console.error('нужен telegram_id: npm run selftest -- 777001'); process.exit(1); }

const day = (plus: number) => { const d = new Date(); d.setDate(d.getDate() + plus); return isoDay(d); };
let ok = 0, bad = 0;
const check = (name: string, good: boolean, extra = '') => { good ? (ok++, console.log('  ✓', name, extra)) : (bad++, console.log('  ✗', name, extra)); };

const who = await api<{ linked: boolean; user: { id: string; name: string } | null }>(`/api/agent/resolve?telegram_id=${tgId}`);
check('телеграм привязан', who.linked, who.user ? '→ ' + who.user.name : '');
if (!who.linked) process.exit(1);

const tasks = (await api<{ tasks: Task[] }>('/api/tasks', { telegramId: tgId })).tasks;
check('видим задачи человека', tasks.length > 0, `(${tasks.length} шт.)`);

const created = (await api<{ task: Task }>('/api/tasks', {
  method: 'POST', telegramId: tgId,
  body: { name: '[бот] проверка связи', due_date: day(0), due_time: '09:15', assignee_id: who.user!.id },
})).task;
check('создание задачи', !!created.id, `на ${dayOf(created)}`);

const moved = (await api<{ task: Task }>(`/api/tasks/${created.id}`, {
  method: 'PATCH', telegramId: tgId, body: { due_date: day(2) },
})).task;
check('перенос на другой день', dayOf(moved) === day(2), `→ ${dayOf(moved)}`);

try {
  await api(`/api/tasks/${created.id}`, { method: 'PATCH', telegramId: tgId, body: { due_date: null } });
  check('дату убрать нельзя', false, '— сервер разрешил, а не должен');
} catch (e) { check('дату убрать нельзя', true, '— ' + (e as Error).message); }

await api(`/api/tasks/${created.id}`, {
  method: 'PATCH', telegramId: tgId, body: { archived: true, completed_at: new Date().toISOString() },
});
const inArchive = (await api<{ tasks: Task[] }>('/api/tasks?archived=1', { telegramId: tgId })).tasks.some((t) => t.id === created.id);
check('завершение → архив', inArchive);

await api(`/api/tasks/${created.id}?purge=1`, { method: 'DELETE', telegramId: tgId });
check('за собой убрано', true);

try {
  await api('/api/tasks', { telegramId: '999999' });
  check('чужой телеграм не пускает', false, '— пустил, а не должен');
} catch (e) { check('чужой телеграм не пускает', true, '— ' + (e as Error).message); }

console.log(`\nИтог: успешно ${ok}, провалов ${bad}`);
process.exit(bad ? 1 : 0);
