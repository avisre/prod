'use strict';
// Statement lines the company-facts feed cannot reach. SEC's companyfacts carries
// standard-taxonomy facts only, with no company-defined tags and no facts on a
// dimension. A filing that tags a total under its own name, or files its EPS only
// per class of stock (ORKA: ClassOfStock=CommonStock, -1.85), shows that figure on
// the face of its statements and still left our cell blank: on
// 2026-10-17, 3,860 latest-year cells across the covered companies.
//
// SEC's Financial Statement Data Sets publish every number on the face of every
// XBRL filing's primary statements with the line's printed label (pre.txt plabel)
// and its tag, custom or standard (README: "all numeric XBRL facts presented on
// the primary financial statements"). A line is mapped to a field only by its
// statement and a strict reading of its own label, and only where no standard tag
// of ours already covers it. Lines fill a figure in a period that already exists;
// they never add a year or quarter (sec-facts.js).
//
// Record keys (kept short: one file per issuer, thousands of issuers):
//   s statement (income|balance|cash)  f field          t taxonomy (custom: the filer's prefix)
//   c concept   l printed label        u unit           v value as filed
//   e period end (YYYY-MM-DD)          q quarters (0 instant, 1 quarter, 4 year)
//   a accession m form  d filing date  g dimension ("ClassOfStock=CommonStock"), if any
const fs=require('node:fs'),path=require('node:path'),p=require('./sec-coverage');
const STATEMENT={IS:'income',BS:'balance',CF:'cash'};
const ANY='(?:income|loss|\\(loss\\) income|income \\(loss\\)|earnings|\\(loss\\) earnings|earnings \\(loss\\)|profit|\\(loss\\) profit|profit \\(loss\\))';
// "attributable to common stockholders", wherever a per-share label puts it.
const TO='(?: attributable to (?:the )?(?:common |ordinary |class a common |class a ordinary )?(?:stockholders|shareholders|share ?holders|owners of the parent|equity holders of the parent))?';
const PER=`${TO} per (?:common |ordinary |basic |diluted )?share${TO}`;
const re=s=>new RegExp(s);
// [statement, field, label, tag?]. Labels are matched whole, after normalising case, spacing
// and quotes; a rule with a fourth entry also needs the line's tag to match it.
const RULES=[
 ['IS','totalRevenue',/^(?:total )?(?:net )?(?:operating )?(?:revenues?|sales)(?:, net| net)?$|^total (?:net )?(?:revenues?|sales)$|^revenues?, net$|^net (?:sales|revenues?)$|^total (?:home )?closing revenues?$|^total income$/],
 ['IS','costOfRevenue',/^(?:total )?cost of (?:revenues?|sales|goods sold|products sold)$/],
 ['IS','grossProfit',/^gross (?:profit|margin|loss|\(loss\) profit|profit \(loss\))$/],
 ['IS','operatingIncome',re(`^(?:total )?operating ${ANY}$|^${ANY} from operations$`)],
 ['IS','operatingExpenses',/^total operating (?:expenses|costs and expenses)$/],
 ['IS','sellingGeneralAndAdministrative',/^selling, general,? and administrative(?: expenses?)?$/],
 ['IS','researchAndDevelopment',/^research and development(?: expenses?| costs)?$/],
 ['IS','interestExpense',/^interest expense$/],
 ['IS','incomeBeforeTax',re(`^(?:net )?${ANY} before (?:provision for |benefit from |\\(benefit\\) provision for |provision \\(benefit\\) for )?(?:income )?tax(?:es)?$`)],
 ['IS','incomeTaxExpense',/^(?:provision for|benefit from|\(benefit\) provision for|provision \(benefit\) for|\(provision\) benefit for|benefit \(provision\) for) income taxes$|^income tax (?:expense|provision|benefit|expense \(benefit\)|\(benefit\) expense)$|^income taxes$/],
 ['IS','netIncome',re(`^net ${ANY}(?: and comprehensive ${ANY})?$|^${ANY} for the (?:year|period)$`)],
 ['IS','eps',re(`^(?:net )?${ANY}${PER},? (?:- |— )?basic$|^basic(?: net)?(?: ${ANY})?${PER}$|^basic$`)],
 ['IS','dilutedEPS',re(`^(?:net )?${ANY}${PER},? (?:- |— )?diluted$|^diluted(?: net)?(?: ${ANY})?${PER}$|^diluted$`)],
 ['IS','eps+dilutedEPS',re(`^(?:net )?${ANY}${PER},? (?:- |— )?basic and diluted$|^basic and diluted(?: net)?(?: ${ANY})?(?:${PER})?$`)],
 ['BS','totalAssets',/^total assets$/],
 ['BS','totalLiabilities',/^total liabilities$/],
 ['BS','totalCurrentAssets',/^total current assets$/],
 ['BS','totalCurrentLiabilities',/^total current liabilities$/],
 ['BS','totalShareholderEquity',/^total (?:stockholders|shareholders|share ?holders)'?s?'? (?:equity|deficit|equity \(deficit\)|\(deficit\) equity|deficiency|deficit \(equity\))$/],
 ['BS','cashAndCashEquivalentsAtCarryingValue',/^cash and cash equivalents$/],
 ['BS','inventory',/^inventor(?:y|ies)(?:, net)?$/],
 ['BS','currentNetReceivables',/^(?:accounts|trade)(?: and (?:notes|other))? receivables?(?:, net)?$|^receivables, net$/],
 ['BS','goodwill',/^goodwill$/],
 ['BS','propertyPlantEquipment',/^property(?:, plant)?,? (?:and|&) equipment, net$/],
 ['BS','intangibleAssetsExcludingGoodwill',/^intangible assets(?:, net)?$|^intangibles(?:, net)?$/],
 ['BS','operatingLeaseRightOfUseAsset',/^operating lease right[- ]of[- ]use assets?(?:, net)?$/],
 ['BS','currentAccountsPayable',/^accounts payable$|^trade accounts payable$|^accounts payable, trade$/],
 ['BS','retainedEarnings',/^retained earnings$|^accumulated deficit$|^retained earnings \(accumulated deficit\)$|^\(accumulated deficit\) retained earnings$/],
 ['BS','longTermDebt',/^long-term debt(?:, net)?,? (?:net of|less|excluding) current (?:portion|maturities)$/],
 // A bare "long-term debt" is the noncurrent part only where the tag says so; on an
 // unclassified balance sheet the same words are the whole debt.
 ['BS','longTermDebt',/^long-term debt(?:, net)?$/,/Noncurrent|^LongTermDebtAndCapitalLeaseObligations$/],
 ['BS','deposits',/^total deposits$/],
 ['CF','operatingCashflow',/^net cash (?:provided by|used in|provided by \(used in\)|\(used in\) provided by|used by|from|flows? from) operating activities$|^net cash flows? (?:from|provided by|used in) operating activities$/],
 ['CF','cashflowFromInvestment',/^net cash (?:provided by|used in|provided by \(used in\)|\(used in\) provided by|used by|from|flows? from) investing activities$|^net cash flows? (?:from|provided by|used in) investing activities$/],
 ['CF','cashflowFromFinancing',/^net cash (?:provided by|used in|provided by \(used in\)|\(used in\) provided by|used by|from|flows? from) financing activities$|^net cash flows? (?:from|provided by|used in) financing activities$/],
 ['CF','capitalExpenditures',/^(?:purchases? of|capital expenditures for|additions to|payments for|acquisitions? of) property(?:, plant)?,? (?:and|&) equipment$|^capital expenditures$/],
 ['CF','shareBasedCompensation',/^(?:stock|share|equity)[- ]based compensation(?: expense)?$/],
 ['CF','dividendPayout',/^(?:cash )?dividends paid$|^payments? of (?:cash )?dividends$/],
 ['CF','paymentsForRepurchaseOfCommonStock',/^(?:repurchases?|purchases?) of (?:common|treasury) stock$/],
 ['CF','depreciationDepletionAndAmortization',/^depreciation and amortization$|^depreciation, depletion and amortization$/]
];
// Parts and other entities' figures that a whole-label match could still mistake for the total.
const EXCLUDE=/related[- ]part|affiliat|discontinued|held for sale|predecessor|successor|pro forma|guarantor|variable interest|\bvie\b/;
const PER_SHARE=/PerShare|PerUnit|PerOutstanding|EarningsPer|LossPer|IncomePer/i;
// The balance (credit or debit) a field's own tags carry. A company-defined
// "net loss" element filed as a positive debit is a loss written as a positive
// number, and read as net income it would turn a loss into a profit; a line whose
// tag declares the other balance, or none, is not read. Cash-flow lines are not
// checked: outflows are stored with their sign forced, and the three totals carry
// no balance in the standard taxonomy either.
const BALANCE={totalRevenue:'C',grossProfit:'C',operatingIncome:'C',incomeBeforeTax:'C',netIncome:'C',costOfRevenue:'D',operatingExpenses:'D',sellingGeneralAndAdministrative:'D',researchAndDevelopment:'D',interestExpense:'D',incomeTaxExpense:'D',
 totalAssets:'D',totalCurrentAssets:'D',cashAndCashEquivalentsAtCarryingValue:'D',inventory:'D',currentNetReceivables:'D',goodwill:'D',propertyPlantEquipment:'D',intangibleAssetsExcludingGoodwill:'D',operatingLeaseRightOfUseAsset:'D',
 totalLiabilities:'C',totalCurrentLiabilities:'C',totalShareholderEquity:'C',currentAccountsPayable:'C',retainedEarnings:'C',longTermDebt:'C',deposits:'C'};
// A label is read only when the tag behind it does not say otherwise. Measured on
// 2026q3: 137 "loss before income taxes" lines tagged as income attributable to the
// parent, 16 "net loss" lines tagged as comprehensive income, 38 "intangible assets,
// net" lines tagged as intangibles including goodwill. The filing's tag and its label
// disagree there, and neither is taken.
const TAG_DENY=/Comprehensive|IncludingGoodwill|RelatedPart|Domestic|Foreign|Discontinued|Segment|Affiliate/i;
const STD_DENY=new Set(['IncomeLossAttributableToParent','IncomeLossIncludingPortionAttributableToNoncontrollingInterest','Depreciation','CostOfGoodsAndServicesSoldDepreciationAndAmortization','InterestExpenseOther','InterestExpenseRelatedParty']);
// A current figure never comes from a tag the filer defined as noncurrent.
const CURRENT=/^(?!.*Noncurrent)/;
const TAG_REQUIRE={inventory:CURRENT,currentNetReceivables:CURRENT,cashAndCashEquivalentsAtCarryingValue:CURRENT,currentAccountsPayable:CURRENT,totalCurrentAssets:CURRENT,totalCurrentLiabilities:CURRENT,intangibleAssetsExcludingGoodwill:/^(?!.*Goodwill)|(?:Excluding|OtherThan)Goodwill/,incomeBeforeTax:/Tax/i,incomeTaxExpense:/Tax/i,netIncome:/^(?!.*(?:BeforeIncomeTax|BeforeTax|OperatingIncome|Operations$)).*/i};
function label(s){return String(s || '').toLowerCase().replace(/[’‘`]/g,"'").replace(/\s+/g,' ').replace(/\s*\(in [^()]*\)$/,'').replace(/\s*\((?:note|notes) [\d, and]+\)$/,'').replace(/[:*]+$/,'').trim();}
// "Net of an allowance of $1 at December 31, 2025 and 2024" says how a net figure was
// reached, not what it is, and reads as ", net". Only amounts, dates and connectors may
// follow the allowance, so "net of allowance, and unbilled receivables" stays unread.
const AMOUNT='\\$ ?[\\d,.]+(?: (?:thousand|million|billion))?|[\\d,.]+';
const DATE='(?:(?:january|february|march|april|may|june|july|august|september|october|november|december) \\d{1,2},? )?\\d{4}';
const ALLOWANCE='(?:an? |the )?(?:allowances?(?: for (?:credit losses|doubtful accounts|doubtful receivables|expected credit losses|current expected credit losses|bad debts|uncollectible accounts|estimated uncollectible accounts|losses))?|accumulated (?:depreciation|amortization)(?: and (?:amortization|depreciation))?)';
const DETAIL=`(?:,? (?:of|at|as of|in|and|respectively|${AMOUNT}|${DATE}))*`;
const NET_OF=new RegExp(`(?:,? (?:net of|less) ${ALLOWANCE}${DETAIL}|,? \\((?:net of|less) ${ALLOWANCE}${DETAIL}\\)|, after allowance for credit loss(?:es)?)(?:, current)?$`);
function netLabel(text){return text.replace(NET_OF,', net').replace(/ [-–—] net$/,', net').replace(/, net, current$/,', net');}
// Every tag the extraction already reads, plus the ones it must not: the totals
// it uses only as arithmetic checks and those the validator refuses for a field.
function mappedTags(){
 const {MAPS}=require('./sec-facts'),out=new Set(['CostsAndExpenses','PreferredStockDividendsIncomeStatementImpact','DividendsPreferredStock','NetIncomeLossAttributableToNoncontrollingInterest',...Object.values(p.INCOMPATIBLE).flat()]);
 for(const fields of Object.values(MAPS))for(const def of Object.values(fields))for(const t of ['us-gaap','ifrs-full'])for(const c of def[t])out.add(c);
 return out;
}
// Fields a filing line maps to, or []. `mapped` holds every tag our own maps read; a
// line on one of them is ours already. `noncontrolling` is true when the same
// statement of that filing presents a noncontrolling interest, so that a bare
// "net income" or total is the consolidated figure, not the parent's. `crdr` is
// the tag's declared balance (tag.txt), when it is known.
function fieldsFor(stmt,plabel,tag,{custom=false,mapped=new Set(),noncontrolling=false,crdr,memberTotal=false}={}) {
 const full=label(plabel),text=netLabel(full);if(!STATEMENT[stmt] || !text || EXCLUDE.test(full) || TAG_DENY.test(tag) || (!custom && STD_DENY.has(tag)))return [];
 const out=[];
 for(const [s,field,rule,tagRule] of RULES){
  if(s!==stmt || !rule.test(text) || (tagRule && !tagRule.test(tag)))continue;
  const fields=field.split('+'),perShare=fields.some(f=>/eps|EPS/.test(f));
  if(perShare!==PER_SHARE.test(tag))continue;
  if(!perShare && /per (?:share|unit)/.test(text))continue;
  if(noncontrolling && ['netIncome','totalShareholderEquity'].some(f=>fields.includes(f)) && !/stockholders|shareholders/.test(text))continue;
  if(crdr!==undefined && fields.some(f=>BALANCE[f] && BALANCE[f]!==crdr))continue;
  if(fields.some(f=>TAG_REQUIRE[f] && !TAG_REQUIRE[f].test(tag)))continue;
  out.push(...fields);
 }
 // A standard tag of ours reaches the cell already, except a per-class EPS figure,
 // which the company-facts feed drops with every other dimensional fact, and, for the
 // builder (memberTotal), a total revenue filed only under one product member.
 if(!custom && mapped.has(tag) && !out.every(f=>f==='eps' || f==='dilutedEPS' || memberTotal && f==='totalRevenue'))return [];
 return [...new Set(out)];
}
// The one member of a product breakdown that is the whole (build-statement-lines): [member, value] of the largest
// member, when it and no other is the exact sum of two or more of the other positive members, else null.
function memberTotal(members){
 if(members.length<3 || members.length>16)return null;
 const top=Math.max(...members.map(x=>x[1]));
 const sums=(parts,v)=>{for(let mask=1;mask<1<<parts.length;mask++){let n=0,c=0;for(let i=0;i<parts.length;i++)if(mask&1<<i){n+=parts[i];c++;}if(c>=2 && Math.abs(n-v)<0.5)return true;}return false;};
 const totals=members.filter(([k,v])=>v>0 && sums(members.filter(x=>x[0]!==k && x[1]>0).map(x=>x[1]),v));
 return totals.length===1 && totals[0][1]===top?totals[0]:null;
}
// A fact on a dimension is kept only for a per-share figure filed for one class of stock.
function acceptedDimension(segments,field){if(!segments)return true;return (field==='eps' || field==='dilutedEPS') && /^ClassOfStock=[^;=]+;?$/.test(segments);}
// A balance-sheet line that is borrowing of any kind. Read wide on purpose: a presented line
// this matches but the row does not hold leaves total debt unread (sec-facts presentedDebt),
// while one it missed would understate it. Leases, interest and totals are not debt lines.
function debtLine(tag,plabel){
 const text=(String(tag || '').replace(/([a-z])([A-Z])/g,'$1 $2')+' | '+String(plabel || '').replace(/\((?:note|notes|see note)[^)]*\)/gi,'')).toLowerCase();
 if(/^(liabilities|liabilities current|liabilities noncurrent|liabilities and stockholders equity) \|/.test(text) || /\| total liabilities/.test(text))return false;
 // "net of deferred financing costs" describes a debt line; it is not what the line is.
 if(/operating lease|lease liabilit|interest payable|accrued interest|securities|issuance cost|warrant|derivative|deferred|tax|receivable|other than|equity|guarantee/.test(text.replace(/,? *(?:net of|less|including|excluding)\b[^|]*$/,'')))return false;
 return /debt|borrowing|\bnotes?\b|commercial paper|\bloans?\b|credit facilit|lines? of credit|debentures?|revolv|mortgages?\b|\bbonds?\b|federal home loan|fhlb|convertible/.test(text);
}
// A cash-flow line that is money spent on the company's own long-lived assets: property and equipment,
// software it builds or buys, tooling. Capital spending is often split over several lines, one of them on a
// tag of the company's own (Mattel 2025: $110.6m of property, plant and equipment beside its tools, dies and
// molds, $182.0m in all), so the lines are summed (sec-facts presentedCapex). Proceeds, businesses bought,
// investments and the noncash supplemental lines ("purchases included in accounts payable") are not spending.
function capexLine(tag,plabel){
 const words=String(tag || '').replace(/([a-z])([A-Z])/g,'$1 $2').toLowerCase(),text=label(plabel);
 if(/proceeds|sales? of|sold|disposal|dispositions?|business|acquired|investments? in|securities|accounts payable|accrued|non-?cash|unpaid|not (?:yet )?paid|but not|pending|on account|payment terms|included in|liabilit|financed|financings?|financing activities|finance lease|capital lease|exchange|right of use|repayments?|principal|\bnotes?\b|deposit|affiliate|compensation|stock-based|share-based|depreciation|amorti[sz]ation|impairment|decommission|operating activities|advance|in credit|prior (?:years?|periods?)|transferred|prepaid|incentive|discontinued|held for sale|related part|reimburse|insurance|grants?\b|total/.test(words+' | '+text))return false;
 if(CAPEX_TAGS.has(tag))return true;
 const spent=/^(?:purchases?|acquisitions?|additions?|payments?|expenditures?|investments?|capitali[sz]ed|capitali[sz]ation of|capital expenditures?|cash paid|spending)\b/;
 const asset=/property,? (?:plant|and|&)|plant|equipment|software|fixed assets?|tools|dies|molds|moulds|tooling|productive assets|capital improvements|leasehold improvements|premises|computer/;
 return spent.test(text) && asset.test(text) || /^capital expenditures?$/.test(text);
}
// Standard tags that are capital spending whatever the line is called ("software development costs").
// The "other productive assets" and "other property" tags are not among them: filed under those were
// land purchases, "acquisition of new communities" and "purchases of other assets" (2026q1 annual reports),
// and under the productive-assets tag businesses bought ("cash paid for asset acquisitions").
const CAPEX_TAGS=new Set(['PaymentsToAcquirePropertyPlantAndEquipment','PaymentsForSoftware','PaymentsToAcquireSoftware','PaymentsToDevelopSoftware','PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities']);
const DIR=()=>path.join(p.DATA_DIR,'sec-statement-lines');
function forCik(cik){const id=p.cik(cik);if(!id)return [];try{const doc=JSON.parse(fs.readFileSync(path.join(DIR(),id+'.json'),'utf8'));return doc.cik===id && Array.isArray(doc.lines)?doc.lines:[];}catch(e){if(e.code==='ENOENT')return [];throw e;}}
module.exports={RULES,BALANCE,debtLine,capexLine,fieldsFor,memberTotal,acceptedDimension,label,mappedTags,forCik,DIR,STATEMENT};
