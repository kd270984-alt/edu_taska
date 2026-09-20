/* Проверка чек-листа в описании задачи (пункты с флажками).
 *
 * ЗАЧЕМ ОТДЕЛЬНО: чек-лист живёт в contenteditable — это поведение браузера, а не наша функция,
 * и проверить его без настоящего DOM нельзя. Поэтому проверка запускается в браузере.
 *
 * КАК ЗАПУСТИТЬ:
 *   1. Открыть Таску, открыть ЛЮБУЮ задачу (нужно поле «Описание»).
 *   2. Открыть консоль браузера (Cmd+Option+J) и вставить содержимое этого файла.
 *   3. Ожидаемый ответ — «18 из 18». Любой FAIL печатает получившийся HTML.
 *
 * ⚠️ Проверка временно затирает описание открытой задачи и в конце чистит его.
 *    Запускать на ТЕСТОВОЙ задаче, а не на рабочей.
 */
(()=>{
const de=document.getElementById('tcDesc');
if(!de){ return 'Откройте карточку задачи — поле «Описание» не найдено'; }
const R=[], ok=(n,c,got)=>R.push((c?'OK ':'FAIL ')+n+(c?'':' -> '+got));
const set=(html)=>{ de.innerHTML=html; de.focus(); };
const caretEnd=i=>clCaretEnd(de.children[i]);
const caretStart=i=>clCaretStart(de.children[i]);
const caretIn=(i,off)=>{ const tn=[...de.children[i].childNodes].find(n=>n.nodeType===3); const s=getSelection(),r=document.createRange(); r.setStart(tn,off); r.collapse(true); s.removeAllRanges(); s.addRange(r); };
const selAll=()=>{ const s=getSelection(),r=document.createRange(); r.selectNodeContents(de); s.removeAllRanges(); s.addRange(r); };
const boxes=()=>de.querySelectorAll('.cl-item').length===de.querySelectorAll('.cl-item > .cl-box').length;
const B='<span class="cl-box" contenteditable="false"></span>';

set('<div>aaa</div>'); caretEnd(0); clToggleLine('tcDesc'); ok('1 строка становится пунктом', de.children[0].classList.contains('cl-item')&&boxes(), de.innerHTML);
clToggleLine('tcDesc'); ok('2 повторное нажатие снимает пункт', !de.querySelector('.cl-item')&&!de.querySelector('.cl-box'), de.innerHTML);
set('<div>a</div><div>b</div><div>c</div>'); selAll(); clToggleLine('tcDesc'); ok('3 три строки разом', de.querySelectorAll('.cl-item').length===3&&boxes(), de.innerHTML);
set('<div class="cl-item">'+B+'aaa</div>'); caretEnd(0); clEnterAt(de); ok('4 Enter в конце даёт пункт с флажком', de.children.length===2&&boxes(), de.innerHTML);
set('<div class="cl-item">'+B+'aaa</div><div class="cl-item">'+B+'<br></div>'); caretStart(1); clEnterAt(de); ok('5 Enter на пустом пункте выходит из списка', !de.children[1].classList.contains('cl-item'), de.innerHTML);
set('<div class="cl-item">'+B+'abcde</div>'); caretIn(0,2); clEnterAt(de); ok('6 Enter в середине делит пункт', de.children.length===2&&boxes()&&de.children[0].textContent==='ab', de.innerHTML);
set('<div class="cl-item">'+B+'aaa</div>'); caretStart(0); clBackspaceAt(de); ok('7 Backspace в начале снимает флажок', !de.children[0].classList.contains('cl-item'), de.innerHTML);
set('<div class="cl-item">'+B+'p</div><div class="cl-item">'+B+'c</div>'); {const d=de.children[1]; if(clWouldParent(d)) d.classList.add('cl-sub');} ok('8 подпункт под пунктом', de.children[1].classList.contains('cl-sub'), de.innerHTML);
set('<div><div class="cl-item">'+B+'a</div><div class="cl-item">'+B+'b</div></div>'); clRepair(de); ok('9 ремонт: обёртка вокруг пунктов разжата', de.children.length===2, de.innerHTML);
set('<div class="cl-item cl-done">b</div>'); clRepair(de); ok('10 ремонт: клон без флажка починен и не зачёркнут', boxes()&&!de.children[0].classList.contains('cl-done'), de.innerHTML);
set('<div>'+B+'b</div>'); clRepair(de); ok('11 ремонт: одинокий флажок удалён', !de.querySelector('.cl-box'), de.innerHTML);
set('<div class="cl-item">'+B+B+'b</div>'); clRepair(de); ok('12 ремонт: лишний флажок удалён', de.querySelectorAll('.cl-box').length===1, de.innerHTML);
set('<div class="cl-item cl-sub">'+B+'x</div>'); clRepair(de); ok('13 ремонт: подпункт без родителя стал пунктом', !de.children[0].classList.contains('cl-sub'), de.innerHTML);
set('<div><div class="cl-item">'+B+'a</div></div>'); clRepair(de); caretEnd(0); {const n0=de.children.length; clEnterAt(de); ok('14 после ремонта Enter снова работает', de.children.length===n0+1&&boxes(), de.innerHTML);}
set('<div class="cl-item">'+B+'a</div>'); de.querySelector('.cl-box').dispatchEvent(new MouseEvent('click',{bubbles:true})); ok('15 клик по флажку отмечает выполненным', de.children[0].classList.contains('cl-done'), de.innerHTML);
set('<div><ul><li>x</li></ul></div>'); caretEnd(0); clToggleLine('tcDesc'); ok('16 строка со списком не становится пунктом', !de.querySelector('.cl-item'), de.innerHTML);
set('<div class="cl-item">'+B+'первая</div><div class="cl-item">'+B+'вторая</div>');
{const s=getSelection(),r=document.createRange(); r.setStart(de.children[0],0); const tn=[...de.children[1].childNodes].find(n=>n.nodeType===3); r.setEnd(tn,3); s.removeAllRanges(); s.addRange(r);}
de.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertText',data:'Z',bubbles:true,cancelable:true}));
ok('17 набор поверх двух пунктов склеивает их в один', de.children.length===1&&boxes(), de.innerHTML);
set('<div class="cl-item">'+B+'ааа</div><div class="cl-item">'+B+'ббб</div><div class="cl-item">'+B+'ввв</div>');
{const s=getSelection(),r=document.createRange(); const t1=[...de.children[0].childNodes].find(n=>n.nodeType===3),t3=[...de.children[2].childNodes].find(n=>n.nodeType===3); r.setStart(t1,1); r.setEnd(t3,2); s.removeAllRanges(); s.addRange(r);}
de.dispatchEvent(new InputEvent('beforeinput',{inputType:'deleteContentBackward',bubbles:true,cancelable:true}));
ok('18 удаление через три пункта склеивает в один', de.children.length===1&&boxes()&&de.textContent==='ав', de.innerHTML);

de.innerHTML='';
return R.join('\n')+'\n=== '+R.filter(x=>x.indexOf('OK')===0).length+' из '+R.length;
})()
