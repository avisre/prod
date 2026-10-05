'use strict';
const {Parser}=require('htmlparser2');
const p=require('./sec-coverage');
// Issuer-specific reviewed definitions. No tag-name or row-label similarity.
const REGISTRY={
 '0000726728':{
  ffo:{label:'FFO available to common stockholders',definition:'Realty Income FFO available to common stockholders; issuer Nareit reconciliation',start:'Net income available to common stockholders'},
  affo:{label:'AFFO available to common stockholders',definition:'Realty Income adjusted FFO available to common stockholders; issuer reconciliation',start:'Normalized FFO available to common stockholders'}
 }
};
function tablesFrom(text) {
 const tables=[],stack=[];let table=null,row=null,cell=null,tail='';
 new Parser({
  onopentag(n){if(n==='table'){stack.push({table,row,cell});table={caption:tail.slice(-1500),rows:[]};row=null;cell=null;}if(n==='tr')row=[];if(['td','th'].includes(n))cell='';},
  ontext(t){tail=(tail+' '+t).slice(-2000);if(cell!==null)cell+=t;},
  onclosetag(n){if(['td','th'].includes(n)&&cell!==null){row?.push(cell.trim().replace(/\s+/g,' '));cell=null;}if(n==='tr'&&row){table?.rows.push(row);row=null;}if(n==='table'&&table){if(table.rows.length<150)tables.push(table);const previous=stack.pop() || {};table=previous.table;row=previous.row;cell=previous.cell;}}
 },{decodeEntities:true}).end(text);
 return tables;
}
function numericCells(row) {return row.map(v=>v.trim()).filter(v=>/^\(?-?\d[\d,]*(?:\.\d+)?\)?$/.test(v)).map(v=>Number(v.replace(/[,()]/g,''))*(v.startsWith('(')?-1:1));}
function extractTables(text,filing,cik,financial) {
 const registry=REGISTRY[p.cik(cik)];if(!registry)return [];
 const out=[];
 for(const table of (Array.isArray(text)?text:tablesFrom(text))) {
  if(!/reconciliation/i.test(table.caption) || !/in thousands, except per share/i.test(table.caption))continue;
  const yearRows=table.rows.filter(row=>row.some(c=>/^20\d\d$/.test(c)) && row.filter(c=>c).every(c=>/^20\d\d$/.test(c)));
  if(yearRows.length!==1)continue;const years=yearRows[0].filter(c=>c);
  for(const [field,def]of Object.entries(registry)) {
   const finish=table.rows.findIndex(row=>row.find(c=>c)===def.label);
   const start=table.rows.findIndex(row=>row.find(c=>c)===def.start);if(start<0 || finish<=start)continue;
   const target=numericCells(table.rows[finish]);if(target.length!==years.length)continue;
   const relevant=table.rows.slice(start,finish).map(row=>({label:row.find(c=>c),values:numericCells(row)})).filter(r=>r.values.length);
   const complete=relevant.every(r=>r.values.length===years.length);
   if(complete && target.some((v,i)=>Math.abs(relevant.reduce((sum,row)=>sum+row.values[i],0)-v)>0.5))continue;
   for(let i=0;i<years.length;i++) {
    const annual=financial.income.annualReports.filter(r=>r.fiscalDateEnding.startsWith(years[i]) && r.reportedCurrency==='USD' && p.verifiedField(financial,r,'netIncome'));
    if(annual.length!==1 || !(annual[0]._sources.netIncome || []).some(id=>financial.sources[id].accessionNumber===filing.accessionNumber))continue;
    out.push({issuer:p.cik(cik),field,definition:def.definition,value:target[i]*1000,scale:1,unit:'USD',currency:'USD',periodStart:annual[0].periodStart,periodEnd:annual[0].fiscalDateEnding,basis:'annual',historyBasis:'annual',accountingBasis:'issuer-defined non-GAAP',scope:'common_stockholders',sourceType:'sec_filing',sourceName:'SEC original filing',sourceUrl:filing.documentUrl,publicationDate:filing.filingDate,retrievedAt:new Date().toISOString(),sourceVersions:[filing.accessionNumber],sourceIds:[p.digest({cik,field,year:years[i],filing:filing.accessionNumber})],verificationMethod:'reviewed_filing_table',extractionVersion:'20261005-industry1',reconciliation:{status:complete?'reconciled':'reported_table_with_undefined_inputs',inputRows:complete?relevant.map(r=>({label:r.label,value:r.values[i]*1000})):[],reportedValue:target[i]*1000,precision:1000,caption:table.caption,tableRows:table.rows,tableDigest:p.digest(table.rows),column:i,reason:complete?null:'Dashes or missing cells remain undefined; the reported AFFO value is retained without a reconstructed sum'},state:'available'});
   }
  }
 }
 return out;
}
function validObservation(f,cik) {
 const def=REGISTRY[p.cik(cik)]?.[f?.field];if(!def || f.definition!==def.definition || f.verificationMethod!=='reviewed_filing_table' || f.accountingBasis!=='issuer-defined non-GAAP' || f.scope!=='common_stockholders' || f.unit!=='USD')return false;
 if(!require('./company-observations').validSupplement(f,cik) || !f.sourceVersions?.length || !f.reconciliation?.tableRows || p.digest(f.reconciliation.tableRows)!==f.reconciliation.tableDigest)return false;
 const expected=`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${f.sourceVersions[0].replace(/-/g,'')}/`;
 if(!f.sourceUrl.startsWith(expected))return false;
 const row=f.reconciliation.tableRows.find(row=>row.find(c=>c)===def.label);
 if(!row || numericCells(row)[f.reconciliation.column]*1000!==f.value || f.reconciliation.reportedValue!==f.value)return false;
 return f.reconciliation.status==='reported_table_with_undefined_inputs' || Math.abs(f.reconciliation.inputRows.reduce((n,r)=>n+r.value,0)-f.value)<=f.reconciliation.precision/2;
}
module.exports={tablesFrom,extractTables,validObservation,REGISTRY};
