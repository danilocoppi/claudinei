// Standalone native-browser regression checks. Uses optional Playwright; no live service.
import { createRequire } from 'node:module'
import Module from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const repo=fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const require=createRequire(repo+'/package.json')
const bundle=await require('esbuild').build({entryPoints:[repo+'/web/src/indicatorMotion.ts'],bundle:true,format:'iife',globalName:'IndicatorMotion',write:false})
const css=await readFile(repo+'/web/src/styles.css','utf8')
// Render the real component: all sidebar states and both production sizes must
// keep their artwork and native animation poses when the faces are visible.
const faceBundle=await require('esbuild').build({entryPoints:[repo+'/web/src/components/AgentFace.tsx'],bundle:true,platform:'node',format:'cjs',jsx:'automatic',external:['react','react-i18next'],write:false})
const faceModule=new Module(repo+'/scripts/agent-face-fixture.cjs')
faceModule.paths=require.resolve.paths('react')
faceModule._compile(faceBundle.outputFiles[0].text,repo+'/scripts/agent-face-fixture.cjs')
await require('i18next').use(require('react-i18next').initReactI18next).init({lng:'en',resources:{en:{translation:{status:{yourTurn:'Your turn'}}}}})
const states=['idle','working','attention','waiting','uploading','sleeping','terminal','compacting']
const faces=states.map(state=>`<div style="display:flex;gap:30px;margin:12px">${[20,22].map(size=>require('react-dom/server').renderToStaticMarkup(require('react').createElement(faceModule.exports.AgentFace,{state,size,title:state}))).join('')}</div>`).join('')
const browser=await chromium.launch({...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),headless:true})
try {
 const page=await browser.newPage({viewport:{width:900,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.setContent(`<html data-theme="dark-fun" data-motion="full"><style>${css}</style><style>body{padding:30px}.sample{margin:25px;display:flex;gap:40px}.sonar-holder{position:relative;width:180px;height:35px;border-radius:12px} .chat-header{height:50px}</style><div class="chat-header"><span class="status-dot status-working"></span><span class="status-dot status-needs_attention"></span></div><div class="sample"><div class="typing"><span></span><span></span><span></span></div><span class="compacting__spinner"></span></div><div class="sample sonar-holder"><span class="sonar"><i></i><i></i></span></div><div class="sample"><span class="agent-face" data-face="working" style="--face:20px"><span class="agent-face__shadow"></span><span class="agent-face__ring"></span><span class="agent-face__sparks"><i></i><i></i><i></i></span><span class="agent-face__body"><span class="agent-face__eyes"><i class="agent-face__eye"></i><i class="agent-face__eye"></i></span></span></span></div></html>`)
 await page.addScriptTag({content:bundle.outputFiles[0].text})
 await page.locator('body').evaluate((body,html)=>body.insertAdjacentHTML('beforeend',`<aside class="sidebar" style="position:fixed;right:20px;left:auto;top:20px;width:220px;height:580px">${html}</aside>`),faces)
 assert.equal(await page.locator('.sidebar .agent-face:visible').count(),16,'Sidebar faces are hidden')
 assert.equal(await page.locator('.sidebar').evaluate(e=>getComputedStyle(e).backdropFilter),'none','Sidebar filters its entire surface')
 const before=await page.evaluate(()=>{
  const animations=document.getAnimations();window.originalAnimations=animations;window.expected=[]
  for(const a of animations){
   const e=a.effect,t=e.getTiming(),original=Number(a.currentTime??0),keys=[...new Set(e.getKeyframes().flatMap(k=>Object.keys(k)))].filter(k=>['opacity','transform','boxShadow'].includes(k));a.pause()
   const count=Math.ceil(Number(t.duration)*20/1000);const samples=[]
   for(const fraction of [.15,.35,.65,.85]){
    const time=Number(t.delay)+Number(t.duration)*Math.floor(count*fraction)/count+.01;a.currentTime=time
    const style=getComputedStyle(e.target,e.pseudoElement);samples.push({time,values:Object.fromEntries(keys.map(k=>[k,style[k]]))})
   }
   window.expected.push({animation:a,samples,timing:t,frameCount:e.getKeyframes().length});a.currentTime=original;a.play()
  }
  window.motionRafs=0;const raf=window.requestAnimationFrame;window.requestAnimationFrame=cb=>{window.motionRafs++;return raf.call(window,cb)}
  window.stopIndicatorMotion=IndicatorMotion.installIndicatorMotion();return animations.length
 })
 await page.waitForFunction(()=>window.originalAnimations.every(a=>a.effect.getKeyframes().every(f=>/^steps\(1/.test(f.easing))))
 await page.waitForTimeout(400)
 const poseResult=await page.evaluate(()=>{
  let checked=0,maxError=0;const mismatch=[]
  for(const {animation:a,samples,timing} of window.expected){
   const current=Number(a.currentTime??0);a.pause()
   for(const sample of samples){
    a.currentTime=sample.time;const style=getComputedStyle(a.effect.target,a.effect.pseudoElement)
    for(const [key,value] of Object.entries(sample.values)){
     const numbers=s=>s.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g)?.map(Number)??[]
     const expected=numbers(value),actual=numbers(style[key]);
     const delta=Math.max(0,...expected.map((v,i)=>Math.abs(v-(actual[i]??Infinity))))
     maxError=Math.max(maxError,delta);if(delta>.003||expected.length!==actual.length)mismatch.push({name:a.animationName,key,value,actual:style[key],delta})
     checked++
    }
   }
   if(a.effect.getTiming().duration!==timing.duration||a.effect.getTiming().delay!==timing.delay)throw Error('Timing changed')
   a.currentTime=current;a.play()
  }
  return {checked,maxError,mismatch}
 })
 assert.deepEqual(poseResult.mismatch,[])
 await page.waitForTimeout(3000);await page.evaluate(()=>window.motionRafs=0);await page.waitForTimeout(300)
 assert.equal(await page.evaluate(()=>window.motionRafs),0,'Unexpected continuous JavaScript frame loop')
 await page.evaluate(()=>document.querySelector('.typing').style.marginTop='2000px')
 await page.waitForFunction(()=>document.querySelector('.typing').getAnimations({subtree:true}).every(a=>a.playState==='paused'&&!a.pending))
 const paused=await page.evaluate(()=>document.querySelector('.typing').getAnimations({subtree:true}).map(a=>a.currentTime));await page.waitForTimeout(200)
 assert.deepEqual(await page.evaluate(()=>document.querySelector('.typing').getAnimations({subtree:true}).map(a=>a.currentTime)),paused)
 await page.evaluate(()=>document.querySelector('.typing').style.marginTop='0px')
 await page.waitForFunction(()=>document.querySelector('.typing').getAnimations({subtree:true}).every(a=>a.playState==='running'))
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'))})
 await page.waitForFunction(()=>document.getAnimations().every(a=>a.playState==='paused'))
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'))})
 await page.waitForFunction(()=>document.getAnimations().some(a=>a.playState==='running'))
 await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>document.getAnimations().length===0)
 await page.emulateMedia({reducedMotion:'no-preference'});await page.waitForFunction(()=>document.getAnimations().length>5&&document.getAnimations().every(a=>a.effect.getKeyframes().every(f=>/^steps\(1/.test(f.easing))))
 await page.evaluate(()=>document.documentElement.dataset.motion='reduced');await page.waitForFunction(()=>document.getAnimations().length===0)
 await page.evaluate(()=>document.documentElement.dataset.motion='full');await page.waitForFunction(()=>document.getAnimations().length>5)
 await page.evaluate(()=>document.querySelector('.status-working').className='status-dot status-idle');await page.waitForFunction(()=>document.querySelector('.status-idle').getAnimations().length===0)
 await page.evaluate(()=>document.querySelector('.status-idle').className='status-dot status-working');await page.waitForFunction(()=>document.querySelector('.status-working').getAnimations().every(a=>a.effect.getKeyframes().length>3))
 await page.evaluate(()=>{document.querySelector('.agent-face').style.setProperty('--face','32px');document.documentElement.dataset.theme='light-fun'})
 await page.waitForTimeout(300)
 const recolored=await page.evaluate(()=>{const s=document.querySelector('.sonar i'),probe=document.createElement('i');probe.style.color=getComputedStyle(s).getPropertyValue('--warn').trim();document.body.append(probe);const color=getComputedStyle(probe).color;probe.remove();return {color,shadow:s.getAnimations()[0].effect.getKeyframes()[5].boxShadow}})
 assert.ok(recolored.shadow.includes(recolored.color),'Theme color was not resampled')
 await page.evaluate(()=>window.stopIndicatorMotion())
 assert.ok(await page.evaluate(()=>document.getAnimations().every(a=>a.effect.getKeyframes().length<10)),'Cleanup did not restore CSS frames')
 assert.deepEqual(errors,[])
 const result={status:'passed',sidebarStates:states,sidebarFaces:16,sidebarSizes:[20,22],originalAnimations:before,poses:poseResult.checked,maxNumericPoseDifference:poseResult.maxError,steadyJavaScriptFrames:0,offscreenPause:true,offscreenResume:true,hiddenPause:true,osReducedMotion:true,appReducedMotion:true,stateChanges:true,themeAndSizeRebuild:true,cleanup:true,recolored,errors}
 if (process.argv[2]) await writeFile(process.argv[2],JSON.stringify(result,null,2));console.log(JSON.stringify(result))
} finally {await browser.close()}
