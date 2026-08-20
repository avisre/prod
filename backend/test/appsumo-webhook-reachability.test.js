const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('AppSumo webhook has a side-effect-free reachability response before the signed POST handler', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const getRoute = "app.get('/appsumo/webhook', (_req, res) => {\n    return res.status(200).json({ success: true, status: 'ready' });\n});";
    const postRoute = "app.post('/appsumo/webhook', express.raw({ type: '*/*' })";

    assert.ok(source.includes(getRoute));
    assert.ok(source.indexOf(getRoute) < source.indexOf(postRoute));
});
