#!/usr/bin/env node
// Проверка фронта ПЕРЕД деплоем — так же, как его разбирает браузер.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СКРИПТ: `node --check file.js` разбирает файл как CommonJS-модуль, а модуль неявно обёрнут
// в функцию — поэтому `return` на верхнем уровне для него ЗАКОННЫЙ. Браузер же считает <script> обычным скриптом,
// где такой return — SyntaxError, и НЕ ВЫПОЛНЯЕТ ВЕСЬ ФАЙЛ: сайт открывается, но мёртвый — так теряется весь фронт.
// vm.Script разбирает ровно по правилам <script> и ловит этот случай.
//
// Запуск: node scripts/check-web.js [путь_к_html]   (по умолчанию web/index.html)
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const file = process.argv[2] || path.join(__dirname, '..', 'web', 'index.html');
const html = fs.readFileSync(file, 'utf8');
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

if (!blocks.length) { console.error('✗ во фронте не найдено ни одного <script> — проверять нечего'); process.exit(1); }

let bad = 0;
blocks.forEach((src, i) => {
  try {
    new vm.Script(src, { filename: `${path.basename(file)}#script${i + 1}` });
  } catch (e) {
    bad++;
    console.error(`✗ script #${i + 1}: ${e.message}`);
    const line = (e.stack.match(/#script\d+:(\d+)/) || [])[1];
    if (line) console.error(`  строка ${line}: ${(src.split('\n')[line - 1] || '').trim().slice(0, 160)}`);
  }
});

if (bad) { console.error(`\n✗ ФРОНТ НЕ ЗАПУСТИТСЯ В БРАУЗЕРЕ (${bad} из ${blocks.length}) — деплоить нельзя`); process.exit(1); }
console.log(`✓ синтаксис фронта в порядке (${blocks.length} script, ${html.length} байт) — так же увидит браузер`);
