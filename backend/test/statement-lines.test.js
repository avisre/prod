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

test('an allowance or accumulated depreciation clause reads as ", net", and nothing else after it does',()=>{
 const bs=(l,tag='ReceivablesNetCurrent')=>lines.fieldsFor('BS',l,tag,{crdr:'D',mapped});
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
