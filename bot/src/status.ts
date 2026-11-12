// Строки состояния для портала academy: при подключении бота он читает журнал и по ним говорит
// ученику, что не так. Формат — договорённость с порталом (11.11.2026), менять только вместе с ним:
//   BOT_STATUS telegram=ok bot=@имя        | telegram=fail code=bad_token
//   BOT_STATUS model=ok provider=<p> model=<m> | model=fail provider=<p> code=bad_key|no_money|region|no_key|other
//   BOT_STATUS voice=on | voice=off
//   BOT_STATUS poll=ok (после первого удачного getUpdates) | poll=fail code=twin (409: бот уже запущен где-то ещё)
// Секретов в этих строках не бывает: ни токена, ни ключа.
// Части — готовые «ключ=значение» (ключ model встречается дважды, поэтому не объект). Пробелы в значениях
// (модель из .env с пробелом) заменяем, чтобы строка всегда делилась на части однозначно.
export function botStatus(...parts: string[]): void {
  console.log('BOT_STATUS ' + parts.map((p) => String(p).trim().replace(/\s+/g, '_')).join(' '));
}

// Адрес Телеграма. TELEGRAM_API_URL — только для проверок с поддельным Телеграмом (npm run checkproviders).
export const TG_API = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/+$/, '');
