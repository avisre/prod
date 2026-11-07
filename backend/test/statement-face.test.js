'use strict';
// A cell whose mapped tag was rejected (a stand-in that would miss a part, or a debt part that would double-count) is
// filled from the lines the statement itself presents, as filed: the face record lists the statement's lines in order,
// and the cell is the filed sum of the family's members only when no other line could belong to it.
const test=require('node:test');
const assert=require('node:assert/strict');
const {extract}=require('../sec-facts');
const p=require('../sec-coverage');
const lines=require('../statement-lines');
const {fixture}=require('./sec-facts.test');
const ACC='0000000123-26-000001',LATER='0000000123-26-000007';

const put=(doc,tag,val,{accn=ACC,form='10-K',filed='2026-02-01',start}={})=>{(doc.facts['us-gaap'][tag] ??= {units:{USD:[]}}).units.USD.push({val,...(start?{start}:{}),end:'2025-12-31',accn,form,filed});};
const face=(s,c,o={})=>({s,k:'face',f:'',e:'2025-12-31',c,a:ACC,m:'10-K',d:'2026-02-01',...o});
const BALANCE=(...debt)=>['AssetsCurrent','Assets',...debt,'LiabilitiesCurrent','LongTermDebtNoncurrent','StockholdersEquity'];
const run=(facts,records,{st='balance',start}={})=>{const {doc,evidence}=fixture();for(const [t,v] of Object.entries(facts))put(doc,t,v,{start});const d=extract(doc,evidence,{asOf:'2026-10-03',statementLines:records});return {d,row:d[st].annualReports[0]};};

test('a face line is a family member by its standard tag; a line named for the family under another tag blocks the sum',()=>{
 const t=(stmt,tag,label,custom=false)=>lines.faceToken(stmt,tag,label,custom);
 assert.equal(t('CF','Depreciation','Depreciation'),'Depreciation');
 assert.equal(t('CF','FinanceLeaseRightOfUseAssetAmortization','Amortization of finance lease right-of-use assets'),'FinanceLeaseRightOfUseAssetAmortization');
 // Alamo: rental-equipment depreciation tagged EquipmentExpense. Summing the other lines would understate D&A.
 assert.equal(t('CF','EquipmentExpense','Depreciation - Rental Equipment'),'~da');
 // Broadcom: one custom line mixing intangible and right-of-use amortization.
 assert.equal(t('CF','AvgoAmortization','Amortization of intangible and right-of-use assets',true),'~da');
 // Lines that are not depreciation or amortization of the business's assets are neither members nor blocks.
 for(const [tag,label] of [['AmortizationOfFinancingCosts','Amortization of deferred financing costs'],['OperatingLeaseRightOfUseAssetAmortizationExpense','Amortization of operating lease right-of-use assets'],['ShareBasedCompensation','Stock-based compensation']])
  assert.equal(t('CF',tag,label),null,label);
 assert.equal(t('IS','Custom','General and administrative',true),'~sga');
 assert.equal(t('BS','Custom','Other assets',true),'~otherassets');
 assert.equal(t('BS','Custom','Accounts payable and accrued expenses',true),'~payable');
});

test('a family is summed only when every line of it on the face is a member',()=>{
 assert.deepEqual(lines.faceParts('cash|depreciationDepletionAndAmortization',['Depreciation','AmortizationOfIntangibleAssets']),['Depreciation','AmortizationOfIntangibleAssets']);
 assert.equal(lines.faceParts('cash|depreciationDepletionAndAmortization',['Depreciation','AmortizationOfIntangibleAssets','~da']),null);
 assert.deepEqual(lines.faceParts('balance|shortTermDebt',BALANCE('CommercialPaper','LongTermDebtCurrent')),['CommercialPaper','LongTermDebtCurrent']);
 // A current-liabilities debt line under a tag outside the family could be part of it.
 assert.equal(lines.faceParts('balance|shortTermDebt',BALANCE('CommercialPaper','LongTermDebtCurrent','~debt')),null);
});

test('a rejected D&A cell is the sum of the D&A lines the cash-flow statement presents, cited to each filed fact',()=>{
 const facts={Depreciation:40,AmortizationOfIntangibleAssets:10,CapitalizedComputerSoftwareAmortization1:5},cash={st:'cash',start:'2025-01-01'};
 // Without the face, depreciation alone cannot stand in for D&A: the filing tags other amortization beside it.
 assert.equal(run(facts,[],cash).row.depreciationDepletionAndAmortization,null);
 const {d,row}=run(facts,[face('cash',['Depreciation','AmortizationOfIntangibleAssets','CapitalizedComputerSoftwareAmortization1'])],cash);
 assert.equal(row.depreciationDepletionAndAmortization,55);
 assert.deepEqual(row._derivations.depreciationDepletionAndAmortization,{formula:'sum_of_parts',parts:['us-gaap:Depreciation','us-gaap:AmortizationOfIntangibleAssets','us-gaap:CapitalizedComputerSoftwareAmortization1'],inputValues:[40,10,5],presented:true});
 assert.equal(p.verifiedField(d,row,'depreciationDepletionAndAmortization'),true);
 // A D&A line the face presents under another tag leaves the cell blank.
 assert.equal(run(facts,[face('cash',['Depreciation','AmortizationOfIntangibleAssets','CapitalizedComputerSoftwareAmortization1','~da'])],cash).row.depreciationDepletionAndAmortization,null);
});

test('short-term debt is the current debt lines on the face; any other debt line in the block refuses it',()=>{
 const facts={CommercialPaper:30,LongTermDebtCurrent:20,LongTermDebtNoncurrent:300};
 assert.equal(run(facts,[]).row.shortTermDebt,null);
 const {d,row}=run(facts,[face('balance',BALANCE('CommercialPaper','LongTermDebtCurrent'))]);
 assert.equal(row.shortTermDebt,50);assert.equal(row._derivations.shortTermDebt.presented,true);
 assert.equal(p.verifiedField(d,row,'shortTermDebt'),true);
 assert.equal(row.shortLongTermDebtTotal,350);
 assert.equal(run(facts,[face('balance',BALANCE('CommercialPaper','LongTermDebtCurrent','~debt'))]).row.shortTermDebt,null);
});

test('the coverage check holds a presented sum to its own filed facts',()=>{
 const {d,row}=run({CommercialPaper:30,LongTermDebtCurrent:20,LongTermDebtNoncurrent:300},[face('balance',BALANCE('CommercialPaper','LongTermDebtCurrent'))]);
 const check=edit=>{const x=JSON.parse(JSON.stringify(d)),r=x.balance.annualReports[0];edit(x,r);return p.verifiedField(x,r,'shortTermDebt');};
 assert.equal(check(()=>{}),true);
 assert.equal(check((x,r)=>{r.shortTermDebt=51;}),false,'the cell is the sum');
 assert.equal(check((x,r)=>{r._derivations.shortTermDebt.parts.reverse();}),false,'each part is its own fact');
 assert.equal(check((x,r)=>{r._derivations.shortTermDebt.parts=['us-gaap:CommercialPaper','us-gaap:OtherLiabilitiesCurrent'];}),false,'only family members');
 assert.equal(check((x,r)=>{x.sources[r._sources.shortTermDebt[1]].accessionNumber=LATER;}),false,'one filing');
 assert.equal(check((x,r)=>{r._derivations.shortTermDebt.statement=ACC;}),false,'a statement filing is named only when it is not the anchor');
 // A line equal to the sum of the others is their subtotal, not a part.
 const sub=run({CommercialPaper:30,LongTermDebtCurrent:20,ShortTermBorrowings:50,LongTermDebtNoncurrent:300},[face('balance',BALANCE('CommercialPaper','LongTermDebtCurrent','ShortTermBorrowings'))]);
 assert.notEqual(sub.row.shortTermDebt,100);
});

test('a column a later filing repeats is read from that filing\'s statement when the annual filing predates the data sets',()=>{
 const {doc,evidence}=fixture();
 doc.facts['us-gaap'].Assets.units.USD.push({val:100,end:'2025-12-31',accn:LATER,form:'10-Q',filed:'2026-05-01'});
 for(const [accn,form,filed] of [[ACC,'10-K','2026-02-01'],[LATER,'10-Q','2026-05-01']])for(const [t,v] of [['CommercialPaper',30],['LongTermDebtCurrent',20],['LongTermDebtNoncurrent',300]])put(doc,t,v,{accn,form,filed});
 const d=extract(doc,evidence,{asOf:'2026-10-03',statementLines:[face('balance',BALANCE('CommercialPaper','LongTermDebtCurrent'),{a:LATER,m:'10-Q',d:'2026-05-01',e:'2026-03-31'})]}),row=d.balance.annualReports[0];
 assert.equal(row.shortTermDebt,50);assert.equal(row._derivations.shortTermDebt.statement,LATER);
 assert.equal(p.verifiedField(d,row,'shortTermDebt'),true);
 const x=JSON.parse(JSON.stringify(d)),r=x.balance.annualReports[0];delete r._derivations.shortTermDebt.statement;
 assert.equal(p.verifiedField(x,r,'shortTermDebt'),false,'the facts are the named statement\'s');
 // A later filing reporting a different total assets is another balance sheet.
 doc.facts['us-gaap'].Assets.units.USD[1].val=101;
 assert.equal(extract(doc,evidence,{asOf:'2026-10-03',statementLines:[face('balance',BALANCE('CommercialPaper','LongTermDebtCurrent'),{a:LATER,m:'10-Q',d:'2026-05-01',e:'2026-03-31'})]}).balance.annualReports[0].shortTermDebt,null);
});

test('a debt total is summed again when a later line fill re-cites one of its parts (Corteva 2024)',()=>{
 const {doc,evidence}=fixture();put(doc,'DebtCurrent',750);put(doc,'LongTermDebtAndCapitalLeaseObligations',1953);
 const line={s:'balance',f:'longTermDebt',t:'us-gaap',c:'LongTermDebtAndCapitalLeaseObligations',l:'Long-term debt',u:'USD',v:1953,e:'2025-12-31',q:0,a:ACC,m:'10-K',d:'2026-02-01'};
 const d=extract(doc,evidence,{asOf:'2026-10-03',statementLines:[line]}),row=d.balance.annualReports[0];
 assert.equal(d.sources[row._sources.longTermDebt[0]].verificationMethod,'statement_line');
 assert.equal(row.shortLongTermDebtTotal,2703);assert.deepEqual(row._sources.shortLongTermDebtTotal,[...row._sources.shortTermDebt,...row._sources.longTermDebt]);
 assert.equal(p.verifiedField(d,row,'shortLongTermDebtTotal'),true);
});

test('total debt counts a current debt line the face presents and the debt record leaves out (TransDigm 2025)',()=>{
 const facts={LongTermDebtCurrent:124,ShortTermBankLoansAndNotesPayable:724,LongTermDebtNoncurrent:29167};
 const debt={s:'balance',k:'debt',f:'',e:'2025-12-31',c:['LongTermDebtCurrent','LongTermDebtNoncurrent'],a:ACC,m:'10-K',d:'2026-02-01'};
 // The debt record alone gives the two lines it names.
 assert.equal(run(facts,[debt]).row.shortLongTermDebtTotal,29291);
 const {d,row}=run(facts,[debt,face('balance',BALANCE('LongTermDebtCurrent','ShortTermBankLoansAndNotesPayable'))]);
 assert.equal(row.shortTermDebt,848);
 assert.equal(row.shortLongTermDebtTotal,30015);assert.equal(row._derivations.shortLongTermDebtTotal.formula,'sum_fields');
 assert.equal(p.verifiedField(d,row,'shortLongTermDebtTotal'),true);
});

test('a bank overdraft line on the face is no part of short-term debt, and refuses a face-read one (Werner 2023)',()=>{
 assert.equal(lines.faceToken('BS','BankOverdrafts','Checks issued in excess of cash balances'),'~debt');
 const facts={LongTermDebtCurrent:20,BankOverdrafts:15,LongTermDebtNoncurrent:670};
 const debt={s:'balance',k:'debt',f:'',e:'2025-12-31',c:['LongTermDebtCurrent','LongTermDebtNoncurrent'],a:ACC,m:'10-K',d:'2026-02-01'};
 // Stored face records keep the raw tag; the extract treats it as a blocker either way.
 for(const tok of ['BankOverdrafts','~debt']){
  const {row}=run(facts,[debt,face('balance',BALANCE('LongTermDebtCurrent',tok))]);
  assert.notEqual(row.shortTermDebt,35,tok);
  assert.equal(row.shortLongTermDebtTotal,690,tok);
 }
});

test('a zero current-maturities line beside commercial paper still gives the face total (Clorox 2025)',()=>{
 const facts={CommercialPaper:4,LongTermDebtCurrent:0,LongTermDebtNoncurrent:2484};
 const {d,row}=run(facts,[face('balance',BALANCE('CommercialPaper','LongTermDebtCurrent'))]);
 assert.equal(row.shortLongTermDebtTotal,2488);assert.equal(p.verifiedField(d,row,'shortLongTermDebtTotal'),true);
 // A non-zero current maturity beside it is still refused as a possible double count.
 assert.notEqual(run({...facts,LongTermDebtCurrent:5},[face('balance',BALANCE('CommercialPaper','LongTermDebtCurrent'))]).row.shortLongTermDebtTotal,2488);
});

test('newestFiling names the latest filing among a field\'s sources, and nothing when one is missing',()=>{
 const data={sources:{a:{filingDate:'2026-02-01',accessionNumber:'0000000123-26-000001'},b:{filingDate:'2025-11-01',accessionNumber:'0000000123-25-000009'},c:{filingDate:'2026-02-01',accessionNumber:'0000000123-26-000002'}}};
 assert.equal(p.newestFiling(data,['b','a']),'0000000123-26-000001');
 assert.equal(p.newestFiling(data,['a','c']),'0000000123-26-000002');
 assert.equal(p.newestFiling(data,['a','missing']),null);
 assert.equal(p.newestFiling(data,[]),null);
});
