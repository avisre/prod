'use strict';
// A filing's statements read from its own XBRL files on EDGAR, as the rows of SEC's Financial Statement and Notes
// data sets (sub, pre, num, dim, tag). SEC publishes a month's set only after the month ends, so a 10-Q filed this
// week has no statement lines until then; scripts/build-edgar-statement-sets.js writes these rows for those filings.

// The kind of statement a presentation role's title names ("9952154 - Statement - Condensed Consolidated Balance
// Sheets"): BS, IS, CI, CF, EQ, or '' for a role that is not a statement.
function titleKind(definition) {
 const m=/^\s*\S+\s+-\s+(\w+)\s+-\s+(.*)$/.exec(String(definition || ''));
 if(!m || !/^statements?$/i.test(m[1]))return null;
 const title=m[2],inpth=/parenthetical/i.test(title)?'1':'0';
 let kind='UN';
 if(/cash\s*flows?/i.test(title))kind='CF';
 else if(/(?:stockholders|shareholders|shareowners|members|partners|owners)['’`]?\s*(?:\(deficit\)\s*)?(?:equity|deficit|capital|investment)|changes in (?:\w+\s+){0,3}(?:equity|net assets|capital|deficit)|statements? of (?:changes in )?equity|redeemable/i.test(title))kind='EQ';
 else if(/balance sheets?|financial (?:position|condition)|statements? of condition|assets,? (?:and )?liabilities|net assets/i.test(title))kind='BS';
 else if(/comprehensive/i.test(title) && !/\band\b.*comprehensive|operations/i.test(title))kind='CI';
 else if(/operations|income|earnings|loss|revenues? and expenses/i.test(title))kind='IS';
 return {kind,inpth};
}
// SEC classifies one statement of each kind in a filing, the first: a co-registrant's own statements after it are
// unclassified (AEP's 10-Q: its subsidiaries' balance sheets are UN), and a statement of comprehensive income is the
// income statement where no other is presented. roles: definitions in the filing's order; returns [{stmt,inpth}].
function assignStatements(definitions) {
 const kinds=definitions.map(titleKind),taken=new Set(),hasIS=new Set(kinds.filter(k=>k?.kind==='IS').map(k=>k.inpth));
 return kinds.map(k=>{
  if(!k)return {stmt:'',inpth:'0'};
  let kind=k.kind;if(kind==='CI' && !hasIS.has(k.inpth))kind='IS';
  if(kind==='UN')return {stmt:'UN',inpth:k.inpth};
  const key=kind+'|'+k.inpth;if(taken.has(key))return {stmt:'UN',inpth:k.inpth};
  taken.add(key);return {stmt:kind,inpth:k.inpth};
 });
}
module.exports={titleKind,assignStatements};
