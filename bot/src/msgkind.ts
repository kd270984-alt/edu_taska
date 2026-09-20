// Что человек прислал, если это не текст. Файлы бот не прикладывает — но обязан сказать об этом,
// иначе молчание выглядит поломкой.
export function attachmentKind(m: any): string {
  if (!m) return '';
  if (m.photo) return 'фотографию';
  if (m.document) return 'файл';
  if (m.voice) return 'голосовое сообщение';
  if (m.video_note) return 'видеосообщение';
  if (m.video) return 'видео';
  if (m.audio) return 'аудио';
  if (m.animation) return 'гифку';
  if (m.sticker) return 'стикер';
  if (m.location || m.venue) return 'геопозицию';
  if (m.contact) return 'контакт';
  if (m.poll) return 'опрос';
  if (m.dice) return 'кубик';
  return m.text ? '' : 'такое сообщение';
}

// Ответ на сообщение без текста: коротко объясняем, что умеем.
export function noTextReply(kind: string): string {
  const k = kind || 'такое сообщение';
  return `Я понимаю текст и голосовые — ${k} обработать не могу.\n\n`
    + 'Напишите или наговорите, что сделать с задачами: «что у меня сегодня», «добавь задачу …», '
    + '«перенеси … на пятницу», «заверши …».\n'
    + 'Файлы и картинки прикладываются в самой Таске — откройте задачу и перетащите их в «Вложения».';
}

// Приписка к ответу, когда текст есть, но рядом ещё и вложение.
export function attachmentNote(kind: string): string {
  return `\n\n(${kind[0].toUpperCase() + kind.slice(1)} приложить к задаче я не умею — это делается в самой Таске, в карточке задачи.)`;
}

