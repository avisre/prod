'use strict';
const p=require('./sec-coverage');
// Exact issuer/member mappings reviewed against the original annual filings.
const LABELS={
 '0000002488':{'amd:DatacenterMember':'Data Center','amd:ClientAndGamingMember':'Client and Gaming','amd:ClientMember':'Client','amd:GamingMember':'Gaming','amd:EmbeddedMember':'Embedded','amd:AllOtherMember':'All Other'},
 '0001730168':{'avgo:SemiconductorSolutionsMember':'Semiconductor Solutions','avgo:InfrastructureSoftwareMember':'Infrastructure Software','us-gaap:ProductMember':'Products','avgo:SubscriptionsandServicesMember':'Subscriptions and Services'}
};
const AGGREGATES={'0001730168':['avgo:SemiconductorSolutionsAndInfrastructureSoftwareMember']};
// What may stand for revenue in a breakdown. Revenue itself, or the measure a
// financial company reports by segment in its place. A bank's segment revenue
// is two filed figures added together; that pair is the one composite allowed.
const EXTRA_MEASURES={'us-gaap':{PremiumsEarnedNet:'net premiums earned',SupplementaryInsuranceInformationPremiumRevenue:'premium revenue',RevenuesNetOfInterestExpenseFullTaxEquivalentBasis:'revenue on a tax-equivalent basis'},'ifrs-full':{InsuranceRevenue:'insurance revenue'}};
const BANK_PAIR=['InterestIncomeExpenseNet','NoninterestIncome'],BANK_MEASURE='net interest income plus noninterest income';
const revenueConcepts=()=>require('./sec-facts').MAPS.income.totalRevenue;
// A bank that reports segment revenue under a concept of its own (Bank of
// America's tax-equivalent net revenue) still names it as net revenue.
const CUSTOM_NET_REVENUE=/^RevenuesNetOfInterestExpense[A-Za-z]{0,40}$/;
const measureOf=(taxonomy,concept)=>EXTRA_MEASURES[taxonomy]?.[concept] || (!['us-gaap','ifrs-full','srt','dei'].includes(taxonomy) && CUSTOM_NET_REVENUE.test(concept || '')?(/TaxEquivalent/.test(concept)?'revenue on a tax-equivalent basis':'revenue net of interest expense'):null);
const segmentMeasure=(taxonomy,concept)=>!!(revenueConcepts()[taxonomy]?.includes(concept) || measureOf(taxonomy,concept) || taxonomy==='us-gaap' && BANK_PAIR.includes(concept));
// Total revenue may be cited to an amendment of the same annual report: the
// amendment restates the same period, and the segment figures still have to
// add up to it. Any other filing is a different report and is not accepted.
const sameReport=(source,accession)=>!!source && (source.accessionNumber===accession || /^(?:10-K|20-F|40-F)\/A$/.test(source.form || ''));
function extract(segments,financial,filing) {
 const groups=new Map();
 for(const f of segments || []) {
  const dims=f._original?.dimensions;if(dims?.length!==1 || !/^[A-Z]{3}$/.test(f.unit || '') || !p.day(f.start))continue;
  const days=(Date.parse(f.end)-Date.parse(f.start))/86400000+1;if(days<340 || days>380)continue;
  // One table per concept and per consolidation view. A filing tags the same
  // member under several revenue concepts (total revenue beside contract
  // revenue) and both before and after intersegment eliminations; read as one
  // table those disagree, and the whole breakdown used to be thrown away.
  if(f.concept && !segmentMeasure(f.taxonomy,f.concept))continue;
  const view=(f._original.allDimensions || dims).length>dims.length?'operating':'reported';
  const key=[f.start,f.end,f.unit,dims[0].axis,f.accn,view,f.taxonomy+':'+f.concept].join('|');const group=groups.get(key) || [];group.push(f);groups.set(key,group);
 }
 // One value per member, or null when the filing gives a member two.
 const byMember=values=>{const members=new Map();for(const f of values){const member=f._original.dimensions[0].member,old=members.get(member);if(old && old.val!==f.val)return null;members.set(member,f);}return members;};
 const candidates=[];
 for(const [key,values] of groups) {
  const members=byMember(values);if(!members)continue;
  const concept=values[0].concept;
  if(concept && BANK_PAIR.includes(concept))continue; // only ever shown added to its partner, below
  candidates.push({sample:values[0],measure:measureOf(values[0].taxonomy,concept),rows:[...members.values()].map(f=>({f,value:f.val,components:null}))});
 }
 for(const [key,values] of groups) {
  if(values[0].concept!==BANK_PAIR[0] || values[0].taxonomy!=='us-gaap')continue;
  const other=groups.get(key.slice(0,key.lastIndexOf('|')+1)+'us-gaap:'+BANK_PAIR[1]),interest=byMember(values),fees=other && byMember(other);
  if(!interest || !fees)continue;
  const rows=[...new Set([...interest.keys(),...fees.keys()])].map(member=>{const parts=[interest.get(member),fees.get(member)].filter(Boolean);return {f:parts[0],value:parts.reduce((n,x)=>n+x.val,0),components:parts};});
  candidates.push({sample:values[0],measure:BANK_MEASURE,rows});
 }
 const output=[];
 for(const {sample,measure,rows} of candidates) {
  const row=financial.income.annualReports.find(r=>r.fiscalDateEnding===sample.end && r.periodStart===sample.start && r.reportedCurrency===sample.unit && p.verifiedField(financial,r,'totalRevenue'));
  if(!row || !row._sources.totalRevenue.every(id=>sameReport(financial.sources[id],sample.accn)))continue;
  const aggregate=x=>(AGGREGATES[financial.cik] || []).includes(x.f._original.dimensions[0].member);
  const aggregateMembers=rows.filter(aggregate).map(x=>x.f);
  const entries=rows.filter(x=>!aggregate(x)).map(({f,value,components})=>({member:f._original.dimensions[0].member,label:LABELS[financial.cik]?.[f._original.dimensions[0].member] || null,...(f._original.memberLabel?{filedLabel:f._original.memberLabel}:{}),value,contextRef:f._original.contextRef,decimals:f._original.decimals,sourceUrl:f._original.documentUrl,sourceVersion:f.accn,
   sourceFact:components?{concept:BANK_PAIR.join('+'),taxonomy:f.taxonomy,unit:f.unit,periodStart:f.start,periodEnd:f.end,rawValue:value}:{concept:f.concept,taxonomy:f.taxonomy,unit:f.unit,periodStart:f.start,periodEnd:f.end,rawValue:f.val,numericReceipt:f._original.numericReceipt},
   ...(components?{components:components.map(c=>({concept:c.concept,taxonomy:c.taxonomy,value:c.val,contextRef:c._original.contextRef,numericReceipt:c._original.numericReceipt}))}:{}),
   sourceIds:(components || [f]).map(c=>'segment:'+p.digest({cik:financial.cik,accession:c.accn,context:c._original.contextRef,concept:c.concept}).slice(0,24))}));
  const precision=f=>/^-?\d+$/.test(f.decimals || '')?10**-Number(f.decimals):0;
  const tolerance=entries.reduce((n,f)=>n+precision(f)/2*(f.components?.length || 1),0);
  const sum=entries.reduce((n,f)=>n+f.value,0),difference=row.totalRevenue-sum;
  output.push({issuer:financial.cik,axis:sample._original.dimensions[0].axis,...(measure?{measure}:{}),periodStart:sample.start,periodEnd:sample.end,currency:sample.unit,accountingBasis:sample.taxonomy==='ifrs-full'?'IFRS':'US GAAP',sourceUrl:filing.url,sourceVersion:sample.accn,publicationDate:sample.filed,retrievedAt:financial.fetchedAt,entries,aggregateMembers,totalRevenue:row.totalRevenue,totalSourceIds:row._sources.totalRevenue,sum,difference,roundingTolerance:tolerance,reconciliationStatus:Math.abs(difference)<=tolerance?'reconciled':'partial',note:'Reported eliminations and unallocated members remain signed. Reviewed aggregate members are retained separately from the component sum. Partial groups must not be forced to sum or used as a complete company Sankey.'});
 }
 // Several candidate tables can survive for one axis and year; the one that
 // accounts for revenue is the table, and the others are views of it. Revenue
 // itself is preferred to a stand-in measure that fits equally well.
 const best=new Map();
 for(const g of output) {
  const key=[g.periodStart,g.periodEnd,g.currency,g.axis].join('|'),old=best.get(key);
  // A lone member holding all of revenue reconciles perfectly and says nothing;
  // a real table of several rows is preferred to it even when it fits less well.
  const miss=x=>(x.entries.length<2?2:0)+(x.reconciliationStatus==='reconciled'?0:1)+Math.abs(x.difference)/Math.max(1,Math.abs(x.totalRevenue))+(x.measure?0.02:0);
  if(!old || miss(g)<miss(old) || miss(g)===miss(old) && g.entries.length>old.entries.length)best.set(key,g);
 }
 return [...best.values()];
}
function validGroup(g,data) {
 if(!g || !data || g.issuer!==data.cik || !p.day(g.periodStart) || !p.day(g.periodEnd) || !Array.isArray(g.entries) || !g.entries.length)return false;
 const row=data.income?.annualReports?.find(r=>r.fiscalDateEnding===g.periodEnd && r.periodStart===g.periodStart && r.reportedCurrency===g.currency && p.verifiedField(data,r,'totalRevenue'));
 if(!row || row.totalRevenue!==g.totalRevenue || JSON.stringify(row._sources.totalRevenue)!==JSON.stringify(g.totalSourceIds) || !g.totalSourceIds.every(id=>sameReport(data.sources[id],g.sourceVersion)))return false;
 const base='https://www.sec.gov/Archives/edgar/data/'+Number(g.issuer)+'/'+g.sourceVersion.replace(/-/g,'')+'/';
 if(!g.sourceUrl?.startsWith(base) || !p.day(g.publicationDate) || g.publicationDate<g.periodEnd)return false;
 const number=require('./sec-inline-number').number;
 // A composite row is exactly the bank pair, each part with its own receipt, adding to the row.
 const composite=e=>Array.isArray(e.components) && e.components.length>=1 && e.components.length<=2 && new Set(e.components.map(c=>c.concept)).size===e.components.length &&
  e.components.every(c=>c.taxonomy==='us-gaap' && BANK_PAIR.includes(c.concept) && c.contextRef && number(c.numericReceipt)===c.value) &&
  e.components.reduce((n,c)=>n+c.value,0)===e.value && e.sourceFact?.concept===BANK_PAIR.join('+') && g.measure===BANK_MEASURE;
 if(g.entries.some(e=>e.components?!composite(e):number(e.sourceFact?.numericReceipt)!==e.value))return false;
 if(g.measure!==undefined && g.measure!==BANK_MEASURE && !g.entries.every(e=>measureOf(e.sourceFact?.taxonomy,e.sourceFact?.concept)===g.measure))return false;
 if(g.entries.some(e=>!e.contextRef || !e.sourceUrl?.startsWith(base) || e.sourceVersion!==g.sourceVersion || e.sourceFact?.rawValue!==e.value || e.sourceFact?.unit!==g.currency || e.sourceFact?.periodStart!==g.periodStart || e.sourceFact?.periodEnd!==g.periodEnd || !(e.components || segmentMeasure(e.sourceFact?.taxonomy,e.sourceFact?.concept) && !BANK_PAIR.includes(e.sourceFact.concept)) || !e.sourceIds?.length || e.label && LABELS[g.issuer]?.[e.member]!==e.label || e.filedLabel!==undefined && (typeof e.filedLabel!=='string' || !e.filedLabel || e.filedLabel.length>120)))return false;
 const sum=g.entries.reduce((n,e)=>n+e.value,0);return sum===g.sum && g.difference===g.totalRevenue-sum && g.reconciliationStatus===(Math.abs(g.difference)<=g.roundingTolerance?'reconciled':'partial');
}
// The reviewed label where one exists; otherwise the issuer's own element name
// set in plain words. A raw "meta:FamilyOfAppsMember" never reaches a reader.
// Members whose element name is an initialism the filing spells out.
const SPELLED={'nexa:PEMember':'Peru','inod:DdsMember':'Digital Data Solutions','us-gaap:OtherCapitalizedPropertyPlantAndEquipmentMember':'Equipment'};
// A filed label is used when it reads as a name: some filers leave the label
// equal to the element name, or label a member with a sentence.
const filed=e=>{
 const tagName=require('./ask-inline-segments').label(e.member),bare=String(e.member || '').split(':').pop().replace(/(?:Member)+$/,'');
 const v=String(e.filedLabel || '').replace(/\s*\[(?:Member|Domain)\]$/i,'').replace(/,?\s+Member$/i,'').replace(/\s*\(Segment\)$/i,'').replace(/\s+segments?$/i,'').replace(/\s+/g,' ').trim();
 if(v.length<2 || v.length>70 || !/[A-Za-z]/.test(v) || /Member$|:|_/.test(v) || /[a-z]{24,}/.test(v))return null;
 // A component row whose caption was read as the table's "Totals" line (Fresh Del Monte's
 // third product line, $210M of $4.3bn) is a part, not the total: roll-ups are removed
 // before this point. The wrong caption is not shown; the row is named for what it is.
 if(/^(?:sub)?totals?$/i.test(v))return 'Other';
 // A one-word label that is only the element name again says nothing the tag does not.
 if(!/\s/.test(v) && v.toLowerCase()===bare.toLowerCase())return null;
 // An abbreviation ("CCG", "USCS") where the element name spells it out.
 if(/^[A-Z0-9&]{2,6}$/.test(v) && tagName.length>v.length+3 && tagName.split(' ').length>1)return null;
 return v;};
// Reviewed override, then the company's own printed label, then the element name in plain words.
const displayName=e=>e.label || SPELLED[e.member] || filed(e) || require('./ask-inline-segments').label(e.member) || e.member;
// What a reader would actually see from a group: its positive rows with filed
// subtotals pruned, and how much of revenue they account for.
function shown(g) {
 const first=read(g,false);
 // A table that still adds to more than revenue is read once more with the
 // filer's own repeats taken out. Only then: these rules never touch a table
 // that already accounts for revenue, and the stricter reading is kept only
 // when it does.
 if(first.usable || !(first.coverage>1.1))return first;
 const second=read(g,true);
 return second.usable?second:first;
}
function read(g,strict) {
 // When the rows over-count revenue, a row that is exactly the sum of others is
 // a filed subtotal and goes first; only then is the closest-fit pruning used.
 // Pruning alone can keep a subtotal beside its own parts and still land on 100%.
 // A member that is itself a roll-up of the others ("Reportable Segment,
 // Aggregation", "Total") is not a row of the table.
 const rollup=e=>/Aggregat|SegmentsTotal|TotalSegments?|TotalReportable|AllReportableSegments|ReportableSegmentsMember$|^[a-z-]+:TotalMember$/i.test(e.member || '') || /^(?:Total|Reportable Segments?)$/i.test(String(e.filedLabel || '').trim());
 // Strict reading. A member equal to the filed total is the total under
 // another name, as is one called "Entity-wide" or "Consolidated entities"; a revenue figure
 // restated by currency is a memo line; and two members carrying one exact
 // value are one figure tagged twice (a renamed element kept beside its
 // replacement), of which the first is kept.
 const total=g?.totalRevenue || 0,seen=new Set();
 const repeat=e=>total>0 && e.value===total || /^[a-z-]+:(?:Currency[A-Z]\w*|ConsolidatedEntit\w*|EntityWide|OperatingSegments?)Member$/.test(e.member || '') || seen.has(e.value) || !seen.add(e.value);
 const inline=require('./ask-inline-segments'),all=(g?.entries || []).filter(e=>e.value>0 && !rollup(e) && !(strict && repeat(e))).map(e=>({member:e.member,value:e.value}));
 const over=list=>list.reduce((n,r)=>n+r.value,0)>(g?.totalRevenue || 0)*1.02;
 // Exact, to the filed unit: a real line that merely lands near the sum of two others stays.
 const subtotal=row=>{const rest=all.filter(r=>r!==row && r.value<row.value);
  for(let i=0;i<rest.length;i++)for(let j=i+1;j<rest.length;j++){if(rest[i].value+rest[j].value===row.value)return true;
   for(let k=j+1;k<rest.length;k++)if(rest[i].value+rest[j].value+rest[k].value===row.value)return true;}
  return false;};
 // Closest-fit pruning is for product and region tables, which mix levels of
 // detail. Operating segments are never pruned to fit: one that sells to
 // another is still a segment, so only an exact filed subtotal is removed.
 // Two tables filed on one axis (segments, then the same revenue by country):
 // the leading rows that add exactly to the filed total are the first table.
 const lead=()=>{let sum=0;for(let i=0;i<all.length;i++){sum+=all[i].value;if(i>0 && i<all.length-1 && Math.abs(sum-total)<=(g?.roundingTolerance || 0))return all.slice(0,i+1);if(sum>total*1.01)break;}return null;};
 const exact=strict && lead() || (over(all) && all.length<=14?all.filter(r=>!subtotal(r)):all);
 const rows=BUSINESS.test(g?.axis || '')?exact:inline.prune(exact,g?.totalRevenue);
 const coverage=g?.totalRevenue>0?rows.reduce((n,r)=>n+r.value,0)/g.totalRevenue:0;
 // Operating segments that sell to each other are filed before eliminations
 // and can add up to well over revenue (CVS 118%, Humana 113%). They are the
 // company's real segments; `gross` marks them so shares are taken of the
 // segment total, not of consolidated revenue.
 const gross=!strict && BUSINESS.test(g?.axis || '') && rows.length>=2 && coverage>1.1 && coverage<=1.6;
 return {rows,coverage,gross,usable:rows.length>=2 && coverage>=0.9 && (coverage<=1.1 || gross)};
}
const GEOGRAPHY=/^(?:(?:North|South|Latin|Central|Greater|Rest of|Other|All Other|Asia|Europe|Middle East|Africa|EMEA|APAC|Americas?|International|Domestic|Foreign|US|United States|Canada|China|Japan|India|Pacific|and|of|the|,|\s)+)$/i;
const BUSINESS=/(?:StatementBusinessSegmentsAxis|:SegmentsAxis)$/,PRODUCT=/(?:ProductOrServiceAxis|ProductsAndServicesAxis)$/,REGION=/(?:StatementGeographicalAxis|GeographicalAreasAxis|GeographicDistributionAxis)$/;
// Newest period first. A single-member "segment" axis says nothing, so the
// product and service lines lead when that is all the segment note holds.
// `usable` is the stricter choice for a page: the newest group, operating
// segments before product lines, that has at least two rows and accounts for
// revenue. A table covering 8% of revenue reads as the whole business and is not one.
function preferred(groups) {
 const all=groups || [],latest=re=>all.filter(g=>re.test(g.axis)).sort((a,b)=>String(b.periodEnd).localeCompare(String(a.periodEnd)))[0];
 const business=latest(BUSINESS),product=latest(PRODUCT);
 // Regions come last: where a company sells says less than what it sells, but
 // it is a real breakdown for a company that reports nothing else.
 const rank=g=>BUSINESS.test(g.axis)?0:PRODUCT.test(g.axis)?1:REGION.test(g.axis)?2:3;
 const ordered=all.slice().sort((a,b)=>String(b.periodEnd).localeCompare(String(a.periodEnd)) || rank(a)-rank(b));
 let usable=ordered.find(g=>shown(g).usable) || null;
 // Product and service lines are what a company actually sells ("Online stores,
 // Advertising, AWS"), where its operating segments are often geography ("North
 // America, International"). They lead when the same year's lines account for
 // revenue and say more: at least three rows, and more rows than the segments.
 const lines=usable && !PRODUCT.test(usable.axis) && ordered.find(g=>g.periodEnd===usable.periodEnd && PRODUCT.test(g.axis) && shown(g).usable);
 const places=g=>shown(g).rows.every(r=>GEOGRAPHY.test(displayName(g.entries.find(e=>e.member===r.member))));
 if(lines && shown(lines).rows.length>=3 && (shown(lines).rows.length>shown(usable).rows.length || places(usable)))usable=lines;
 // A real table that leaves part of revenue out (an insurer-conglomerate's
 // product lines exclude premiums). Shown only when nothing better exists, and
 // only with the remainder named beside it.
 const partial=usable?null:ordered.find(g=>{const v=shown(g);return v.coverage<0.9 && (v.rows.length>=3 && v.coverage>=0.6 || v.rows.length>=2 && v.coverage>=0.75);}) || null;
 return {business,product,primary:business && (business.entries.length>1 || !product)?business:product || business || all[0],usable,partial};
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
const kind=g=>PRODUCT.test(g?.axis || '')?'product and service lines':REGION.test(g?.axis || '')?'regions':'operating segments';
module.exports={extract,validGroup,toolPayload,preferred,shown,kind,displayName,segmentMeasure,LABELS};
