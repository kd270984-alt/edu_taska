// Проверка распознавания речи на готовом файле: npm run tryvoice -- /путь/к/записи
import fs from 'node:fs';
import { transcribeBuffer } from './stt.ts';

const path = process.argv[2];
if (!path) { console.error('нужен путь к файлу записи'); process.exit(1); }
const data = new Uint8Array(fs.readFileSync(path));
const t0 = Date.now();
const text = await transcribeBuffer(data, path.split('/').pop() || 'voice.wav');
console.log(`расслышал за ${Math.round((Date.now() - t0) / 1000)} c: «${text}»`);
