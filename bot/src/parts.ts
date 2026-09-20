// Две вещи, от которых зависит «человек всегда получает ответ» и «разговор не умирает».
// Вынесены отдельно, чтобы проверять их без сети и без Телеграма.

export const TG_LIMIT = 3900;   // предел сообщения в Телеграме 4096, режем с запасом

// Длинный ответ режем по строкам и словам: иначе Телеграм отвергает сообщение целиком.
export function chunks(text: string, limit = TG_LIMIT): string[] {
  const out: string[] = [];
  let left = String(text || '');
  while (left.length > limit) {
    let cut = left.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = left.lastIndexOf(' ', limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(left.slice(0, cut));
    left = left.slice(cut).replace(/^\s+/, '');
  }
  if (left) out.push(left);
  return out;
}

// История — элементы Responses API: вызов инструмента и его результат идут парой.
// Режем по границам ходов (сообщениям человека), иначе разорванная пара навсегда ломает разговор.
export function trimHistory(h: any[], keepTurns = 8): any[] {
  const starts: number[] = [];
  h.forEach((item: any, i) => { if (item?.role === 'user' && typeof item?.content === 'string') starts.push(i); });
  if (starts.length <= keepTurns) return h;
  return h.slice(starts[starts.length - keepTurns]);
}
