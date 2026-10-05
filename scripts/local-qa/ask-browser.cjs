'use strict';
// Review the actual production Markdown/chart renderer using saved source
// fixtures. The loopback harness must already be running in --offline mode.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base=process.env.ASK_REVIEW_BASE || 'http://127.0.0.1:5058';
const out=process.env.ASK_QA_OUT || path.join(__dirname,'../../docs/qa/ask-reports-2026-10-05');
async function main(){
 const health=await fetch(base+'/api/health').then(r=>r.json());assert.equal(health.offline,true,'Generation must be disabled during visual QA');
 assert.equal((await fetch(base+'/api/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:'AMD'})})).status,409);
 const browser=await chromium.launch({executablePath:process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true}),results=[];
 try{for(const width of [1100,390]){
  const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  await page.goto(base);await page.waitForFunction(()=>window.__reviewReady===true);
  for(const symbol of ['avgo','amd','jpm','pfe','wmt','o','tsm','brai'])for(const mode of ['normal','analyst']){
   const id=symbol+'-'+mode+'-ticker';await page.selectOption('#company-example',id);
   const measured=await page.evaluate(()=>{
    const answer=document.querySelector('#company-output .ask-a'),svgs=[...answer.querySelectorAll('svg')],tables=[...answer.querySelectorAll('table')];
    return {viewport:innerWidth,scroll:document.documentElement.scrollWidth,chartCount:svgs.length,tableCount:tables.length,
      invalidGeometry:svgs.some(svg=>/NaN|Infinity|undefined/.test(svg.innerHTML)),metadata:document.querySelector('#company-output .review-meta').textContent,
      readMarker:!!answer.querySelector('.ask-read'),nextQuestion:!!answer.querySelector('.ask-next'),visibleText:answer.textContent};
   });
   assert.ok(measured.scroll<=width+1,`${id} ${width}: page overflow ${measured.scroll}`);assert.equal(measured.invalidGeometry,false);
   assert.match(measured.metadata,/Deterministic fixture/);assert.match(measured.metadata,/company_report/);
   if(symbol==='brai'){assert.equal(measured.chartCount,0);assert.match(measured.visibleText,/unavailable/);}else assert.ok(measured.chartCount>=1,`${id}: missing source-supported visual`);
   assert.ok(measured.tableCount>= (symbol==='brai'?0:1));assert.equal(measured.readMarker,true,`${id}: synthesis marker`);assert.equal(measured.nextQuestion,true,`${id}: follow-up marker`);
   if(['avgo','amd'].includes(symbol) && mode==='analyst'){
    await page.screenshot({path:path.join(out,symbol+'-'+width+'.png'),fullPage:true});
    await page.locator('#company-output .ask-viz').first().screenshot({path:path.join(out,symbol+'-chart-'+width+'.png')});
   }
   const {visibleText,...receipt}=measured;results.push({width,id,...receipt});
  }
  assert.deepEqual(errors,[]);await context.close();
 }}finally{await browser.close();}
 const receipt={kind:'Local browser QA of saved deterministic fixtures',modelCalls:0,providerCalls:0,authenticatedProduction:false,scriptErrors:[],generationBlocked:true,results};
 fs.writeFileSync(path.join(out,'browser-receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({checks:results.length,modelCalls:0,overflowFailures:0,scriptErrors:0}));
}
if(require.main===module)main().catch(error=>{console.error(error.stack);process.exitCode=1;});module.exports={main};
