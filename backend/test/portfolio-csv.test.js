const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHoldingsCsv, consolidateRows } = require('../portfolio-csv');

test('fidelity-style messy CSV: preamble, quotes, $ prices, mixed dates', () => {
  const csv = [
    'Fidelity Brokerage Services LLC — this statement is for informational purposes only.',
    'Past performance is not a guarantee of future results. Please consult your tax advisor.',
    'Position detail as of 04/01/2024',
    '"Symbol","Quantity","Price Per Share","Date Acquired"',
    '"AAPL","10","$1,234.50","2024-03-15"',
    '"MSFT","5","$250","03/15/2024"',
    '"Vanguard Total Stock Market Index Fund","30","1,234.50","March 14, 2024"',
    '"BRK.B","2","$310.25","3/14/24"',
    '"GOOG","1","",""',
    ''
  ].join('\n');
  const res = parseHoldingsCsv(csv);
  assert.equal(res.error, undefined);
  // A fund name in the ticker column can never resolve to a price, so it is
  // reported as a skip rather than saved as a holding stuck at $0 forever.
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].reason, /not a valid ticker/);
  assert.deepEqual(res.rows, [
    { symbol: 'AAPL', shares: 10, price: 1234.5, purchaseDate: '2024-03-15' },
    { symbol: 'MSFT', shares: 5, price: 250, purchaseDate: '2024-03-15' },
    { symbol: 'BRK.B', shares: 2, price: 310.25, purchaseDate: '2024-03-14' },
    { symbol: 'GOOG', shares: 1, price: 0, purchaseDate: null }
  ]);
});

test('header alias variants all resolve (ticker/quantity/pricepershare/tradedate)', () => {
  const variants = [
    ['Ticker', 'Quantity', 'PricePerShare', 'TradeDate'],
    ['Security', 'Units', 'AvgPrice', 'DateAcquired'],
    ['Stock', 'Qty', 'Unit Price', 'Transaction Date']
  ];
  for (const headers of variants) {
    const res = parseHoldingsCsv(`${headers.join(',')}\nTSLA,3,101,2024-01-05`);
    assert.equal(res.error, undefined, `variant ${headers.join('/')} should parse`);
    assert.equal(res.rows.length, 1);
    assert.deepEqual(res.rows[0], { symbol: 'TSLA', shares: 3, price: 101, purchaseDate: '2024-01-05' });
  }
});

test('junk rows are skipped with reasons, never silently dropped', () => {
  const csv = [
    'Symbol,Shares,Price,Date',
    ',10,100,2024-03-15',          // missing ticker
    'AAPL,,100,2024-03-15',        // missing quantity
    'MSFT,abc,100,2024-03-15',     // bad quantity
    'TSLA,0,100,2024-03-15',       // zero quantity
    'NVDA,-5,100,2024-03-15',      // negative quantity
    'AMD,1,100,not a date',        // bad date
    'GOOG,2,100,2024-03-15'
  ].join('\n');
  const res = parseHoldingsCsv(csv);
  assert.equal(res.error, undefined);
  assert.deepEqual(res.rows, [{ symbol: 'GOOG', shares: 2, price: 100, purchaseDate: '2024-03-15' }]);
  assert.deepEqual(res.skipped, [
    { line: 2, reason: 'missing ticker' },
    { line: 3, reason: 'missing quantity' },
    { line: 4, reason: 'bad quantity' },
    { line: 5, reason: 'bad quantity' },
    { line: 6, reason: 'bad quantity' },
    { line: 7, reason: 'bad date' }
  ]);
});

test('symbol is trimmed and uppercased', () => {
  const res = parseHoldingsCsv('Symbol,Shares\n  aapl ,4');
  assert.deepEqual(res.rows, [{ symbol: 'AAPL', shares: 4, price: 0, purchaseDate: null }]);
});

test('missing header row returns a helpful error', () => {
  const res = parseHoldingsCsv('Fidelity statement\nnothing useful here');
  assert.match(res.error, /Could not find a header row/);
  assert.match(res.error, /symbol\/ticker/);
  assert.match(res.error, /shares\/quantity/);
});

test('skip reasons are capped at 20 with an "and N more" tail', () => {
  const junk = [];
  for (let i = 0; i < 27; i++) junk.push(`,1,1,2024-03-15`); // all missing ticker
  const res = parseHoldingsCsv(`Symbol,Shares,Price,Date\n${junk.join('\n')}`);
  assert.equal(res.rows.length, 0);
  assert.equal(res.skipped.length, 21); // 20 reasons + the summary line
  assert.deepEqual(res.skipped[19], { line: 21, reason: 'missing ticker' });
  assert.deepEqual(res.skipped[20], { line: null, reason: '…and 7 more' });
});

test('CSVs with more than 2000 data rows are refused', () => {
  const junk = [];
  for (let i = 0; i < 2001; i++) junk.push(`S${i},1,1,2024-03-15`);
  const res = parseHoldingsCsv(`Symbol,Shares,Price,Date\n${junk.join('\n')}`);
  assert.match(res.error, /more than 2000/);
  // exactly 2000 is fine
  junk.pop();
  const ok = parseHoldingsCsv(`Symbol,Shares,Price,Date\n${junk.join('\n')}`);
  assert.equal(ok.error, undefined);
  assert.equal(ok.rows.length, 2000);
});

test('consolidateRows: weighted average, earliest date, sorted output', () => {
  const merged = consolidateRows([
    { symbol: 'MSFT', shares: 5, price: 300, purchaseDate: '2024-02-01' },
    { symbol: 'AAPL', shares: 30, price: 200, purchaseDate: '2024-03-10' },
    { symbol: 'AAPL', shares: 10, price: 100, purchaseDate: '2023-06-01' }
  ]);
  assert.deepEqual(merged, [
    { symbol: 'AAPL', shares: 40, price: 175, purchaseDate: '2023-06-01' },
    { symbol: 'MSFT', shares: 5, price: 300, purchaseDate: '2024-02-01' }
  ]);
});

test('consolidateRows: price-0 rows carry no price information', () => {
  const merged = consolidateRows([
    { symbol: 'AAPL', shares: 10, price: 0, purchaseDate: null },
    { symbol: 'AAPL', shares: 10, price: 200, purchaseDate: '2024-01-01' }
  ]);
  assert.deepEqual(merged, [{ symbol: 'AAPL', shares: 20, price: 200, purchaseDate: '2024-01-01' }]);
});

test('consolidateRows: all-zero prices stay zero, all-null dates stay null', () => {
  const merged = consolidateRows([
    { symbol: 'B', shares: 1, price: 0, purchaseDate: null },
    { symbol: 'A', shares: 3, price: 0, purchaseDate: null }
  ]);
  assert.deepEqual(merged, [
    { symbol: 'A', shares: 3, price: 0, purchaseDate: null },
    { symbol: 'B', shares: 1, price: 0, purchaseDate: null }
  ]);
});

test('consolidateRows: earliest date wins even when the latest row is first', () => {
  const merged = consolidateRows([
    { symbol: 'X', shares: 1, price: 5, purchaseDate: '2024-05-05' },
    { symbol: 'X', shares: 1, price: 5, purchaseDate: '2021-01-01' },
    { symbol: 'X', shares: 1, price: 5, purchaseDate: null }
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].purchaseDate, '2021-01-01');
  assert.equal(merged[0].shares, 3);
});
test('rows whose ticker cannot be a ticker are skipped, not imported', () => {
    const csv = [
        'Symbol,Shares,Price',
        'AAPL,10,150',
        'BADTICKER!!,5,10',
        'Total,999,0',
        'BRK.B,2,410',
        '^GSPC,1,5000'
    ].join('\n');
    const out = parseHoldingsCsv(csv);
    // 'Total' is shaped like a ticker, so it survives parsing — the preview
    // step is where a human catches a summary row, not a regex guess.
    assert.deepEqual(out.rows.map((r) => r.symbol), ['AAPL', 'TOTAL', 'BRK.B', '^GSPC']);
    assert.equal(out.skipped.length, 1);
    assert.match(out.skipped[0].reason, /not a valid ticker/);
});
