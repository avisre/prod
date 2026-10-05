#!/usr/bin/env node
'use strict';
// Run in an isolated checkout so mutation-oriented existing suites cannot alter
// release data or comparison discoveries in the developer's worktree.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const root=path.join(__dirname,'..');
const names=['company-reporting','listing-resolver','financial-cache-promotion','financial-consumer-values','public-financial-cache-integration','financial-provenance','company-evidence','sec-original','financial-foundation','stock-universe','quote-store','quote-store-sec-shares','sec-coverage','sec-facts','sec-extraction-matrix','sec-revenue-definitions','sec-reporting','sec-financial-consumers','sec-runtime','sec-release-regressions','seo-control-plane','seo-research','seo-activation-pilot','sitemap-index','sitemap-lastmod','fundamentals-status','fundamentals-status-integration','fundamentals-date','fundamentals-staleness','fx-conversion','screener-export','mcp-endpoint','mcp-apps','mcp-anon','hard-paywall','company-statements','profile-consolidation','ask-recovery','ask-evidence','ask-answer-quality','ask-segments','ask-inline-segments','ask-segments-integration','ask-tool-loop','ai-chat-usage','ask-page','ask-history','ask-threads','anon-ask-trial','ai-client-stream','ai-client-config','free-tools','ssr-cache','mail-receipts','mail-transport'];
names.push('ask-report-policy','ask-report-evidence','ask-visualization','ask-supplemental-context','ask-long-storage','ask-business-context','ask-story-evidence','search-filings-accuracy');
const all=process.argv.includes('--all');
const temp=fs.mkdtempSync(path.join(process.platform==='darwin'?path.dirname(root):os.tmpdir(),'.sec-regression-'));
function copy(dir,dest){fs.mkdirSync(dest,{recursive:true});for(const ent of fs.readdirSync(dir,{withFileTypes:true})){if(['node_modules','.git','.env','prod.env','mockups','seo-data'].includes(ent.name))continue;const from=path.join(dir,ent.name),to=path.join(dest,ent.name);if(ent.isDirectory() && process.platform==='darwin' && from===path.join(root,'frontend','data')){const cloned=spawnSync('cp',['-cR',from,to],{stdio:'inherit'});if(cloned.status!==0)throw new Error('Unable to clone financial test data');}else if(ent.isDirectory())copy(from,to);else if(ent.isFile())fs.copyFileSync(from,to,fs.constants.COPYFILE_FICLONE);}}
try{
 for(const name of ['backend','scripts','frontend-v2','frontend','lib','jobs'])copy(path.join(root,name),path.join(temp,name));
 for(const name of ['seo-data','docs'])fs.symlinkSync(path.join(root,name),path.join(temp,name),'dir');
 for(const name of ['node_modules','backend/node_modules'])fs.symlinkSync(path.join(root,name),path.join(temp,name),'dir');
 copy(path.join(root,'.github'),path.join(temp,'.github'));
 fs.mkdirSync(path.join(temp,'.claude'));fs.copyFileSync(path.join(root,'.claude/HANDOFF.md'),path.join(temp,'.claude/HANDOFF.md'));copy(path.join(root,'.claude/handoff-archive'),path.join(temp,'.claude/handoff-archive'));
 for(const name of ['package.json','package-lock.json','CLAUDE.md'])fs.copyFileSync(path.join(root,name),path.join(temp,name));
 const files=(all?fs.readdirSync(path.join(temp,'backend/test')).filter(name=>name.endsWith('.test.js')).map(name=>name.slice(0,-8)):names).map(name=>`backend/test/${name}.test.js`).filter(name=>fs.existsSync(path.join(temp,name)));
 const result=spawnSync(process.execPath,['--require',path.join(temp,'scripts/local-qa/no-model-network.cjs'),'--test','--test-concurrency=4',...files],{cwd:temp,stdio:'inherit',env:{...process.env,SEC_COVERAGE_READ_ONLY:'1',SEC_COVERAGE_DISABLE_ON_DEMAND:'1',DISABLE_BACKGROUND_JOBS:'1'}});
 process.exitCode=result.status || (result.error?1:0);
}finally{fs.rmSync(temp,{recursive:true,force:true});}
