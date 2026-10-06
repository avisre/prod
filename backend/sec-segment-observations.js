'use strict';
const p=require('./sec-coverage');
// Exact issuer/member mappings reviewed against the original annual filings.
const LABELS={
 '0000002488':{'amd:DatacenterMember':'Data Center','amd:ClientAndGamingMember':'Client and Gaming','amd:ClientMember':'Client','amd:GamingMember':'Gaming','amd:EmbeddedMember':'Embedded','amd:AllOtherMember':'All Other'},
 '0001730168':{'avgo:SemiconductorSolutionsMember':'Semiconductor Solutions','avgo:InfrastructureSoftwareMember':'Infrastructure Software','us-gaap:ProductMember':'Products','avgo:SubscriptionsandServicesMember':'Subscriptions and Services'}
};
const AGGREGATES={'0001730168':['avgo:SemiconductorSolutionsAndInfrastructureSoftwareMember']};
function extract(segments,financial,filing) {
 const groups=new Map();
 for(const f of segments || []) {
  const dims=f._original?.dimensions;if(dims?.length!==1 || !/^[A-Z]{3}$/.test(f.unit || '') || !p.day(f.start))continue;
  const days=(Date.parse(f.end)-Date.parse(f.start))/86400000+1;if(days<340 || days>380)continue;
  const key=[f.start,f.end,f.unit,dims[0].axis,f.accn].join('|');const group=groups.get(key) || [];group.push(f);groups.set(key,group);
 }
 const output=[];
 for(const values of groups.values()) {
  const sample=values[0];const row=financial.income.annualReports.find(r=>r.fiscalDateEnding===sample.end && r.periodStart===sample.start && r.reportedCurrency===sample.unit && p.verifiedField(financial,r,'totalRevenue'));
  if(!row || !row._sources.totalRevenue.every(id=>financial.sources[id].accessionNumber===sample.accn))continue;
  const members=new Map();let conflicting=false;
  for(const f of values) {const member=f._original.dimensions[0].member;const old=members.get(member);if(old && old.val!==f.val){conflicting=true;break;}members.set(member,f);}
  if(conflicting)continue;
  const aggregateMembers=[...members.values()].filter(f=>(AGGREGATES[financial.cik] || []).includes(f._original.dimensions[0].member));
  const entries=[...members.values()].filter(f=>!aggregateMembers.includes(f)).map(f=>({member:f._original.dimensions[0].member,label:LABELS[financial.cik]?.[f._original.dimensions[0].member] || null,value:f.val,contextRef:f._original.contextRef,decimals:f._original.decimals,sourceUrl:f._original.documentUrl,sourceVersion:f.accn,sourceFact:{concept:f.concept,taxonomy:f.taxonomy,unit:f.unit,periodStart:f.start,periodEnd:f.end,rawValue:f.val,numericReceipt:f._original.numericReceipt},sourceIds:['segment:'+p.digest({cik:financial.cik,accession:f.accn,context:f._original.contextRef,concept:f.concept}).slice(0,24)]}));
  const precision=f=>/^-?\d+$/.test(f.decimals || '')?10**-Number(f.decimals):0;
  const tolerance=entries.reduce((n,f)=>n+precision(f)/2,0);
  const sum=entries.reduce((n,f)=>n+f.value,0),difference=row.totalRevenue-sum;
  output.push({issuer:financial.cik,axis:sample._original.dimensions[0].axis,periodStart:sample.start,periodEnd:sample.end,currency:sample.unit,accountingBasis:sample.taxonomy==='ifrs-full'?'IFRS':'US GAAP',sourceUrl:filing.url,sourceVersion:sample.accn,publicationDate:sample.filed,retrievedAt:financial.fetchedAt,entries,aggregateMembers,totalRevenue:row.totalRevenue,totalSourceIds:row._sources.totalRevenue,sum,difference,roundingTolerance:tolerance,reconciliationStatus:Math.abs(difference)<=tolerance?'reconciled':'partial',note:'Reported eliminations and unallocated members remain signed. Reviewed aggregate members are retained separately from the component sum. Partial groups must not be forced to sum or used as a complete company Sankey.'});
 }
 return output;
}
function validGroup(g,data) {
 if(!g || !data || g.issuer!==data.cik || !p.day(g.periodStart) || !p.day(g.periodEnd) || !Array.isArray(g.entries) || !g.entries.length)return false;
 const row=data.income?.annualReports?.find(r=>r.fiscalDateEnding===g.periodEnd && r.periodStart===g.periodStart && r.reportedCurrency===g.currency && p.verifiedField(data,r,'totalRevenue'));
 if(!row || row.totalRevenue!==g.totalRevenue || JSON.stringify(row._sources.totalRevenue)!==JSON.stringify(g.totalSourceIds) || !g.totalSourceIds.every(id=>data.sources[id]?.accessionNumber===g.sourceVersion))return false;
 const base='https://www.sec.gov/Archives/edgar/data/'+Number(g.issuer)+'/'+g.sourceVersion.replace(/-/g,'')+'/';
 if(!g.sourceUrl?.startsWith(base) || !p.day(g.publicationDate) || g.publicationDate<g.periodEnd)return false;
 const concepts=require('./sec-facts').MAPS.income.totalRevenue;
 if(g.entries.some(e=>require('./sec-inline-number').number(e.sourceFact?.numericReceipt)!==e.value))return false;
 if(g.entries.some(e=>!e.contextRef || !e.sourceUrl?.startsWith(base) || e.sourceVersion!==g.sourceVersion || e.sourceFact?.rawValue!==e.value || e.sourceFact?.unit!==g.currency || e.sourceFact?.periodStart!==g.periodStart || e.sourceFact?.periodEnd!==g.periodEnd || !concepts[e.sourceFact?.taxonomy]?.includes(e.sourceFact.concept) || !e.sourceIds?.length || e.label && LABELS[g.issuer]?.[e.member]!==e.label))return false;
 const sum=g.entries.reduce((n,e)=>n+e.value,0);return sum===g.sum && g.difference===g.totalRevenue-sum && g.reconciliationStatus===(Math.abs(g.difference)<=g.roundingTolerance?'reconciled':'partial');
}
// The reviewed label where one exists; otherwise the issuer's own element name
// set in plain words. A raw "meta:FamilyOfAppsMember" never reaches a reader.
// Members whose element name is an initialism the filing spells out.
const SPELLED={'inod:DdsMember':'Digital Data Solutions'};
const displayName=e=>e.label || SPELLED[e.member] || require('./ask-inline-segments').label(e.member) || e.member;
// Newest period first. A single-member "segment" axis says nothing, so the
// product and service lines lead when that is all the segment note holds.
function preferred(groups) {
 const latest=re=>(groups || []).filter(g=>re.test(g.axis)).sort((a,b)=>String(b.periodEnd).localeCompare(String(a.periodEnd)))[0];
 const business=latest(/(?:StatementBusinessSegmentsAxis|:SegmentsAxis)$/),product=latest(/(?:ProductOrServiceAxis|ProductsAndServicesAxis)$/);
 return {business,product,primary:business && (business.entries.length>1 || !product)?business:product || business || (groups || [])[0]};
}
function toolPayload(g,data,symbol) {
 if(!validGroup(g,data))return null;
 const row=data.income.annualReports.find(r=>r.fiscalDateEnding===g.periodEnd),sources=Object.fromEntries(g.totalSourceIds.map(id=>[id,data.sources[id]]));
 const witness={cik:data.cik,income:{annualReports:[{fiscalDateEnding:row.fiscalDateEnding,periodStart:row.periodStart,periodType:row.periodType,reportedCurrency:row.reportedCurrency,totalRevenue:row.totalRevenue,_sources:{totalRevenue:row._sources.totalRevenue},_derivations:{},_scopes:{totalRevenue:row._scopes.totalRevenue}}]},sources};
 return {symbol,cik:g.issuer,basis:'annual segment disclosures',periodEnd:g.periodEnd,currency:g.currency,fiscalYear:'FY'+g.periodEnd.slice(0,4),
  segments:g.entries.map(e=>({name:displayName(e),member:e.member,value:e.value,reportedRevenue:e.value,revenueUsd:g.currency==='USD'?e.value:null,revenuePct:g.totalRevenue>0?Math.round(e.value/g.totalRevenue*1000)/10:null,description:''})),
  observations:g.entries.map(e=>({name:displayName(e),periodEnd:g.periodEnd,currency:g.currency,fields:{segmentRevenue:{value:e.value,unit:g.currency,currency:g.currency,scope:'segment',sourceIds:e.sourceIds}}})),
  filing:{form:sources[g.totalSourceIds[0]].form,date:g.publicationDate,accessionNumber:g.sourceVersion,url:g.sourceUrl},storedSegmentsReceipt:g,financialWitness:witness,
  verificationStatus:g.reconciliationStatus,note:g.note,source:'Original SEC inline XBRL contexts; source units and issuer member identities are preserved'};
}
module.exports={extract,validGroup,toolPayload,preferred,displayName,LABELS};
