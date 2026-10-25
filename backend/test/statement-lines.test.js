'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {extract}=require('../sec-facts');
const p=require('../sec-coverage');
const lines=require('../statement-lines');
const {fixture}=require('./sec-facts.test');
const ACC='0000000123-26-000001',mapped=lines.mappedTags();
const line=o=>({s:'income',f:'totalRevenue',t:'custom',c:'TotalRevenues',l:'Total revenues',u:'USD',v:900,e:'2025-12-31',q:4,a:ACC,m:'10-K',d:'2026-02-01',...o});
const blankRevenue=()=>{const {doc,evidence}=fixture();delete doc.facts['us-gaap'].Revenues;return {doc,evidence};};

test('a line is read by its statement and its whole label, never by a part of one',()=>{
 assert.deepEqual(lines.fieldsFor('IS','Total revenues','TotalRevenues',{custom:true,crdr:'C',mapped}),['totalRevenue']);
 assert.deepEqual(lines.fieldsFor('IS','Collaboration revenue','CollaborationRevenue',{custom:true,crdr:'C',mapped}),[]);
 assert.deepEqual(lines.fieldsFor('IS','Revenue from related parties','X',{custom:true,crdr:'C',mapped}),[]);
 assert.deepEqual(lines.fieldsFor('BS','Total revenues','TotalRevenues',{custom:true,crdr:'C',mapped}),[]);
 assert.deepEqual(lines.fieldsFor('IS','Interest expense, net','InterestIncomeExpenseNonoperatingNet',{crdr:'D',mapped}),[]);
 assert.deepEqual(lines.fieldsFor('IS','Net loss per share attributable to stockholders, basic (in Dollars per share)','EarningsPerShareBasic',{mapped}),['eps']);
 assert.deepEqual(lines.fieldsFor('IS','Net loss per share, basic and diluted','EarningsPerShareBasicAndDiluted',{mapped}),['eps','dilutedEPS']);
});

test('a standard EPS tag is the filed EPS whatever its printed label says',()=>{
 const eps=(l,tag,custom=false)=>lines.fieldsFor('IS',l,tag,{custom,mapped});
 // 2026q3 labels no label rule matches, on the standard tags themselves.
 assert.deepEqual(eps('Basic and diluted net loss per ordinary share (in Dollars per share)','EarningsPerShareBasic'),['eps','dilutedEPS']); // SPAC: the label decides first
 assert.deepEqual(eps('Net earnings per average equivalent Class A share','EarningsPerShareBasic'),['eps']); // Berkshire
 assert.deepEqual(eps('Net income per share - basic (USD per share)','EarningsPerShareBasic'),['eps']); // Hershey
 assert.deepEqual(eps('Common stock - basic (in dollars per share)','EarningsPerShareBasic'),['eps']); // Erie Indemnity
 assert.deepEqual(eps('Common Stock (in dollars per share)','EarningsPerShareBasic'),['eps']); // Coca-Cola Consolidated
 assert.deepEqual(eps('Basic income per Class A common stock (in dollars per share)','EarningsPerShareBasic'),['eps']); // Baker Hughes
 assert.deepEqual(eps('Earnings per Class A and Class B common stock - basic (in usd per share)','EarningsPerShareBasic'),['eps']); // Greif
 assert.deepEqual(eps('Diluted income per Class A common stock (in dollars per share)','EarningsPerShareDiluted'),['dilutedEPS']); // Baker Hughes
 assert.deepEqual(eps('Net earnings per average equivalent Class A and Class B share','EarningsPerShareBasicAndDiluted'),['eps','dilutedEPS']);
 // The tag decides only a standard tag: the filer's own label still has to match a rule.
 assert.deepEqual(eps('Net earnings per average equivalent Class A share','ClassAEPS',true),[]);
 // And an excluded label stays out.
 assert.deepEqual(eps('Class A and Class B common stock (discontinued operations) - basic (in usd per share)','EarningsPerShareBasic'),[]);
});

test('an allowance or accumulated depreciation clause reads as ", net", and nothing else after it does',()=>{
 // ReceivablesNetCurrent has been read from the facts since 2026-10-17, so it no longer comes from the face.
 const bs=(l,tag='AccountsNotesAndLoansReceivableNetCurrent')=>lines.fieldsFor('BS',l,tag,{crdr:'D',mapped});
 assert.deepEqual(bs('Receivables, net','ReceivablesNetCurrent'),[]);
 assert.deepEqual(bs('Receivables, net of allowance for doubtful accounts of $1 at December 31, 2025 and 2024'),['currentNetReceivables']);
 assert.deepEqual(bs('Accounts receivable, net of allowance for credit losses of $2.1 million and $1.8 million as of December 31, 2025 and December 31, 2024, respectively'),['currentNetReceivables']);
 assert.deepEqual(bs('Accounts and notes receivable (less allowances of $4 in 2025 and $5 in 2024)','AccountsNotesAndLoansReceivableNetCurrent'),['currentNetReceivables']);
 assert.deepEqual(bs('Accounts receivable - net'),['currentNetReceivables']);
 assert.deepEqual(bs('Property and equipment, net of accumulated depreciation of $10,512 and $9,870','PropertyPlantAndEquipmentNetCustom'),['propertyPlantEquipment']);
 assert.deepEqual(bs('Accounts receivable, net of allowance, and unbilled receivables'),[]);
 assert.deepEqual(bs('Accounts receivable, net of allowance of $3 (including related party receivables of $9)'),[]);
});

test('a bare "long-term debt" needs a noncurrent tag, and intangibles a tag without goodwill in it',()=>{
 const bs=(l,tag,custom=false)=>lines.fieldsFor('BS',l,tag,{custom,crdr:tag==='FiniteLivedIntangibleAssetsNet' || /Intangible/.test(tag)?'D':'C',mapped});
 assert.deepEqual(bs('Long-term debt','LongTermDebtAndCapitalLeaseObligations'),['longTermDebt']);
 assert.deepEqual(bs('Long-term debt, net','SeniorNotesNoncurrent'),['longTermDebt']);
 assert.deepEqual(bs('Long-term debt','LongTermDebtCustom',true),[]);
 assert.deepEqual(bs('Long-term debt, net of current portion','LongTermDebtCustom',true),['longTermDebt']);
 assert.deepEqual(bs('Intangibles, net','FiniteLivedIntangibleAssetsNet'),['intangibleAssetsExcludingGoodwill']);
 assert.deepEqual(bs('Intangible assets','IntangibleAssetsAndGoodwill'),[]);
 assert.deepEqual(bs('Other intangible assets, net','OtherIntangibleAssetsNet'),[]);
 assert.deepEqual(lines.fieldsFor('BS','Inventories - net','InventoryNoncurrent',{crdr:'D',mapped}),[]);
});

test('the tag behind a label must agree with it: balance, name and our own maps',()=>{
 // A custom "net loss" element filed as a positive debit would turn a loss into a profit.
 assert.deepEqual(lines.fieldsFor('IS','Net loss','NetLoss',{custom:true,crdr:'D',mapped}),[]);
 assert.deepEqual(lines.fieldsFor('IS','Net loss','NetIncomeLossCustom',{custom:true,crdr:'C',mapped}),['netIncome']);
 assert.deepEqual(lines.fieldsFor('IS','Loss before income taxes','IncomeLossAttributableToParent',{crdr:'C',mapped}),[]);
 assert.deepEqual(lines.fieldsFor('IS','Net loss','ComprehensiveIncomeNetOfTax',{crdr:'C',mapped}),[]);
 assert.deepEqual(lines.fieldsFor('BS','Intangible assets, net','IntangibleAssetsNetIncludingGoodwill',{crdr:'D',mapped}),[]);
 // Ours already, or refused by the validator for the field.
 assert.deepEqual(lines.fieldsFor('IS','Net loss','NetIncomeLoss',{crdr:'C',mapped}),[]);
 assert.deepEqual(lines.fieldsFor('BS','Long-term debt, net of current portion','LongTermDebt',{crdr:'C',mapped}),[]);
 assert.deepEqual(lines.fieldsFor('IS','Total operating expenses','CostsAndExpenses',{crdr:'D',mapped}),[]);
 // With a noncontrolling interest on the statement, a bare "net income" is not the parent's.
 assert.deepEqual(lines.fieldsFor('IS','Net income','NetIncomeCustom',{custom:true,crdr:'C',mapped,noncontrolling:true}),[]);
 assert.equal(lines.acceptedDimension('ClassOfStock=CommonStock','eps'),true);
 assert.equal(lines.acceptedDimension('ClassOfStock=CommonStock','totalRevenue'),false);
 assert.equal(lines.acceptedDimension('ClassOfStock=CommonStock;Segment=X','eps'),false);
});

test('a statement line fills an empty figure from the filing the row cites, and passes the validator',()=>{
 const {doc,evidence}=blankRevenue();
 const d=extract(doc,evidence,{asOf:'2026-10-03',statementLines:[line()]}),row=d.income.annualReports[0];
 assert.equal(row.totalRevenue,900);
 const s=d.sources[row._sources.totalRevenue[0]];
 assert.equal(s.verificationMethod,'statement_line');assert.equal(s.presentationLabel,'Total revenues');assert.equal(s.periodStart,row.periodStart);
 assert.equal(p.verifiedField(d,row,'totalRevenue'),true);
 assert.equal(p.classify(evidence,d,'2026-10-03').financialCoverage,'ready');
});

test('a line never replaces a figure, adds a period, or comes from a filing the row does not cite',()=>{
 const {doc,evidence}=fixture();
 assert.equal(extract(doc,evidence,{asOf:'2026-10-03',statementLines:[line()]}).income.annualReports[0].totalRevenue,0);
 const blank=blankRevenue();
 const other=extract(blank.doc,blank.evidence,{asOf:'2026-10-03',statementLines:[line({a:'0000000123-26-000009'})]});
 assert.equal(other.income.annualReports[0].totalRevenue,null);
 const later=extract(blank.doc,blank.evidence,{asOf:'2026-10-03',statementLines:[line({e:'2024-12-31'}),line({s:'balance',f:'totalAssets',e:'2024-12-31',q:0})]});
 assert.equal(later.income.annualReports.length,1);assert.equal(later.balance.annualReports.length,1);
 // A quarter line is not a year, and two figures in one filing are not one.
 assert.equal(extract(blank.doc,blank.evidence,{asOf:'2026-10-03',statementLines:[line({q:1})]}).income.annualReports[0].totalRevenue,null);
 assert.equal(extract(blank.doc,blank.evidence,{asOf:'2026-10-03',statementLines:[line(),line({v:901})]}).income.annualReports[0].totalRevenue,null);
});

test('a data-set line on a standard tag takes the filed figure of the same filing and period',()=>{
 // Smucker FY2026: the data set listed cash 0 where the 10-K tags $58.6M.
 const {doc,evidence}=blankRevenue();
 const start=extract(doc,evidence,{asOf:'2026-10-03'}).income.annualReports[0].periodStart;
 const std=line({t:'us-gaap',c:'RevenueFromServicesStd',v:0});
 const filed=v=>({start,end:'2025-12-31',val:v,accn:ACC,form:'10-K',filed:'2026-02-01'});
 doc.facts['us-gaap'].RevenueFromServicesStd={units:{USD:[filed(900)]}};
 const d=extract(doc,evidence,{asOf:'2026-10-03',statementLines:[std]}),row=d.income.annualReports[0];
 assert.equal(row.totalRevenue,900);
 assert.equal(d.sources[row._sources.totalRevenue[0]].dataSetValue,0);
 // Agreement changes nothing; two filed figures leave the line out; a dimension's line is not checked.
 assert.equal(extract(doc,evidence,{asOf:'2026-10-03',statementLines:[{...std,v:900}]}).sources[row._sources.totalRevenue[0]]?.dataSetValue,undefined);
 doc.facts['us-gaap'].RevenueFromServicesStd.units.USD.push(filed(901));
 assert.equal(extract(doc,evidence,{asOf:'2026-10-03',statementLines:[std]}).income.annualReports[0].totalRevenue,null);
 assert.equal(extract(doc,evidence,{asOf:'2026-10-03',statementLines:[{...std,f:'eps',u:'USD/shares',l:'Net loss per share, basic',g:'ClassOfStock=CommonStock',v:-1}]}).income.annualReports[0].eps,-1);
});

test('an outflow line is stored negative and per-class EPS takes the common stock only when the rest are preferred',()=>{
 const {doc,evidence}=fixture();
 const capex=line({s:'cash',f:'capitalExpenditures',c:'PurchasesOfEquipment',l:'Purchases of property and equipment',v:40});
 const eps=(g,v)=>line({f:'eps',c:'EarningsPerShareBasic',t:'us-gaap',l:'Net loss per share, basic',v,g});
 const d=extract(doc,evidence,{asOf:'2026-10-03',statementLines:[capex,eps('ClassOfStock=CommonStock',-1.85),eps('ClassOfStock=SeriesBPreferredStock',-154.03)]});
 const cash=d.cash.annualReports[0],income=d.income.annualReports[0];
 assert.equal(cash.capitalExpenditures,-40);assert.equal(p.verifiedField(d,cash,'capitalExpenditures'),true);
 assert.equal(income.eps,-1.85);assert.equal(d.sources[income._sources.eps[0]].unit,'USD/shares');assert.equal(p.verifiedField(d,income,'eps'),true);
 const two=extract(doc,evidence,{asOf:'2026-10-03',statementLines:[eps('ClassOfStock=CommonClassA',1),eps('ClassOfStock=CommonClassB',2)]});
 assert.equal(two.income.annualReports[0].eps,null);
});

const put=(doc,tag,val)=>{doc.facts['us-gaap'][tag]={units:{USD:[{val,end:'2025-12-31',accn:ACC,form:'10-K',filed:'2026-02-01'}]}};};
const face=(...c)=>({s:'balance',k:'debt',f:'',e:'2025-12-31',c,a:ACC,m:'10-K',d:'2026-02-01'});
const debtRow=(tags,lines)=>{const {doc,evidence}=fixture();for(const [t,v] of Object.entries(tags))put(doc,t,v);const d=extract(doc,evidence,{asOf:'2026-10-03',statementLines:lines});return {d,row:d.balance.annualReports[0]};};

test('a balance-sheet line is a debt line by its tag or label; leases, interest and totals are not',()=>{
 for(const [tag,label] of [['LongTermDebtNoncurrent','Long-term debt'],['LongTermDebtAndCapitalLeaseObligations','Long-term debt and finance lease obligations'],
  ['Custom1','Long-term debt, net of deferred loan fees'],['ConvertibleNotesPayable','Convertible notes (Note 7)'],['NotesPayableRelatedPartiesCurrent','Note payable - related party']])assert.equal(lines.debtLine(tag,label),true,label);
 for(const [tag,label] of [['OperatingLeaseLiabilityNoncurrent','Operating lease liabilities'],['Liabilities','Total liabilities'],['LiabilitiesOtherThanLongtermDebtNoncurrent','Other liabilities'],
  ['InterestPayableCurrent','Accrued interest'],['AvailableForSaleSecuritiesDebtSecurities','Debt securities'],['AccountsPayableCurrent','Accounts payable']])assert.equal(lines.debtLine(tag,label),false,label);
});

test('total debt is the sum of the debt lines the balance sheet presents, and only when the face and the row agree',()=>{
 const {d,row}=debtRow({LongTermDebtNoncurrent:300,LongTermDebtCurrent:20},[face('LongTermDebtCurrent','LongTermDebtNoncurrent')]);
 assert.equal(row.shortLongTermDebtTotal,320);
 assert.deepEqual(row._derivations.shortLongTermDebtTotal.inputs,['longTermDebt','currentLongTermDebt']);
 assert.equal(p.verifiedField(d,row,'shortLongTermDebtTotal'),true);
 assert.deepEqual(p.validateFinancial(d,d.cik,'2026-10-03'),[]);
 // No presentation: the parts alone do not make a total.
 assert.equal(debtRow({LongTermDebtNoncurrent:300,LongTermDebtCurrent:20},[]).row.shortLongTermDebtTotal,null);
 // A presented debt line the row does not hold.
 assert.equal(debtRow({LongTermDebtNoncurrent:300,LongTermDebtCurrent:20},[face('LongTermDebtCurrent','LongTermDebtNoncurrent','NotesPayableCurrent')]).row.shortLongTermDebtTotal,null);
 // A held figure off the face is inside some other line (Amazon's current debt, in accrued expenses).
 assert.equal(debtRow({LongTermDebtNoncurrent:300,LongTermDebtCurrent:20},[face('LongTermDebtNoncurrent')]).row.shortLongTermDebtTotal,null);
 // A presentation of another filing says nothing about this one.
 assert.equal(debtRow({LongTermDebtNoncurrent:300,LongTermDebtCurrent:20},[{...face('LongTermDebtCurrent','LongTermDebtNoncurrent'),a:'0000000123-26-000009'}]).row.shortLongTermDebtTotal,null);
});

test('one current line filed under two tags is counted once, and a filed total stays unless it is smaller than a line',()=>{
 const twin=debtRow({LongTermDebtNoncurrent:312,LongTermDebtCurrent:40,ShortTermBorrowings:40},[face('LongTermDebtNoncurrent','ShortTermBorrowings')]);
 assert.equal(twin.row.shortTermDebt,null);assert.equal(twin.row.shortLongTermDebtTotal,352);
 assert.deepEqual(p.validateFinancial(twin.d,twin.d.cik,'2026-10-03'),[]);
 // Both current tags presented: two lines, both counted.
 assert.equal(debtRow({LongTermDebtNoncurrent:312,LongTermDebtCurrent:40,ShortTermBorrowings:40},[face('LongTermDebtNoncurrent','ShortTermBorrowings','LongTermDebtCurrent')]).row.shortLongTermDebtTotal,392);
 // DebtCurrent on the face holds the current portion filed in a note (Ball: $2m inside $21m), and a "total" of $2m is a fragment.
 const ball=debtRow({LongTermDebtNoncurrent:6991,DebtCurrent:21,LongTermDebtCurrent:2,DebtLongtermAndShorttermCombinedAmount:2},[face('DebtCurrent','LongTermDebtNoncurrent')]);
 assert.equal(ball.row.shortLongTermDebtTotal,7012);assert.equal(p.verifiedField(ball.d,ball.row,'shortLongTermDebtTotal'),true);
 // A filed total at least as large as each line is principal against carrying amounts; it is kept.
 const filed=debtRow({LongTermDebtNoncurrent:300,LongTermDebtCurrent:20,DebtLongtermAndShorttermCombinedAmount:325},[face('LongTermDebtCurrent','LongTermDebtNoncurrent')]);
 assert.equal(filed.row.shortLongTermDebtTotal,325);assert.equal(filed.row._derivations.shortLongTermDebtTotal,undefined);
});

test('the validator re-checks a presented-lines total against its parts',()=>{
 const {d,row}=debtRow({LongTermDebtNoncurrent:300,LongTermDebtCurrent:20},[face('LongTermDebtCurrent','LongTermDebtNoncurrent')]);
 for(const tamper of [r=>{r.shortLongTermDebtTotal=321;},r=>{r._derivations.shortLongTermDebtTotal.presentedConcepts=['LongTermDebtNoncurrent'];},
  r=>{r._derivations.shortLongTermDebtTotal.inputs=['longTermDebt'];},r=>{r._sources.shortLongTermDebtTotal=[r._sources.longTermDebt[0]];}]){
  const copy=structuredClone(d),r=copy.balance.annualReports[0];tamper(r);assert.equal(p.verifiedField(copy,r,'shortLongTermDebtTotal'),false);
 }
});

test('a debt figure another filing gives for the date keeps the total unread',()=>{
 const {presentedDebt}=require('../sec-facts');
 const {d,row}=debtRow({LongTermDebtNoncurrent:300,LongTermDebtCurrent:20},[]);
 assert.equal(row.shortLongTermDebtTotal,null);
 d.sources.other={...d.sources[row._sources.currentLongTermDebt[0]],concept:'DebtCurrent',rawValue:54,accessionNumber:'0000000123-25-000004'};
 row.shortTermDebt=54;row._sources.shortTermDebt=['other'];row._scopes.shortTermDebt=row._scopes.currentLongTermDebt;
 presentedDebt(d,row,new Map([[ACC,['LongTermDebtCurrent','LongTermDebtNoncurrent']]]));
 assert.equal(row.shortLongTermDebtTotal,null);
 delete row._sources.shortTermDebt;row.shortTermDebt=null;
 presentedDebt(d,row,new Map([[ACC,['LongTermDebtCurrent','LongTermDebtNoncurrent']]]));
 assert.equal(row.shortLongTermDebtTotal,320);
 // The same current figure from the other filing (DoubleDown 2023: 6-K face, 20-F current borrowings) is that line, not another.
 const same=debtRow({LongTermDebtNoncurrent:300,LongTermDebtCurrent:20},[]);
 same.d.sources.other={...same.d.sources[same.row._sources.currentLongTermDebt[0]],concept:'DebtCurrent',rawValue:20,accessionNumber:'0000000123-25-000004'};
 same.row.shortTermDebt=20;same.row._sources.shortTermDebt=['other'];same.row._scopes.shortTermDebt=same.row._scopes.currentLongTermDebt;
 presentedDebt(same.d,same.row,new Map([[ACC,['LongTermDebtCurrent','LongTermDebtNoncurrent']]]));
 assert.equal(same.row.shortLongTermDebtTotal,320);assert.equal(p.verifiedField(same.d,same.row,'shortLongTermDebtTotal'),true);
});

test('a presented debt line the row holds no figure for is read as that filing\'s own fact (Agilent 2025: LongTermDebt on the face)',()=>{
 const {d,row}=debtRow({LongTermDebt:60,ShortTermBorrowings:4},[face('LongTermDebt','ShortTermBorrowings')]);
 assert.equal(row.longTermDebt,null);assert.equal(row.shortLongTermDebtTotal,64);
 assert.equal(row._derivations.shortLongTermDebtTotal.formula,'sum_presented_facts');
 assert.deepEqual(row._derivations.shortLongTermDebtTotal.presentedConcepts,['LongTermDebt','ShortTermBorrowings']);
 assert.equal(p.verifiedField(d,row,'shortLongTermDebtTotal'),true);
 assert.deepEqual(p.validateFinancial(d,d.cik,'2026-10-03'),[]);
 // Preferred stock or a commitments caption beside the debt is not debt, and is left out of the total.
 assert.equal(debtRow({LongTermDebt:60,PreferredStockValue:9},[face('LongTermDebt','PreferredStockValue')]).row.shortLongTermDebtTotal,60);
 // Each of these leaves the total unread: a gross line beside its own current portion, a line equal to the sum of
 // others, a line that is not debt, a line the filing does not carry, a total above the balance sheet.
 for(const [tags,faced] of [[{LongTermDebt:60,LongTermDebtCurrent:5},['LongTermDebt','LongTermDebtCurrent']],
  [{LoansPayableCurrent:5,LongTermLoansPayable:50,OtherBorrowings:55},['LoansPayableCurrent','LongTermLoansPayable','OtherBorrowings']],
  [{LongTermDebt:60,OtherLiabilitiesCurrent:3},['LongTermDebt','OtherLiabilitiesCurrent']],
  [{LongTermDebt:60},['LongTermDebt','ConvertibleNotesPayableCurrent']],
  [{LongTermDebt:90,NotesPayableCurrent:20},['LongTermDebt','NotesPayableCurrent']]])
  assert.equal(debtRow(tags,[face(...faced)]).row.shortLongTermDebtTotal,null,faced.join('+'));
 // A filed total is never replaced.
 assert.equal(debtRow({LongTermDebt:60,ShortTermBorrowings:4,DebtLongtermAndShorttermCombinedAmount:66},[face('LongTermDebt','ShortTermBorrowings')]).row.shortLongTermDebtTotal,66);
});

test('the validator re-checks a presented-facts total against the filed facts',()=>{
 const {d,row}=debtRow({LongTermDebt:60,ShortTermBorrowings:4},[face('LongTermDebt','ShortTermBorrowings')]);
 const first=r=>r._sources.shortLongTermDebtTotal[0];
 for(const tamper of [(r)=>{r.shortLongTermDebtTotal=65;},(r)=>{r._derivations.shortLongTermDebtTotal.presentedConcepts=['ShortTermBorrowings','LongTermDebt'];},
  (r,c)=>{c.sources[first(r)].accessionNumber='0000000123-26-000009';},(r,c)=>{c.sources[first(r)].periodStart='2025-01-01';},
  (r,c)=>{c.sources[first(r)].unit='EUR';},(r)=>{r._sources.shortLongTermDebtTotal=r._sources.shortLongTermDebtTotal.slice(0,1);}]){
  const copy=structuredClone(d),r=copy.balance.annualReports[0];tamper(r,copy);assert.equal(p.verifiedField(copy,r,'shortLongTermDebtTotal'),false);
 }
});

// Measured on the 2026-10-17 re-extraction: 217 presented lines were displaced by a newly read note tag
// (CIK 24090, 2023: the cash-flow add-back is $588k, AllocatedShareBasedCompensationExpense $900k).
test('a presented line wins over a figure from a fill-only tag, and the fill stays where there is no line',()=>{
 const {doc,evidence}=fixture(),period={start:'2025-01-01',end:'2025-12-31',accn:ACC,form:'10-K',filed:'2026-02-01'};
 doc.facts['us-gaap'].AllocatedShareBasedCompensationExpense={units:{USD:[{...period,val:900}]}};
 const sbc=line({s:'cash',f:'shareBasedCompensation',c:'RestrictedStockExpense',l:'Stock-based compensation',v:588});
 let d=extract(doc,evidence,{asOf:'2026-10-03',statementLines:[sbc]}),row=d.cash.annualReports[0];
 assert.equal(row.shareBasedCompensation,588);
 assert.equal(d.sources[row._sources.shareBasedCompensation[0]].verificationMethod,'statement_line');
 assert.equal(extract(doc,evidence,{asOf:'2026-10-03'}).cash.annualReports[0].shareBasedCompensation,900);
 // An original tag is never displaced.
 doc.facts['us-gaap'].ShareBasedCompensation={units:{USD:[{...period,val:600}]}};
 assert.equal(extract(doc,evidence,{asOf:'2026-10-03',statementLines:[sbc]}).cash.annualReports[0].shareBasedCompensation,600);
});

test('a cash-flow line is a capital-spending line by its tag or label; sales, accruals, financing and notes are not',()=>{
 for(const [tag,label] of [['PaymentsToAcquirePropertyPlantAndEquipment','Purchases of property and equipment'],['PaymentsForSoftware','Capitalized software development costs'],
  ['PaymentsToAcquireToolsDiesAndMolds','Purchases of tools, dies and molds'],['Custom1','Capital expenditures'],['Custom2','Additions to property, plant and equipment']])assert.equal(lines.capexLine(tag,label),true,label);
 for(const [tag,label] of [['ProceedsFromSaleOfPropertyPlantAndEquipment','Proceeds from sale of property and equipment'],['CapitalExpendituresIncurredButNotYetPaid','Capital expenditures included in accounts payable'],
  ['PaymentsToAcquireIntangibleAssets','Purchases of intellectual property'],['RepaymentsOfNotesPayable','Repayments of equipment notes'],['PaymentsToAcquireBusinessesNetOfCashAcquired','Acquisitions, net of cash acquired'],
  ['PaymentsToAcquireOtherProductiveAssets','Investment in new communities'],['Depreciation','Depreciation of property and equipment'],['FinanceLeasePrincipalPayments','Principal payments on finance lease equipment']])assert.equal(lines.capexLine(tag,label),false,label);
});

const spend=o=>({s:'cash',k:'capex',f:'',e:'2025-12-31',q:4,u:'USD',c:['PaymentsToAcquireOtherPropertyPlantAndEquipment','PaymentsToAcquireToolsDiesAndMolds'],t:['us-gaap','custom'],
 l:['Purchases of other property, plant, and equipment','Purchases of tools, dies, and molds'],v:[110618,71374],a:ACC,m:'10-K',d:'2026-02-01',...o});
const capexRow=(statementLines,facts={})=>{const {doc,evidence}=fixture();for(const [t,v] of Object.entries(facts))doc.facts['us-gaap'][t]={units:{USD:[].concat(v).map(val=>({val,start:'2025-01-01',end:'2025-12-31',accn:ACC,form:'10-K',filed:'2026-02-01'}))}};
 const d=extract(doc,evidence,{asOf:'2026-10-03',statementLines});return {d,row:d.cash.annualReports[0]};};

test('capital spending is the sum of the lines the cash-flow statement presents (Mattel 2025: $110.6m + $71.4m)',()=>{
 const {d,row}=capexRow([spend()]);
 assert.equal(row.capitalExpenditures,-181992);
 assert.deepEqual(row._derivations.capitalExpenditures,{formula:'sum_presented_capex',inputValues:[110618,71374],presentedConcepts:['PaymentsToAcquireOtherPropertyPlantAndEquipment','PaymentsToAcquireToolsDiesAndMolds']});
 assert.deepEqual(row._sources.capitalExpenditures.map(id=>d.sources[id].presentationLabel),['Purchases of other property, plant, and equipment','Purchases of tools, dies, and molds']);
 assert.equal(p.verifiedField(d,row,'capitalExpenditures'),true);
 assert.deepEqual(p.validateFinancial(d,d.cik,'2026-10-03'),[]);
 // One line alone is read the same way (Veeva: capitalized software is its only capital spending).
 assert.equal(capexRow([spend({c:['PaymentsForSoftware'],t:['us-gaap'],l:['Capitalized software'],v:[29131]})]).row.capitalExpenditures,-29131);
});

test('a filed capex tag stays, a single presented line widens to the sum, and the filing\'s own figure beats the data set',()=>{
 assert.equal(capexRow([spend()],{PaymentsToAcquirePropertyPlantAndEquipment:150000}).row.capitalExpenditures,-150000);
 const single=line({s:'cash',f:'capitalExpenditures',c:'PaymentsToAcquireToolsDiesAndMolds',l:'Purchases of tools, dies, and molds',v:71374});
 assert.equal(capexRow([single]).row.capitalExpenditures,-71374);
 const wide=capexRow([single,spend()]);
 assert.equal(wide.row.capitalExpenditures,-181992);assert.equal(p.verifiedField(wide.d,wide.row,'capitalExpenditures'),true);
 // A single line of another filing is not widened by this one's lines.
 assert.equal(capexRow([single,spend({c:['PaymentsToAcquireOtherPropertyPlantAndEquipment','OtherCapex'],t:['us-gaap','custom']})]).row.capitalExpenditures,-71374);
 const filed=capexRow([spend({v:[0,71374]})],{PaymentsToAcquireOtherPropertyPlantAndEquipment:110618});
 assert.equal(filed.row.capitalExpenditures,-181992);assert.equal(filed.d.sources[filed.row._sources.capitalExpenditures[0]].dataSetValue,0);
 assert.equal(capexRow([spend()],{PaymentsToAcquireOtherPropertyPlantAndEquipment:[110618,110619]}).row.capitalExpenditures,null);
});

test('presented capex lines are left unread when they do not make one total of one filing for the row\'s span',()=>{
 for(const [why,o] of [['another filing',{a:'0000000123-26-000009'}],['a quarter',{q:1}],['another currency',{u:'EUR'}],['mixed signs',{v:[110618,-71374]}],['all zero',{v:[0,0]}],
  ['a subtotal beside its parts',{c:['A','B','C'],t:['custom','custom','custom'],l:['a','b','c'],v:[60,40,100]}],
  ['productive assets beside other lines',{c:['PaymentsToAcquireProductiveAssets','PaymentsForSoftware'],t:['us-gaap','us-gaap']}]])
  assert.equal(capexRow([spend(o)]).row.capitalExpenditures,null,why);
});

test('the validator re-checks a presented capex total against its lines',()=>{
 const {d,row}=capexRow([spend()]),first=r=>r._sources.capitalExpenditures[0];
 for(const tamper of [r=>{r.capitalExpenditures=-181993;},r=>{r.capitalExpenditures=181992;},r=>{delete r._signs.capitalExpenditures;},
  r=>{r._derivations.capitalExpenditures.presentedConcepts.reverse();},r=>{r._sources.capitalExpenditures=r._sources.capitalExpenditures.slice(0,1);},
  (r,c)=>{c.sources[first(r)].accessionNumber='0000000123-26-000009';},(r,c)=>{c.sources[first(r)].periodStart='2025-02-01';},
  (r,c)=>{c.sources[first(r)].verificationMethod='xbrl_fact';},(r,c)=>{c.sources[first(r)].rawValue=-110618;}]){
  const copy=structuredClone(d),r=copy.cash.annualReports[0];tamper(r,copy);assert.equal(p.verifiedField(copy,r,'capitalExpenditures'),false);
 }
});
// 2026-10-25 revenue audit.
test('a total filed only under one product member is the whole only when it alone sums the others and is the largest',()=>{
 // APA 2025: oil and gas $8,920m = own production $7,229m + purchased $1,691m.
 assert.deepEqual(lines.memberTotal([['OilAndGas',8920],['OilAndGasProduction',7229],['OilAndGasPurchased',1691]]),['OilAndGas',8920]);
 assert.equal(lines.memberTotal([['A',5],['B',3]]),null,'two members cannot show a whole and its parts');
 assert.equal(lines.memberTotal([['Total',100],['A',60],['B',40],['Bigger',500]]),null,'a sum that is not the largest is a subtotal');
 assert.equal(lines.memberTotal([['X',10],['Y',4],['Z',6],['W',10]]),null,'two members sum the others');
 assert.equal(lines.memberTotal([['A',10],['B',3],['C',2]]),null,'no member sums the others');
});
test('"total closing revenue" and a custom "total income" line are revenue; a mapped tag reaches the builder only as a member total',()=>{
 assert.deepEqual(lines.fieldsFor('IS','Total closing revenue','TotalClosingRevenue',{custom:true,crdr:'C',mapped}),['totalRevenue']);
 assert.deepEqual(lines.fieldsFor('IS','Total income','OperatingIncome',{custom:true,crdr:'C',mapped}),['totalRevenue']);
 assert.deepEqual(lines.fieldsFor('IS','Total other income','OtherIncome',{custom:true,crdr:'C',mapped}),[]);
 assert.deepEqual(lines.fieldsFor('IS','Total revenues','Revenues',{crdr:'C',mapped}),[]);
 assert.deepEqual(lines.fieldsFor('IS','Total revenues','Revenues',{crdr:'C',mapped,memberTotal:true}),['totalRevenue']);
});
test('a product-member revenue total fills a blank revenue and keeps its dimension on the source',()=>{
 const {doc,evidence}=blankRevenue();
 const d=extract(doc,evidence,{asOf:'2026-10-03',statementLines:[line({t:'us-gaap',c:'Revenues',v:8920,g:'ProductOrService=OilAndGas'})]}),row=d.income.annualReports[0];
 assert.equal(row.totalRevenue,8920);assert.equal(d.sources[row._sources.totalRevenue[0]].dimension,'ProductOrService=OilAndGas');
 assert.deepEqual(p.validateFinancial(d,'0000000123','2026-10-03'),[]);
});
// A balance sheet presented in segment columns (statement-lines columnSum). Berkshire's 10-Q
// 0001193125-26-341032 for 2026-06-30, axis ProductOrService: Assets 1,010,646 + 252,425 = 1,263,071;
// cash 35,096 + 5,513 = 40,609 and PP&E 39,409 + 185,815 = 225,224, with no plain figures at all.
test('columnSum takes one allow-listed axis whose member Assets sum exactly, and ignores members outside it',()=>{
 const assets={plain:1263071000000,axes:new Map([['ProductOrService',new Map([['InsuranceAndOther',1010646000000],['RailroadUtilitiesAndEnergy',252425000000]])]])};
 const cash={plain:null,axes:new Map([['ProductOrService',new Map([['InsuranceAndOther',35096000000],['RailroadUtilitiesAndEnergy',5513000000]])]])};
 const ppe={plain:null,axes:new Map([['ProductOrService',new Map([['InsuranceAndOther',39409000000],['RailroadUtilitiesAndEnergy',185815000000],['Railroad',72776000000],['UtilitiesAndEnergy',113039000000]])]])};
 assert.deepEqual(lines.columnSum(assets,cash),{axis:'ProductOrService',members:['InsuranceAndOther','RailroadUtilitiesAndEnergy'],values:[35096000000,5513000000],assets:[1010646000000,252425000000],sum:40609000000});
 assert.deepEqual(lines.columnSum(assets,ppe),{axis:'ProductOrService',members:['InsuranceAndOther','RailroadUtilitiesAndEnergy'],values:[39409000000,185815000000],assets:[1010646000000,252425000000],sum:225224000000});
 // a plain figure present, a column missing, a member with two figures, Assets not summing, one member only.
 assert.equal(lines.columnSum(assets,{plain:40609000000,axes:cash.axes}),null);
 assert.equal(lines.columnSum(assets,{plain:null,axes:new Map([['ProductOrService',new Map([['InsuranceAndOther',35096000000]])]])}),null);
 assert.equal(lines.columnSum(assets,{plain:null,axes:new Map([['ProductOrService',new Map([['InsuranceAndOther',35096000000],['RailroadUtilitiesAndEnergy',NaN]])]])}),null);
 assert.equal(lines.columnSum({plain:100,axes:new Map([['ProductOrService',new Map([['A',60],['B',50]])]])},cash),null);
 assert.equal(lines.columnSum({plain:100,axes:new Map([['ProductOrService',new Map([['A',100]])]])},cash),null);
 // Vroom's fresh-start columns are adjustments, not parts of the company: a member's negative Assets
 // (2024-12-31: predecessor + plan effect + fresh-start adjustment = 0), or an axis outside the allow-list.
 const fresh=(axis,a,b,c)=>({plain:0,axes:new Map([[axis,new Map([['Predecessor',a],['PlanEffect',b],['FreshStartAdjustment',c]])]])});
 assert.equal(lines.columnSum(fresh('FreshStartAdjustmentsTypeOfFreshStartAdjustment',1,-2,1),cash),null,'axis not allow-listed');
 assert.equal(lines.columnSum(fresh('ProductOrService',1,-2,1),cash),null,'a negative member Assets');
 // two axes both summing to the plain Assets: ambiguous, so nothing.
 assert.equal(lines.columnSum({plain:100,axes:new Map([['ProductOrService',new Map([['A',60],['B',40]])],['BusinessSegments',new Map([['X',70],['Y',30]])]])},cash),null);
});
const column=o=>({s:'balance',k:'columns',f:'cashAndCashEquivalentsAtCarryingValue',e:'2025-12-31',q:0,u:'USD',t:'us-gaap',c:'CashAndCashEquivalentsAtCarryingValue',l:'Cash and cash equivalents',x:'ProductOrService',g:['InsuranceAndOther','RailroadUtilitiesAndEnergy'],v:[35096000000,5513000000],ta:[1010646000000,252425000000],a:ACC,m:'10-K',d:'2026-02-01',...o});
const columnRow=(statementLines,assets=1263071000000,cash)=>{const {doc,evidence}=fixture();doc.facts['us-gaap'].Assets.units.USD[0].val=assets;if(cash!=null)doc.facts['us-gaap'].CashAndCashEquivalentsAtCarryingValue={units:{USD:[{val:cash,end:'2025-12-31',accn:ACC,form:'10-K',filed:'2026-02-01'}]}};const d=extract(doc,evidence,{asOf:'2026-10-03',statementLines});return {d,row:d.balance.annualReports[0]};};
test('a balance sheet presented in segment columns fills a blank cell with the column sum (Berkshire: cash 35,096 + 5,513)',()=>{
 const {d,row}=columnRow([column()]);
 assert.equal(row.cashAndCashEquivalentsAtCarryingValue,40609000000);
 assert.deepEqual(row._derivations.cashAndCashEquivalentsAtCarryingValue,{formula:'sum_member_columns',axis:'ProductOrService',members:['InsuranceAndOther','RailroadUtilitiesAndEnergy'],inputValues:[35096000000,5513000000],memberAssets:[1010646000000,252425000000],presentedConcept:'CashAndCashEquivalentsAtCarryingValue'});
 assert.deepEqual(row._sources.cashAndCashEquivalentsAtCarryingValue.map(id=>d.sources[id].dimension),['ProductOrService=InsuranceAndOther','ProductOrService=RailroadUtilitiesAndEnergy']);
 assert.equal(p.verifiedField(d,row,'cashAndCashEquivalentsAtCarryingValue'),true);
 assert.deepEqual(p.validateFinancial(d,d.cik,'2026-10-03'),[]);
 // the columns must add up to this row's own total assets; a filed figure is never replaced.
 assert.equal(columnRow([column()],1263071000001).row.cashAndCashEquivalentsAtCarryingValue,null);
 const kept=columnRow([column()],1263071000000,51000000000);
 assert.equal(kept.row.cashAndCashEquivalentsAtCarryingValue,51000000000);
 assert.equal(kept.row._derivations.cashAndCashEquivalentsAtCarryingValue,undefined);
});
test('the validator re-checks a column sum against its columns and the row\'s own total assets',()=>{
 const {d,row}=columnRow([column()]),first=r=>r._sources.cashAndCashEquivalentsAtCarryingValue[0];
 for(const tamper of [r=>{r.cashAndCashEquivalentsAtCarryingValue=40609000001;},(r,c)=>{c.sources[first(r)].rawValue=35096000001;},(r,c)=>{c.sources[first(r)].periodStart='2025-01-01';},
  r=>{r._derivations.cashAndCashEquivalentsAtCarryingValue.members=['RailroadUtilitiesAndEnergy','InsuranceAndOther'];},r=>{r.totalAssets=1263071000001;}]){
  const copy=structuredClone(d),r=copy.balance.annualReports[0];tamper(r,copy);assert.equal(p.verifiedField(copy,r,'cashAndCashEquivalentsAtCarryingValue'),false);
 }
});
// The data sets file a period end at its month end (Hershey 10-Q 0001628280-26-050900: quarter ended 2026-06-28,
// every ddate 20260630), so a row whose period does not end on a month end looks its lines up at the rounded date.
test('the data-set date of a period end is the nearest month end within ten days',()=>{
 const {dataSetDate}=require('../sec-facts');
 assert.equal(dataSetDate('2026-06-28'),'2026-06-30');
 assert.equal(dataSetDate('2026-06-27'),'2026-06-30');
 assert.equal(dataSetDate('2026-07-03'),'2026-06-30');
 assert.equal(dataSetDate('2026-08-02'),'2026-07-31');
 assert.equal(dataSetDate('2026-09-03'),'2026-08-31');
 assert.equal(dataSetDate('2026-01-03'),'2025-12-31');
 assert.equal(dataSetDate('2026-06-15'),'2026-06-15','too far from either month end: no rounding');
 assert.equal(dataSetDate('2025-12-31'),'2025-12-31','a month end is its own date');
});
const QACC='0000000123-26-000004';
const hershey=()=>{const {doc,evidence}=fixture();doc.facts['us-gaap'].Revenues.units.USD.push({val:1000,start:'2026-03-29',end:'2026-06-28',accn:QACC,form:'10-Q',filed:'2026-08-12'});return {doc,evidence};};
const qline=o=>({s:'income',f:'eps',t:'us-gaap',c:'EarningsPerShareBasic',l:'Net income per share - basic (USD per share)',u:'USD/shares',v:1.03,e:'2026-06-30',q:1,a:QACC,m:'10-Q',d:'2026-08-12',...o});
test('a line the data set files at the month end fills the quarter it rounds to (Hershey 2026-06-28)',()=>{
 const {doc,evidence}=hershey();
 // Per-class EPS: Hershey files CommonStock 1.03 and CommonClassB 0.94 at 20260630; the row keeps both.
 const per=(g,v)=>qline({g:'ClassOfStock='+g,v});
 const d=extract(doc,evidence,{asOf:'2026-10-03',statementLines:[per('CommonStock',1.03),per('CommonClassB',0.94)]}),row=d.income.quarterlyReports.find(r=>r.fiscalDateEnding==='2026-06-28');
 assert.equal(row.eps,null);
 assert.deepEqual(Object.keys(row._classes.eps).sort(),['CommonClassB','CommonStock']);
 assert.equal(row._classes.eps.CommonStock.v,1.03);assert.equal(row._classes.eps.CommonClassB.v,0.94);
 // One line without a dimension fills the row, and the source carries the row's own end, not the data set's.
 const one=extract(doc,evidence,{asOf:'2026-10-03',statementLines:[qline({v:1.03})]}),r=one.income.quarterlyReports.find(r=>r.fiscalDateEnding==='2026-06-28');
 assert.equal(r.eps,1.03);assert.equal(one.sources[r._sources.eps[0]].periodEnd,'2026-06-28');
 assert.equal(p.verifiedField(one,r,'eps'),true);
 // The same line from a filing the row does not cite fills nothing.
 const other=extract(doc,evidence,{asOf:'2026-10-03',statementLines:[qline({a:'0000000123-26-000009'})]});
 assert.equal(other.income.quarterlyReports.find(r=>r.fiscalDateEnding==='2026-06-28').eps,null);
});
test('a quarter whose end is more than ten days from a month end is not rounded to one',()=>{
 const {doc,evidence}=fixture();doc.facts['us-gaap'].Revenues.units.USD.push({val:1000,start:'2026-03-15',end:'2026-06-15',accn:QACC,form:'10-Q',filed:'2026-07-30'});
 const d=extract(doc,evidence,{asOf:'2026-10-03',statementLines:[qline({e:'2026-06-30',d:'2026-07-30'})]});
 assert.equal(d.income.quarterlyReports.find(r=>r.fiscalDateEnding==='2026-06-15').eps,null);
});
test('presented capex and column lines are looked up at the data set\'s month end too',()=>{
 const {doc,evidence}=hershey();
 doc.facts['us-gaap'].NetCashProvidedByUsedInOperatingActivities.units.USD.push({val:50,start:'2026-03-29',end:'2026-06-28',accn:QACC,form:'10-Q',filed:'2026-08-12'});
 doc.facts['us-gaap'].Assets.units.USD.push({val:1263071,end:'2026-06-28',accn:QACC,form:'10-Q',filed:'2026-08-12'});
 const spend={s:'cash',k:'capex',f:'',e:'2026-06-30',q:1,u:'USD',c:['PaymentsToAcquireToolsDiesAndMolds'],t:['custom'],l:['Purchases of tools, dies, and molds'],v:[71374],a:QACC,m:'10-Q',d:'2026-08-12'};
 const cols={s:'balance',k:'columns',f:'cashAndCashEquivalentsAtCarryingValue',e:'2026-06-30',q:0,u:'USD',t:'us-gaap',c:'CashAndCashEquivalentsAtCarryingValue',l:'Cash and cash equivalents',x:'ProductOrService',g:['InsuranceAndOther','RailroadUtilitiesAndEnergy'],v:[35096,5513],ta:[1010646,252425],a:QACC,m:'10-Q',d:'2026-08-12'};
 const d=extract(doc,evidence,{asOf:'2026-10-03',statementLines:[spend,cols]}),cash=d.cash.quarterlyReports.find(r=>r.fiscalDateEnding==='2026-06-28'),bal=d.balance.quarterlyReports.find(r=>r.fiscalDateEnding==='2026-06-28');
 assert.equal(cash.capitalExpenditures,-71374);assert.equal(p.verifiedField(d,cash,'capitalExpenditures'),true);
 assert.equal(bal.cashAndCashEquivalentsAtCarryingValue,40609);assert.equal(p.verifiedField(d,bal,'cashAndCashEquivalentsAtCarryingValue'),true);
});
