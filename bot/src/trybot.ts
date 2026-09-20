// Короткий разговор с агентом без Телеграма: проверяем, что модель понимает просьбы
// и дёргает нужные инструменты. Запуск: npm run trybot -- <telegram_id> "фраза" ["фраза2" ...]
import { answer, MODEL_READY, type Turn } from './agent.ts';

const [tgId, ...phrases] = process.argv.slice(2);
if (!tgId || !phrases.length) { console.error('нужен telegram_id и хотя бы одна фраза'); process.exit(1); }
if (!MODEL_READY) { console.error('нет ключа модели'); process.exit(1); }

const history: Turn[] = [];
for (const p of phrases) {
  console.log('\n👤 ' + p);
  const t0 = Date.now();
  try {
    const { reply } = await answer(history, p, tgId, 'Иван');
    console.log('🤖 ' + reply + `   [${Math.round((Date.now() - t0) / 1000)} c]`);
  } catch (e) {
    console.log('✗ ошибка: ' + (e as Error).message);
    break;
  }
}
