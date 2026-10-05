'use strict';
const cache=require('./public-financial-cache'),stocks=require('./stock-universe');
const {buildUniverse,validateTimestamp}=require('../scripts/lib/us-listings');
let batch=null,batchAt=0;const misses=new Map();
async function resolveListing(symbol,{fetchImpl=fetch,fetchReporting=require('./sec-reporting').fetchReporting}={}) {
 const known=stocks.lookup(symbol);if(known)return known;
 const key=String(symbol || '').trim().toUpperCase();if(!/^[A-Z0-9]+(?:[.-][A-Z0-9]+)?$/.test(key))return null;
 const saved=await cache.get('identity:'+key);if(saved && Date.now()-Date.parse(saved.checkedAt)<6*60*60*1000){stocks.register(saved.company);return saved.company;}
 if(Date.now()-(misses.get(key) || 0)<60000)return null;
 if(!batch || Date.now()-batchAt>6*60*60*1000) {
  batchAt=Date.now();batch=(async()=>{
   const urls=['https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt','https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt','https://www.sec.gov/files/company_tickers_exchange.json'];
   const texts=await Promise.all(urls.map(async url=>{if(new URL(url).hostname.endsWith('sec.gov'))await require('./sec-throttle').take();const response=await fetchImpl(url,{headers:require('./sec-reporting').HEADERS,signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('Authoritative directory retrieval failed');const text=await response.text();if(Buffer.byteLength(text)>8*1024*1024)throw new Error('Directory exceeds retrieval bound');return text;}));
   validateTimestamp(texts[0]);validateTimestamp(texts[1]);
   return buildUniverse(texts[0],texts[1],JSON.parse(texts[2]),[],[]);
  })().catch(e=>{batch=null;throw e;});
 }
 try {const directory=await batch;const found=directory.companies.find(c=>c.symbol.replace(/\./g,'-')===key.replace(/\./g,'-'));if(!found || found.securityType!=='stock'){misses.set(key,Date.now());while(misses.size>256)misses.delete(misses.keys().next().value);return null;}
  if(found.cik)try{const reporting=await fetchReporting({cik:found.cik,symbols:[found.symbol]});if(reporting.fundRegistrant || reporting.entityType==='investment' || reporting.sic==='6726')found.securityType='closed_end_fund';}catch(_){if(/\bfund\b|\bincome trust\b/i.test(found.name || ''))found.securityType='unresolved';}
  await cache.set('identity:'+key,{company:found,checkedAt:new Date().toISOString(),sources:directory.manifest.sources});stocks.register(found);return found;
 }catch(_){misses.set(key,Date.now());return null;}
}
module.exports={resolveListing};
