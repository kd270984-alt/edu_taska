// ─────────────────────────────────────────────────────────────────────────────
// ЧИСТКА ОПИСАНИЯ ЗАДАЧИ (серверная сторона).
//
// ⚠️ ЗАЧЕМ. Описание — единственное поле, которое хранится РАЗМЕТКОЙ и показывается через innerHTML.
// До 20.09.2026 сервер принимал её как есть: любой сотрудник мог создать задачу на коллегу и положить
// в описание <img src=x onerror="…">. Жертва открывала карточку — чужой скрипт выполнялся в её сессии
// и читал токен из localStorage. Это полный захват учётной записи, а если открыл администратор —
// захват администратора. Проверено вживую, дыра была настоящая.
//
// ⚠️ ПОЧЕМУ НА СЕРВЕРЕ, А НЕ ТОЛЬКО ВО ФРОНТЕ. Браузерный чистильщик защищает только наш фронт.
// В базу пишет ещё телеграм-бот, а завтра — что-нибудь ещё; и любой, у кого есть токен, может послать
// запрос руками. Дверь закрывается там, где данные ВХОДЯТ.
//
// ⚠️ ПРИНЦИП. Белый список тегов и НОЛЬ атрибутов. Ни один кусок присланного текста не попадает
// в атрибут: разрешённые атрибуты собираются заново из проверенных значений. Поэтому обмануть
// разбор кавычками и «>» внутри значения нельзя — в худшем случае мусор станет обычным текстом.
// ─────────────────────────────────────────────────────────────────────────────

// теги, которые оставляем (содержимое и сам тег)
const KEEP = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'a', 'br', 'div', 'p', 'ul', 'ol', 'li', 'span']);
// теги, которые вырезаем ВМЕСТЕ С СОДЕРЖИМЫМ (внутри не текст, а код/стили)
const NUKE = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'svg', 'math', 'template', 'head', 'title']);
// наши собственные классы: чек-лист и кегль. Чужие классы не переживают чистку.
const CLASS_OK = new Set(['cl-item', 'cl-sub', 'cl-done', 'cl-box', 'fs-s', 'fs-m', 'fs-l', 'fs-xl']);

const escText = (s: string): string => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (raw: string, name: string): string => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(raw);
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : '';
};

export function sanitizeDescription(input: unknown): string {
  const src = String(input ?? '');
  if (!src) return '';
  if (src.length > 200_000) return escText(src.slice(0, 200_000));   // защита от «описания» на мегабайты
  let out = '';
  const open: string[] = [];          // стек открытых разрешённых тегов — закрываем ровно то, что открыли
  let nuke = '';                      // имя тега, содержимое которого выбрасываем целиком
  let i = 0;
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>])*)>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(src)) !== null) {
    const text = src.slice(i, m.index);
    if (!nuke && text) out += escText(text);
    i = m.index + m[0].length;
    const name = (m[1] || '').toLowerCase();
    if (!name) continue;                                   // комментарий, CDATA, <!doctype> — просто выбрасываем
    const closing = m[0].startsWith('</');
    if (nuke) { if (closing && name === nuke) nuke = ''; continue; }   // внутри вырезаемого тега не смотрим ни на что
    if (NUKE.has(name)) { if (!closing) nuke = name; continue; }
    if (!KEEP.has(name)) continue;                         // незнакомый тег: снимаем сам тег, содержимое остаётся
    if (name === 'br') { out += '<br>'; continue; }
    if (closing) {
      const k = open.lastIndexOf(name);
      if (k < 0) continue;                                 // закрытие без открытия — мусор
      while (open.length > k) out += `</${open.pop()}>`;    // заодно закрываем всё, что забыли закрыть внутри
      continue;
    }
    const raw = m[2] || '';
    let extra = '';
    if (name === 'a') {
      const href = attr(raw, 'href').trim();
      if (!/^(https?:\/\/|mailto:)/i.test(href)) { continue; }   // javascript:, data:, пустой — ссылку снимаем, текст остаётся
      extra = ` href="${href.replace(/[<>"&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', '&': '&amp;' }[c] as string))}" target="_blank" rel="noopener noreferrer"`;
    } else if (name === 'ol') {
      const st = parseInt(attr(raw, 'start'), 10);
      if (st > 1 && st < 10000) extra = ` start="${st}"`;
    } else if (name === 'span' || name === 'div') {
      const cls = attr(raw, 'class').split(/\s+/).filter((c) => CLASS_OK.has(c));
      if (cls.length) extra = ` class="${cls.join(' ')}"`;
      if (name === 'span' && cls.includes('cl-box')) extra += ' contenteditable="false"';
    }
    if (m[0].endsWith('/>') && (name === 'span' || name === 'div' || name === 'p' || name === 'li')) { out += `<${name}${extra}></${name}>`; continue; }
    out += `<${name}${extra}>`;
    open.push(name);
    if (open.length > 60) { while (open.length) out += `</${open.pop()}>`; return out; }   // вложенность-бомба
  }
  const tail = src.slice(i);
  if (!nuke && tail) out += escText(tail);
  while (open.length) out += `</${open.pop()}>`;
  return out;
}
