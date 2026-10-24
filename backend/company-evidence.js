'use strict';
const p=require('./sec-coverage');
const obs=require('./company-observations');
const stocks=require('./stock-universe');
const verified=require('./verified-fundamentals');
const requestCache=require('./public-financial-cache');
const client=require('./sec-reporting');
const {extract,EXTRACTION_VERSION,VALIDATION_VERSION}=require('./sec-facts');
const SIX_HOURS=6*60*60*1000,FAILURE_COOLDOWN=60*1000;
const identity=company=>p.cik(company.cik) || 'listing:'+company.symbol.replace(/\./g,'-');
function createResolver(deps={}) {
 const cache=deps.cache || requestCache,network=deps.client || client,lookup=deps.lookup || stocks.lookup;
 const pending=new Map();let calls=[];
 // issuer -> the last background check that succeeded and found the stored
 // filings still current. The state cache holds only a few ~3 MB issuers, so
 // without this every reader re-ran the whole SEC check for gaps that no
 // filing will ever fill (KO, PEP, MSFT each carry 4).
 const checked=new Map();
 function baseline(company) {
  if(deps.baseline)return deps.baseline(company);
  const index=require('./public-stock-index').view();const entry=index.issuers[p.cik(company.cik)];
  const data=verified.loadIssuer(p.cik(company.cik),entry?.financialDigest || entry?.evidence?.financialDigest);
  const supplemental=require('./committed-supplements').forIssuer(identity(company));
  return {financial:data,reporting:{...require('./company-reporting').get(company.cik,index),...entry?.evidence},supplemental,attempts:[]};
 }
 function projection(company,state,fields,periods) {
  const filed=obs.observations(state.financial),supplemental=obs.reconcile(filed,(state.supplemental || []).filter(f=>obs.validSupplement(f,identity(company))));
  const usable=supplemental.filter(f=>f.state==='available');
  let raw=null;try{raw=require('./fundamentals-cache').loadRawFundamentals(company.symbol);}catch(_){}
  const data=verified.adapt(company,raw,state.financial,{financialCoverage:p.classify(state.reporting,state.financial).financialCoverage,annualReportingStatus:p.reportingStatus(state.reporting)}, {evidence:state.reporting,financialDigest:state.financial?p.digest(state.financial):null});
  if(state.profile)for(const key of ['Description','Industry','Website','Country'])if(!data.overview[key] && state.profile.overview?.[key])data.overview[key]=state.profile.overview[key];
  if(!data.overview.Sector && state.profile?.overview?.Sector)data.overview.Sector=require('./sector').canonical(state.profile.overview.Sector) || '';
  data.businessProfile=state.profile || null;data.segmentObservations=state.financial?.segmentObservations || [];
  data.supplementalObservations=usable;data.industryObservations=filed.filter(f=>f.verificationMethod==='reviewed_filing_table');data.sourceAttempts=state.attempts || [];
  data.compatibleCalculations=require('./company-calculations').calculate([...filed,...usable]);
  const remaining=obs.gaps([...filed,...usable],fields,periods,state.reporting?.reportingCadence,state.reporting);
  for(const gap of remaining){const conflicts=supplemental.filter(f=>f.field===gap.field && f.state==='conflicting_evidence');if(conflicts.length){gap.state='conflicting_evidence';gap.reason='Compatible sources disagree; conflicting observations were withheld';gap.sources=conflicts.flatMap(f=>f.conflictingSources || [f.sourceUrl]);}else{gap.sourcesAttempted=(state.attempts || []).map(a=>({source:a.source,status:a.status,reason:a.reason || null}));if(gap.sourcesAttempted.length && gap.sourcesAttempted.every(a=>a.status==='retrieval_failed')){gap.state='retrieval_failed';gap.reason='All attempted sources failed; last-good observations were retained';}}}
  const stableSources=Object.fromEntries(Object.entries(state.financial?.sources || {}).map(([id,source])=>{const {retrievedAt,...stable}=source;return [id,stable];}));
  const digest=p.digest({extractionVersion:state.financial?.extractionVersion,validationVersion:state.financial?.validationVersion,financial:state.financial?.factsDigest,sources:stableSources,supplemental:usable.map(f=>({key:obs.key(f),value:f.value,versions:f.sourceVersions}))});
  data.coverage={...data.coverage,sic:state.reporting?.sic || data.coverage.sic || null,fields,periods,remainingGaps:remaining,sourceAttempts:data.sourceAttempts};
  data.freshness={lastSuccessfulCheckAt:state.reporting?.lastSuccessfulCheckAt || null,lastAttemptAt:state.lastAttemptAt || state.reporting?.lastFinancialAttemptAt || state.reporting?.lastAttemptAt || null,lastAttemptResult:state.lastAttemptResult || (['transient_failure','invalid_identity'].includes(state.reporting?.lastAttemptResult)?'retrieval_failed':state.reporting?.lastFinancialResult==='transient_failure'?'partial_failure':state.reporting?.lastAttemptResult || null),financialAttemptResult:state.financialAttemptResult || state.reporting?.lastFinancialResult || null,lastFinancialCheckAt:state.reporting?.lastFinancialCheckAt || state.financial?.fetchedAt || null,backgroundStatus:pending.has(identity(company))?'running':'idle',persistence:state.persistence || null};
  data.provenance.evidenceFingerprint=digest;
  try{const req=require('./financial-requirements').requirements(data.overview,state.reporting?.sic);data.coverage.industry={...req,metrics:req.industry.map(field=>({field,state:[...filed,...usable].some(f=>f.field===field)?'available':'missing',reason:[...filed,...usable].some(f=>f.field===field)?null:'A compatible original disclosure or supplemental observation has not been extracted'}))};}catch(_){}data.provenance.extractionVersion=state.financial?.extractionVersion || 'legacy';
  return {symbol:company.symbol,cik:company.cik,securityType:company.securityType,statements:state.financial,observations:filed,supplementalObservations:usable,marketData:data.marketData,coverage:data.coverage,freshness:data.freshness,remainingGaps:remaining,evidenceFingerprint:digest,data};
 }
 async function supplement(company,state,fields,periods) {
  const attempted=new Date().toISOString(),attempts=[];let profile=state.profile || null;let financial=state.financial,reporting=state.reporting || {},supplemental=state.supplemental || [],success=false,financialAttemptResult='not_required';
  const issuer={cik:p.cik(company.cik),symbols:[company.symbol]};
  const originalDocuments=new Map();
  function fetchOriginal(filing){if(!filing?.accessionNumber)return Promise.reject(Object.assign(new Error('No applicable original financial filing was identified'),{code:'ORIGINAL_FILING_UNAVAILABLE'}));if(!originalDocuments.has(filing.accessionNumber))originalDocuments.set(filing.accessionNumber,Promise.resolve().then(()=>(network.fetchOriginal || require('./sec-original').fetchOriginal)(issuer.cik,filing)));return originalDocuments.get(filing.accessionNumber);}

  try {
   if(!issuer.cik)throw Object.assign(new Error('The exchange listing has no confirmed SEC CIK; provider observations remain linked to this listing'),{code:'SEC_IDENTITY_UNRESOLVED'});
   const newer=await network.fetchReporting(issuer);reporting={...reporting,...newer};success=true;
   const changed=reporting.latestPeriodic?.accessionNumber!==state.reporting?.latestPeriodic?.accessionNumber || reporting.latestAnnual?.accessionNumber!==state.reporting?.latestAnnual?.accessionNumber || p.digest(reporting.latestAnnual?.amendments || [])!==p.digest(state.reporting?.latestAnnual?.amendments || []);
   const missing=obs.gaps(obs.observations(financial),fields,periods,reporting.reportingCadence,reporting);
   const mapped=field=>Object.values(require('./sec-facts').MAPS).some(defs=>defs[field]);
   if(changed || missing.some(g=>mapped(g.field)) || financial?.extractionVersion!==EXTRACTION_VERSION || financial?.validationVersion!==VALIDATION_VERSION) {
    financialAttemptResult='retrieval_failed';
    let raw;try{raw=await network.fetchFacts(issuer.cik);}catch(e){if(e.response?.status!==404 || !reporting.latestAnnual)throw e;raw={cik:Number(issuer.cik),facts:{}};}financial=extract(raw,reporting);
    if(!changed){financial.industryObservations=state.financial?.industryObservations || [];financial.segmentObservations=state.financial?.segmentObservations || [];financial.industryExtraction=state.financial?.industryExtraction;if(state.financial?.operatingExpenseLines)financial.operatingExpenseLines=state.financial.operatingExpenseLines;}
    const coreMissing=obs.gaps(obs.observations(financial),fields,{annual:1,quarterly:0}).some(g=>mapped(g.field));
    if(coreMissing || financial.issues.some(i=>i.code==='AMBIGUOUS_CURRENCY') || (financial.industryExtraction?.sourceVersion!==reporting.latestAnnual?.accessionNumber && require('./sec-industry-tables').REGISTRY[issuer.cik])) {
     try{const original=await fetchOriginal(reporting.latestAnnual);raw=require('./sec-original').mergeFacts(raw,original);reporting.reportingCurrency=original.reportingCurrency || reporting.reportingCurrency;financial=extract(raw,reporting);attempts.push({source:'SEC original filing',status:'success',url:original.originalDocument.url});}
     catch(e){attempts.push({source:'SEC original filing',status:'retrieval_failed',reason:String(e.code || e.message).slice(0,120)});}
    }
    const interimMissing=Number(periods.quarterly)>0 && /^(10-Q)(\/A)?$/.test(reporting.latestPeriodic?.form || '') && obs.gaps(obs.observations(financial),fields,periods,reporting.reportingCadence,reporting).some(g=>g.basis==='quarterly' && mapped(g.field));
    if(interimMissing){try{const original=await fetchOriginal(reporting.latestPeriodic);raw=require('./sec-original').mergeFacts(raw,original);financial=extract(raw,reporting);attempts.push({source:'SEC original interim filing',status:'success',url:original.originalDocument.url});}catch(e){attempts.push({source:'SEC original interim filing',status:'retrieval_failed',reason:String(e.code || e.message).slice(0,120)});}}
    financial=require('./sec-last-good').preserveSameFiling(financial,state.financial,reporting);
    const errors=p.validateFinancial(financial,company.cik);if(errors.length)throw new Error('INVALID_EXTRACTION');
    const candidateFacts=obs.observations(financial),oldFacts=obs.observations(state.financial);
    if(oldFacts.some(f=>!candidateFacts.some(n=>n.field===f.field && n.periodEnd===f.periodEnd && n.historyBasis===f.historyBasis && n.unit===f.unit)))throw new Error('EXTRACTION_HISTORY_REGRESSION');
    financialAttemptResult='success';
   }
   attempts.push({source:'SEC',status:'success'});
  }catch(e){financial=state.financial;attempts.push({source:'SEC',status:'retrieval_failed',reason:String(e.code || e.response?.status || e.message).slice(0,120)});}
  if(financial && reporting.latestAnnual && financial.industryExtraction?.sourceVersion!==reporting.latestAnnual.accessionNumber && (!deps.client || network.fetchOriginal)) {
   try{const document=await fetchOriginal(reporting.latestAnnual);financial=require('./sec-industry').enrich(financial,document,reporting);attempts.push({source:'SEC industry and segment disclosures',status:'success',url:document.originalDocument.url});}
   catch(e){attempts.push({source:'SEC industry and segment disclosures',status:'retrieval_failed',reason:String(e.code || e.message).slice(0,120)});}
  }
  const filed=obs.observations(financial);
  if(reporting.latestEarningsRelease || /^6-K/.test(reporting.latestPeriodic?.form || '')) {
   try{const release=await (network.fetchRelease || require('./issuer-release').fetchRelease)(issuer.cik,reporting.latestEarningsRelease || reporting.latestPeriodic,fields,{sic:reporting.sic});supplemental.push(...release.observations);attempts.push(...release.attempts);}catch(e){attempts.push({source:'Official issuer release',status:'retrieval_failed',reason:String(e.code || e.response?.status || e.message).slice(0,120)});}
  }
  const missing=obs.gaps([...filed,...supplemental.filter(f=>f.state==='available')],fields,periods,reporting.reportingCadence,reporting);
  let profileMissing=!profile;try{const raw=require('./fundamentals-cache').loadRawFundamentals(company.symbol);profileMissing=!profile && !raw?.overview?.Description;}catch(_){}
  if(missing.length || profileMissing || (periods.businessProfile && !profile)) {
   const sections=[...new Set(missing.map(g=>Object.entries(require('./sec-facts').MAPS).find(([,defs])=>defs[g.field])?.[0]).filter(Boolean))];
   try{
    const live=await (deps.yahoo || require('./yahoo-source').fetchSupplementalSnapshot)(company.symbol,sections);
    if(!issuer.cik)success=true;
    profile={overview:live.overview,sourceName:'Yahoo Finance',sourceUrl:'https://finance.yahoo.com/quote/'+encodeURIComponent(company.symbol)+'/profile/',retrievedAt:live.fetchedAt};
    for(const [statement,history]of Object.entries(live.statements || {}))for(const [kind,rows]of Object.entries(history))for(const row of rows.slice(0,Math.min(48,Number(periods[kind==='annualReports'?'annual':'quarterly'] || 0))))for(const field of fields) {
     const value=p.number(row[field]);if(value===null || !/^[A-Z]{3}$/.test(row.reportedCurrency || '') || /EPS|^eps$|Shares/.test(field))continue;
     const f={issuer:identity(company),securitySymbol:company.symbol,field,definition:obs.definitions[field] || field,value,scale:1,unit:row.reportedCurrency,currency:row.reportedCurrency,periodStart:row.periodStart || null,periodEnd:row.fiscalDateEnding,basis:statement==='balance'?'instant':kind==='annualReports'?'annual':'quarterly',historyBasis:kind==='annualReports'?'annual':'quarterly',periodDefinition:'Yahoo Finance fiscal '+(kind==='annualReports'?'annual':'quarterly')+' period ending on the provider date; start not supplied',accountingBasis:'provider-reported',scope:'entity',statement,sourceType:'provider',sourceName:'Yahoo Finance',sourceUrl:'https://finance.yahoo.com/quote/'+encodeURIComponent(company.symbol)+'/'+({income:'financials',balance:'balance-sheet',cash:'cash-flow'})[statement]+'/',publicationDate:null,sourceDataDate:live.fetchedAt?.slice(0,10),sourceDateKind:'retrieval',retrievedAt:live.fetchedAt,sourceVersions:[p.digest(row)],verificationMethod:'structured_provider',extractionVersion:EXTRACTION_VERSION,state:'available'};
     f.sourceIds=['provider:'+p.digest({issuer:f.issuer,field:f.field,periodEnd:f.periodEnd,version:f.sourceVersions}).slice(0,24)];
     if(obs.validSupplement(f,identity(company)) && !filed.some(old=>old.field===f.field && old.periodEnd===f.periodEnd && old.unit===f.unit && old.historyBasis===f.historyBasis))supplemental.push(f);
    }
    attempts.push({source:'Yahoo Finance',status:'success',remainingProviderGaps:live.errors || []});
   }catch(e){attempts.push({source:'Yahoo Finance',status:'retrieval_failed',reason:String(e.code || e.message).slice(0,120)});}
  }
  supplemental=obs.reconcile(filed,supplemental);
  const next={financial,reporting,supplemental,profile,attempts,lastAttemptAt:attempted,attemptedFields:fields,financialAttemptResult,lastAttemptResult:success?(attempts.some(a=>a.status==='retrieval_failed')?'partial_failure':'success'):'retrieval_failed'};
  if(!issuer.cik && profile?.retrievedAt)next.providerLastSuccessfulCheckAt=profile.retrievedAt;
  next.persistence=await cache.set(identity(company),next);return next;
 }
 // opts.waitMs: how long a caller holding stored financials waits for the
 // background check. Pages pass 0 and show what is stored (the check still runs
 // and the next request gets its result); a listing with nothing stored always
 // waits, so its first view is not empty.
 async function getCompanyEvidence(symbol,requiredFields=null,requestedPeriods={annual:5,quarterly:4},checkFreshness=true,opts={}) {
  const company=lookup(symbol) || (checkFreshness && !deps.lookup?await stocks.resolveListing(symbol):null);if(!company)throw Object.assign(new Error('Listing identity is unresolved'),{code:'UNKNOWN_LISTING',status:404});
  if(company.securityType!=='stock')throw Object.assign(new Error('Use the separate fund or instrument data pathway'),{code:'UNSUPPORTED_SECURITY_TYPE',status:422});
  const quoteTask=checkFreshness && (deps.quote || !deps.client)?Promise.resolve().then(()=> (deps.quote || require('./quote-store').getQuote)(company.symbol,{allowLive:true,useLegacySecShares:false})).catch(()=>null):Promise.resolve(null);
  let state=baseline(company);
  if(!requiredFields){let overview={Sector:company.sector};try{overview={...overview,...require('./fundamentals-cache').loadRawFundamentals(company.symbol)?.overview};}catch(_){}const requirements=require('./financial-requirements').requirements(overview,state.reporting?.sic);requiredFields=[...new Set([...requirements.core,...requirements.industry])];}
  const saved=await cache.get(identity(company));
  if(saved && Date.parse(saved.reporting?.lastSuccessfulCheckAt || saved.providerLastSuccessfulCheckAt || 0)>=Date.parse(state.reporting?.lastSuccessfulCheckAt || state.providerLastSuccessfulCheckAt || 0) && (!saved.financial || !p.validateFinancial(saved.financial,company.cik).length))state={...state,...saved};
  let result=projection(company,state,requiredFields,requestedPeriods);
  const now=Date.now(),last=Date.parse(state.reporting?.lastSuccessfulCheckAt || state.providerLastSuccessfulCheckAt || ''),failed=now-Date.parse(state.lastAttemptAt || '')<FAILURE_COOLDOWN && requiredFields.every(f=>(state.attemptedFields || []).includes(f));
  const seen=checked.get(identity(company)),current=seen && now-seen.at<SIX_HOURS && requiredFields.every(f=>seen.fields.includes(f)) && ['annual','quarterly'].every(b=>(seen.periods[b] || 0)>=(requestedPeriods[b] || 0));
  if(checkFreshness && !failed && ((!current && (!Number.isFinite(last) || now-last>SIX_HOURS || result.remainingGaps.length)) || (requestedPeriods.businessProfile && !result.data.businessProfile))) {
   let task=pending.get(identity(company));
   if(task){for(const field of requiredFields)if(!task.requestedFields.includes(field))task.requestedFields.push(field);for(const basis of ['annual','quarterly'])task.requestedPeriods[basis]=Math.max(task.requestedPeriods[basis] || 0,requestedPeriods[basis] || 0);if(requestedPeriods.businessProfile)task.requestedPeriods.businessProfile=true;}
   if(!task){calls=calls.filter(t=>now-t<600000);if(pending.size>=2 || calls.length>=60){result.freshness.backgroundStatus='capacity_limited';return applyQuote(result,await quoteTask);}calls.push(now);const fields=[...requiredFields],periods={...requestedPeriods};task=supplement(company,state,fields,periods).finally(()=>pending.delete(identity(company)));task.requestedFields=fields;task.requestedPeriods=periods;pending.set(identity(company),task);
    const before=state.reporting,covered={fields:[...fields],periods:{...periods}};task.then(next=>{const same=k=>next.reporting?.[k]?.accessionNumber===before?.[k]?.accessionNumber;if(next.lastAttemptResult==='retrieval_failed' || !same('latestPeriodic') || !same('latestAnnual'))return checked.delete(identity(company));if(checked.size>=5000)checked.delete(checked.keys().next().value);checked.set(identity(company),{at:Date.now(),...covered});},()=>{});}
   const waitMs=state.financial?(opts.waitMs ?? deps.timeoutMs ?? 15000):(deps.timeoutMs ?? 15000);
   let timer;const completed=waitMs>0?await Promise.race([task,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),waitMs);})]):null;clearTimeout(timer);
   if(completed)result=projection(company,completed,requiredFields,requestedPeriods);
   else {result.freshness.backgroundStatus='running';result.data.freshness=result.freshness;}
  }
  return applyQuote(result,await quoteTask);
 }
 function applyQuote(result,quote) {
  if(quote?.asOf){const q={...quote,source:quote.source==='live'?'Yahoo Finance':quote.source,financialSource:false};if(!result.data.coverage.perShareAllowed){q.trailingPE=null;q.forwardPE=null;q.sharesOutstanding=null;}result.marketData=q;result.data.marketData=q;Object.assign(result.data.overview,{MarketCapitalization:p.number(q.marketCap),PERatio:p.number(q.trailingPE),ForwardPE:p.number(q.forwardPE),DividendYield:p.number(q.dividendYield),SharesOutstanding:p.number(q.sharesOutstanding),'52WeekHigh':p.number(q.fiftyTwoWeekHigh),'52WeekLow':p.number(q.fiftyTwoWeekLow)});}
  return result;
 }
 return {getCompanyEvidence,pending,baseline};
}
module.exports={createResolver,SIX_HOURS,FAILURE_COOLDOWN,...createResolver()};
