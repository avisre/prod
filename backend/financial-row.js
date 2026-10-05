'use strict';
const number=require('./sec-coverage').number;
function totalDebt(row={}) {
 const total=number(row.shortLongTermDebtTotal);if(total!==null)return total;
 // Verified extraction supplies the validated combination; reconstructing it
 // here could combine filing versions that the extractor rejected.
 if(row._sources)return null;
 const current=number(row.shortTermDebt),noncurrent=number(row.longTermDebt);
 return current!==null && noncurrent!==null?current+noncurrent:null;
}
function liquidCash(row={}) {
 const cash=number(row.cashAndCashEquivalentsAtCarryingValue),investments=number(row.shortTermInvestments);
 return cash!==null && investments!==null?cash+investments:null;
}
function compatible(a,b) {
 return !!a && !!b && a.fiscalDateEnding===b.fiscalDateEnding && a.reportedCurrency===b.reportedCurrency && (!a.periodStart || !b.periodStart || a.periodStart===b.periodStart);
}
module.exports={number,totalDebt,liquidCash,compatible};
