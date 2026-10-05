'use strict';
// Source and layout probes, not model evaluations. Never loads production env.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
require('./no-model-network.cjs');
Object.assign(process.env,{SEC_COVERAGE_READ_ONLY:'1',SEC_COVERAGE_DISABLE_ON_DEMAND:'1',DISABLE_BACKGROUND_JOBS:'1'});
const root=path.join(__dirname,'../..'),engine=require('../../backend/ai-chat'),policy=require('../../backend/ask-report-policy'),quality=require('../../backend/ask-answer-quality'),visual=require('../../backend/ask-visualization');
const out=process.env.ASK_QA_OUT || path.join(root,'docs/qa/ask-reports-2026-10-05');
function table(result,fields) {
 const rows=result?.observations || [];
 if(!rows.length)return 'Compatible filed history is unavailable for this section.';
 const labels={totalRevenue:'Revenue',netIncome:'Net income',grossProfit:'Gross profit',operatingIncome:'Operating income'};
 return '| Period end | '+fields.map(f=>labels[f] || f).join(' | ')+' |\n| --- | '+fields.map(()=> '---:').join(' | ')+' |\n'+rows.map(row=>'| '+row.periodEnd+' | '+fields.map(field=>{
  const observation=row.fields?.[field];return Number.isFinite(observation?.value)?(observation.unit || row.currency)+' '+observation.value:'Not disclosed';
 }).join(' | ')+' |').join('\n');
}
function printedTable(text) {
 const lines=String(text).split('\n'),head=lines.shift().split('|');
 return ['| '+head.join(' | ')+' |','| '+head.map(()=> '---').join(' | ')+' |',...lines.map(line=>'| '+line.split('|').join(' | ')+' |')].join('\n');
}
async function make(symbol,mode) {
 const start=Date.now(),p=policy.select(symbol,mode),required=policy.missingResearch(p,[]),results=[],toolsUsed=[];
 for(const r of required) {
  // Filing-diff narrative extraction is intentionally deferred with live model
  // evaluation. Other probes use the production deterministic financial tools.
  let result,args=structuredClone(r.args),reportTool=['get_financials','get_ratios_history'].includes(r.tool);
  if(reportTool){
   const selected=require('../../backend/ask-report-evidence').defaults(args.symbol,args.statement,args.basis);
   if(r.tool==='get_financials')args.fields=[...new Set([...selected.fields,...(args.fields||[])])];
   if(r.tool==='get_ratios_history')args.metrics=[...new Set([...selected.metrics,...(args.metrics||[])])];
  }
  if(r.tool==='get_key_points' || r.tool==='get_filing_diff')result={symbol,error:'Original narrative/model extraction is deferred in this offline source-and-layout review.'};
  else if(r.tool==='get_segments') {
   const company=require('../../backend/stock-universe').lookup(symbol),entry=require('../../backend/public-stock-index').view().issuers[company?.cik];
   const financial=require('../../backend/verified-fundamentals').loadIssuer(company?.cik,entry?.financialDigest);
   result=financial?.segmentObservations?.length?await engine.runTool(r.tool,args):{symbol,error:'No stored compatible segment group; live extraction is disabled in this review.'};
  } else result=await engine.runTool(r.tool,args,reportTool?{companyReportEvidence:true}:undefined);
  result=require('../../backend/ask-report-evidence').expand(result);
  results.push({tool:r.tool,result});toolsUsed.push({...r,ok:!result.error});
 }
 const gaps=policy.supplementalNeeds(p,results);
 if(gaps){const result=await engine.runTool('get_supplemental_context',gaps);results.push({tool:'get_supplemental_context',result});toolsUsed.push({tool:'get_supplemental_context',args:gaps,ok:!result.error});}
 const find=(tool,basis)=>results.find(r=>r.tool===tool && (!basis || r.result?.basis?.startsWith(basis)))?.result;
 const raw=require('../../backend/fundamentals-cache').loadRawFundamentals(symbol),overview=raw?.overview || {};
 const description=String(overview.Description || '').split(/(?<=[.!?])\s+/).filter(sentence=>!/[\d%$]/.test(sentence)).slice(0,5).join(' ');
 const segment=find('get_segments'),quarter=find('get_financials','quarterly'),annual=find('get_financials','annual');
 const quarterlyRatios=find('get_ratios_history','quarterly'),annualRatios=find('get_ratios_history','annual'),quote=find('get_quote');
 const paragraphs=[
  `# ${p.company.name} (${symbol})`,
  '**Review fixture:** assembled deterministically from production data tools. This is not a model-generated investment report. It demonstrates the report policy, financial tables and product renderer without spending model quota.',
  '## What the business does',
  description?description+'\n\nBusiness-description source: stored Yahoo Finance profile; its original retrieval date is unavailable in this legacy cache. A customer report must check official publications or retrieve a dated profile before treating it as current.':'A usable stored business description is unavailable. The live request must seek official business disclosures and a dated Yahoo Finance profile before describing customers and products.',
  '## Customers, products and revenue streams',
  'An investor needs to understand who buys the company’s products, how those customers use them and which divisions earn the revenue. The financial statements establish reported company totals. They do not, by themselves, establish the product mix, recurring nature of sales or bargaining power of individual customers. Those explanations require the supplied original business disclosure.',
  segment?.sankeyEvidence?.status==='eligible'?'Compatible segment observations are available from the original annual disclosure. The model may choose their table, a bar comparison or a reconciled revenue Sankey.':'The offline probe does not establish a complete division or segment breakdown. That remains a specific disclosure gap; no division share is estimated from a company total.',
  '## Four reported quarters',table(quarter,['totalRevenue','grossProfit','operatingIncome','netIncome']),
  'The quarter table uses actual fiscal period ends and the reported currency. This matters when a company’s financial year differs from the calendar year. A directly reported quarter and a compatible derived quarter are observations with different evidence paths. The derivation retains its source inputs. Missing history stays unavailable and a reported zero remains a valid value.',
  quarterlyRatios?.table?'Quarterly calculated margins, using compatible observations:\n\n'+printedTable(quarterlyRatios.table):'Compatible quarterly ratios are unavailable; no annual ratio is substituted for a quarter.',
  '## Five annual periods',table(annual,['totalRevenue','grossProfit','operatingIncome','netIncome']),
  'The annual history places the most recent quarter in a longer financial context. Revenue measures the amount the business earned from its customers. Gross profit is what remains after the associated direct costs. Operating income reflects operating expenses as well. Net income includes further items such as financing and taxes. These definitions help a Simple reader interpret the same evidence that an Analyst reader receives.',
  'A chart shows the direction and shape of that history; the table preserves exact values. The model may use a line or bars for a comparable annual series. When metrics are very different in size, separate bar panels preserve readable values. Different currencies and accounting definitions remain separate. A dated provider series may fill an otherwise unavailable annual chart, with its source named visibly.',
  '## Competitive differences',
  'Peer positioning is useful only when the companies and metrics are comparable. A sector median supplies context rather than a conclusion about the business. The production peer tool provides an industry profile so the final model can choose the relevant measures and explain their limits. A bank, semiconductor designer and property owner should not be judged by an identical generic set of ratios.',
  '## Material risks',
  'Company-specific risk explanations require original disclosures or fetched reputable articles. Statement history can reveal a financial pattern, but it does not establish the cause of that pattern. The offline probe makes no unsupported claim about a customer, product, regulatory proceeding or future outcome. A live report must retrieve that context and distinguish observed history from an uncertain explanation.',
  '## Dated valuation',
  quote?.price!==null && Number.isFinite(quote?.price)?`Stored quote: ${quote.currency || 'currency unavailable'} ${quote.price}, as of ${quote.priceAsOf || quote.asOf || 'date unavailable'}. Source: ${quote.priceSource || 'cached market snapshot'}.`:'A compatible dated market quote is unavailable in this offline probe. Live quote retrieval is required before presenting price-derived valuation as current.',
  'Market prices and financial statements have different clocks. A dated close is useful evidence and should keep its actual timestamp, including when a market is closed or a provider is unavailable. A valuation multiple also needs compatible financial inputs. Missing per-share evidence cannot be repaired by attaching an issuer’s unverified share-class figure to the requested listing.',
  '**The read** — The displayed tables and chart can be checked against supplied observations. The business, competitive and risk discussion still needs original context where the offline cache leaves a gap. This fixture verifies the mechanics and layout; live model response quality remains a separate, deferred check.',
  '> Next: Which reported business division drives the revenue trend?'
 ];
 if(mode==='analyst' && annual?.observations?.length>=2){
  const currency=annual.currency,fields=['totalRevenue','netIncome'],labels=['Revenue','Net income'];
  const chart={title:'Annual revenue and net income',unit:currency,series:fields.map((field,i)=>({name:labels[i],points:annual.observations.slice().reverse().map(o=>[o.periodEnd,Number.isFinite(o.fields?.[field]?.value) && o.fields[field].unit===currency?o.fields[field].value:null])}))};
  paragraphs.splice(paragraphs.indexOf('## Competitive differences'),0,'```viz\n'+JSON.stringify(chart)+'\n```');
 }
 if(mode==='analyst' && segment?.sankeyEvidence?.status==='eligible' && segment.sankeyEvidence.segments.length<=8){
  const evidence=segment.sankeyEvidence;
  const chart={title:'Reported revenue streams',unit:evidence.currency,periodEnd:evidence.periodEnd,filingDate:evidence.filingDate,accessionNumber:evidence.accessionNumber,sourceUrl:evidence.sourceUrl,total:evidence.totalRevenue,unallocated:evidence.unallocated,segments:evidence.segments};
  paragraphs.splice(paragraphs.indexOf('## Four reported quarters'),0,'```sankey\n'+JSON.stringify(chart)+'\n```');
 }
 const answer=visual.ensure(quality.normalizeFacetedViz(paragraphs.join('\n\n')),results,{...p,question:symbol});
 const findings=quality.audit(answer,results,{question:symbol,mode,policy:p});
 const receipt={fixture:true,question:symbol,mode,answer,source:findings.length?'partial':'ai',toolsUsed,totalTokens:0,ms:Date.now()-start,generatedAt:new Date().toISOString(),quality:{policy:p,policyVersion:policy.VERSION,proseWords:quality.wordCount(answer),tableRows:(answer.match(/^\s*\|.*$/gm)||[]).length,sectionCoverage:policy.coverage(answer),auditFindings:findings,sourceAttempts:results.flatMap(r=>r.result?.sourceAttempts || []),remainingGaps:results.flatMap(r=>r.result?.remainingGaps || r.result?.coverage?.remainingGaps || (r.result?.error?[{tool:r.tool,reason:r.result.error}]:[]))}};
 assert.deepEqual(findings,[],`${symbol} ${mode}: ${findings.join('; ')}`);
 return receipt;
}
async function main() {
 fs.mkdirSync(out,{recursive:true});const probes=[];
 for(const symbol of ['AVGO','AMD','JPM','PFE','WMT','O','TSM','BRAI'])for(const mode of ['normal','analyst']){
  const receipt=await make(symbol,mode);fs.writeFileSync(path.join(out,symbol.toLowerCase()+'-'+mode+'-ticker.json'),JSON.stringify(receipt,null,2));
  const name={AVGO:'Broadcom',AMD:'Advanced Micro Devices',JPM:'JPMorgan'}[symbol];
  if(name)fs.writeFileSync(path.join(out,symbol.toLowerCase()+'-'+mode+'-name.json'),JSON.stringify({...receipt,question:name,quality:{...receipt.quality,policy:policy.select(name,mode)}},null,2));
  probes.push({symbol,mode,proseWords:receipt.quality.proseWords,tableRows:receipt.quality.tableRows,charts:visual.specs(receipt.answer).length,auditFindings:receipt.quality.auditFindings,remainingGapCount:receipt.quality.remainingGaps.length});
 }
 // Determinism checks for the two formerly failing representative companies.
 for(const symbol of ['AVGO','AMD'])assert.equal((await make(symbol,'analyst')).answer,JSON.parse(fs.readFileSync(path.join(out,symbol.toLowerCase()+'-analyst-ticker.json'))).answer);
 const summary={kind:'Deterministic source/layout probes; not live model evaluations',modelCalls:0,providerCalls:0,probes};
 fs.writeFileSync(path.join(out,'offline-probes.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
}
if(require.main===module)main().catch(error=>{console.error(error.stack);process.exitCode=1;});module.exports={make,main};
