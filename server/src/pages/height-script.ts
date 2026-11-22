import { PAGE_HEIGHT_MESSAGE } from '../../../shared/visual-pages.js'

/**
 * Script injetado na página servida: mede a altura do documento com
 * `ResizeObserver` e avisa o cartão por `postMessage`, para o iframe crescer
 * com o conteúdo. A primeira altura vai na hora; as mudanças seguintes, no
 * máximo uma vez a cada 200 ms e só quando a diferença chega a 4 px.
 * Sem laço contínuo: nada roda enquanto a página não muda de tamanho.
 */

const THROTTLE_MS = 200
const MIN_DELTA_PX = 4

/**
 * A altura do conteúdo, como expressão JS (string): o maior entre a caixa do
 * `<html>` (com as margens do body) e o `scrollHeight` do `<body>` (conteúdo que
 * transborda), arredondado para cima. Não usa o `scrollHeight` do `<html>`, que
 * nunca fica abaixo do viewport. O mesmo texto serve ao script do cartão e ao
 * `contentHeight` do navegador do `check_page` (que só aceita `evaluate` com
 * string, por causa do bytecode do pkg).
 */
export const CONTENT_HEIGHT_EXPR = '(function(){var d=document.documentElement,b=document.body;'
  + 'return Math.ceil(Math.max(d?d.getBoundingClientRect().height:0,b?b.scrollHeight:0));})()'

export const HEIGHT_SCRIPT = `(function(){
var last=-1,timer=null;
function measure(){return ${CONTENT_HEIGHT_EXPR};}
function send(){
var h=measure();
if(last>=0&&Math.abs(h-last)<${MIN_DELTA_PX})return;
last=h;
parent.postMessage({type:${JSON.stringify(PAGE_HEIGHT_MESSAGE)},height:h},'*');
}
function changed(){
if(last<0){send();return;}
if(timer)return;
timer=setTimeout(function(){timer=null;send();},${THROTTLE_MS});
}
if(typeof ResizeObserver==='function'){
var ro=new ResizeObserver(changed);
ro.observe(document.documentElement);
if(document.body)ro.observe(document.body);
}else{changed();}
})();`

/** Põe o script antes do último `</body>` (sem diferenciar maiúsculas) ou, sem ele, no fim. */
export function withHeightScript(html: string): string {
  const tag = `<script id="claudinei-page-height">${HEIGHT_SCRIPT}</script>`
  let at = -1
  for (const m of html.matchAll(/<\/body\s*>/gi)) at = m.index
  return at < 0 ? html + tag : html.slice(0, at) + tag + html.slice(at)
}
