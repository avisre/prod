'use strict';

// The Microsoft 365 Copilot app package is generated from the server's own tool
// list. This fails when a tool changed and the package was not rebuilt, and
// when a description would break the store's rules.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const mcpApps = require('../mcp-apps');

const ROOT = path.join(__dirname, '..', '..');
const PKG = path.join(ROOT, 'integrations', 'microsoft-365-copilot', 'appPackage');
const read = (name) => JSON.parse(fs.readFileSync(path.join(PKG, name), 'utf8'));

test('the committed package matches what the generator produces today', () => {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-copilot-package.js'), '--check'], { encoding: 'utf8' });
    assert.match(out, /current/);
});

test('the package describes exactly the tools the endpoint serves, with no URL in any description', () => {
    const plugin = read('ai-plugin.json');
    const runtime = plugin.runtimes[0];
    const served = mcpApps.TOOL_DEFS.map((t) => t.name);
    assert.equal(runtime.type, 'RemoteMCPServer');
    assert.equal(runtime.spec.url, 'https://www.stockportfolio.pro/mcp/apps');
    assert.deepEqual(runtime.spec.mcp_tool_description.tools.map((t) => t.name), served);
    assert.deepEqual(plugin.functions.map((f) => f.name), served);
    assert.deepEqual(runtime.run_for_functions, served);
    assert.equal(runtime.auth.type, 'OAuthPluginVault');
    const agent = read('declarativeAgent.json');
    const manifest = read('manifest.json');
    const texts = [
        plugin.description_for_human, plugin.description_for_model, agent.description, agent.instructions,
        manifest.description.short, manifest.description.full,
        ...plugin.functions.map((f) => f.description),
        ...runtime.spec.mcp_tool_description.tools.map((t) => `${t.description} ${JSON.stringify(t.inputSchema)}`)
    ];
    for (const text of texts) assert.doesNotMatch(text, /https?:\/\/|www\.|\$\d/, text.slice(0, 80));
    assert.ok(manifest.name.short.length <= 30 && manifest.description.short.length <= 80);
    for (const icon of ['color.png', 'outline.png']) assert.ok(fs.existsSync(path.join(PKG, icon)), icon);
});
