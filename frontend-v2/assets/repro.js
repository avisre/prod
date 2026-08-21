const { chromium, devices } = require('/home/hardoker77/.npm-global/lib/node_modules/playwright');
(async () => {
  const b = await chromium.launch();
  for (const [mode, ctxOpts] of [['DESKTOP',{viewport:{width:1280,height:900}}],['MOBILE',{...devices['iPhone 13']}]]) {
    const c = await b.newContext(ctxOpts);
    const p = await c.newPage();
    const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,160))}); p.on('pageerror',e=>errs.push('JS:'+String(e).slice(0,160)));
    await p.goto('https://www.stockportfolio.pro/company?symbol=AAPL',{waitUntil:'networkidle',timeout:40000});
    await p.waitForTimeout(3500);
    // find statement table state
    const before = await p.evaluate(() => {
      const t=document.getElementById('stmt-table');
      const carets=t?t.querySelectorAll('.grp-caret').length:0;
      const visRows=t?[...t.querySelectorAll('tbody tr')].filter(r=>!r.hidden).length:0;
      return { carets, visRows, hasTable: !!t };
    });
    // click the first caret
    let clicked=false, after=null;
    try {
      const caret = await p.$('#stmt-table .grp-caret');
      if (caret) { await caret.scrollIntoViewIfNeeded(); await caret.click({timeout:3000}); clicked=true; await p.waitForTimeout(500);
        after = await p.evaluate(() => { const t=document.getElementById('stmt-table'); return [...t.querySelectorAll('tbody tr')].filter(r=>!r.hidden).length; });
      }
    } catch(e){ errs.push('CLICK:'+e.message.slice(0,80)); }
    console.log(`[${mode}] table=${before.hasTable} carets=${before.carets} visRowsBefore=${before.visRows} clicked=${clicked} visRowsAfter=${after} expanded=${after>before.visRows} errors=${JSON.stringify(errs.slice(0,3))}`);
    await c.close();
  }
  await b.close();
})();
