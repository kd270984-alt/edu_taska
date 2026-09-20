// Распознавание голосовых: Телеграм отдаёт файл записи по ссылке, OpenAI переводит его в текст.
// Отдельный модуль без сети Таски — чтобы можно было проверить на готовом файле.
import OpenAI from 'openai';

let _client: OpenAI | null = null;
const client = (): OpenAI => (_client ||= new OpenAI());   // лениво: без ключа модуль не должен падать при загрузке
const STT_MODEL = process.env.AGENT_STT_MODEL || 'gpt-4o-transcribe';
const MAX_BYTES = 20 * 1024 * 1024;   // 20 МБ: длинные записи не тянем, честно скажем об этом

export async function transcribeBuffer(data: Uint8Array, filename: string): Promise<string> {
  const file = new File([data as any], filename, { type: 'application/octet-stream' });
  const r = await client().audio.transcriptions.create({ file: file as any, model: STT_MODEL, language: 'ru' });
  return String((r as { text?: string }).text || '').trim();
}

// file_id из Телеграма → текст. Бросает понятную ошибку, если запись слишком большая или её не отдали.
export async function transcribeTelegramFile(fileId: string, botToken: string): Promise<string> {
  const info = await fetch(`https://api.telegram.org/bot${botToken}/getFile`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: fileId }),
  }).then((r) => r.json() as Promise<any>);
  if (!info.ok) throw new Error('Телеграм не отдал запись: ' + (info.description || 'причина неизвестна'));
  const size = Number(info.result.file_size || 0);
  if (size > MAX_BYTES) throw new Error('Запись слишком длинная — пришлите покороче или напишите текстом');
  const path = String(info.result.file_path || '');
  const res = await fetch(`https://api.telegram.org/file/bot${botToken}/${path}`);
  if (!res.ok) throw new Error('не удалось скачать запись из Телеграма');
  const buf = new Uint8Array(await res.arrayBuffer());
  const name = path.split('/').pop() || 'voice.oga';
  return transcribeBuffer(buf, name);
}
