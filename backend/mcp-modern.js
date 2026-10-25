'use strict';

// MCP 2026-07-28 ("modern") requests, served on the same stateless POST
// routes as the SDK path. Why this file exists: a client that speaks only
// 2026-07-28 sends no `initialize` at all, so the SDK's transport answers it
// with a 400 `-32000 "Unsupported protocol version"` and the server is
// unusable from that client — which is every client an AI platform ships
// next. The modern handshake is header-based instead
// (https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning):
// every request carries the protocol version in `params._meta` and in the
// `MCP-Protocol-Version` header, `Mcp-Method` mirrors the method, and
// `tools/call` also carries `Mcp-Name`.
//
// What this implementation answers, and the errors it returns
// (.../2026-07-28/basic/transports/streamable-http):
//   - a missing required header, or a header that contradicts the body →
//     HTTP 400, JSON-RPC error -32020 (HeaderMismatch)
//   - an unsupported protocol version → HTTP 400, -32022 with the supported
//     list, so a dual-era client can renegotiate rather than guess
//   - an unknown method → HTTP 404, -32601
//   - a notification (no `id`) → 202 with an empty body
//   - every result carries `resultType: "complete"`; `server/discover` also
//     carries supportedVersions/capabilities/instructions and `tools/list`
//     ttlMs/cacheScope.
//
// The transport stays stateless: `Mcp-Session-Id` is ignored and never minted.
// The tool layer is not duplicated — app.js passes the same
// listTools/callTool functions the SDK path uses, so both eras serve byte-for
// byte the same tools.

const { SUPPORTED_PROTOCOL_VERSIONS } = require('@modelcontextprotocol/sdk/types.js');

const MODERN_VERSIONS = ['2026-07-28'];
// The versions the SDK path still speaks; advertised together so a client
// can pick, and returned in every "unsupported version" error.
const LEGACY_VERSIONS = SUPPORTED_PROTOCOL_VERSIONS.slice();

const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const SERVER_INFO_META = 'io.modelcontextprotocol/serverInfo';

// `Mcp-Name` may arrive RFC-2047-style as =?base64?<b64 of UTF-8>?=, which
// must be decoded before it is compared with params.name.
function decodeMcpName(raw) {
    const text = String(raw == null ? '' : raw).trim();
    const encoded = /^=\?base64\?([A-Za-z0-9+/=]+)\?=$/.exec(text);
    if (!encoded) return text;
    try { return Buffer.from(encoded[1], 'base64').toString('utf8'); } catch (_) { return text; }
}

function metaVersion(body) {
    const meta = body && body.params && body.params._meta;
    return meta && typeof meta === 'object' ? meta[PROTOCOL_VERSION_META] : null;
}

// Is this request one the modern path must answer? False for anything the
// SDK path handles: the `initialize` handshake, a non-object body, and a
// client that sends a legacy version header or none at all. An unknown
// version header DOES route here, so its sender gets the actionable -32022
// rather than the SDK's dead-end -32000.
function isModern(req) {
    const body = req && req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    if (body.method === 'initialize') return false;
    if (metaVersion(body)) return true;
    const header = req.get ? req.get('mcp-protocol-version') : null;
    return Boolean(header) && !LEGACY_VERSIONS.includes(String(header));
}

// Answers one modern request. `surface` is { name, version, instructions,
// listTools(ctx, deps), callTool(ctx, deps, params) } — the same tool layer
// the SDK path serves.
async function handleModern(req, res, surface, ctx, deps) {
    const body = req.body;

    // A notification has no id to answer, so it is acknowledged and dropped.
    if (body.id === undefined || body.id === null) {
        res.status(202).end();
        return;
    }

    const jsonError = (status, error) => {
        res.status(status).type('application/json')
            .send(JSON.stringify({ jsonrpc: '2.0', id: body.id, error }));
    };

    // The headers ARE the handshake: each must be present, and must agree
    // with the body when the body carries the same fact.
    const headerVersion = req.get('mcp-protocol-version');
    if (!headerVersion) {
        return jsonError(400, { code: -32020, message: 'Header mismatch: the MCP-Protocol-Version header is required.' });
    }
    const version = metaVersion(body) || headerVersion;
    if (!MODERN_VERSIONS.includes(String(version))) {
        return jsonError(400, {
            code: -32022,
            message: 'Unsupported protocol version',
            data: { supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], requested: String(version) }
        });
    }
    if (metaVersion(body) && String(metaVersion(body)) !== String(headerVersion)) {
        return jsonError(400, { code: -32020, message: 'Header mismatch: the MCP-Protocol-Version header does not match params._meta.' });
    }

    const headerMethod = req.get('mcp-method');
    if (!headerMethod) {
        return jsonError(400, { code: -32020, message: 'Header mismatch: the Mcp-Method header is required.' });
    }
    if (String(headerMethod) !== String(body.method || '')) {
        return jsonError(400, { code: -32020, message: 'Header mismatch: the Mcp-Method header does not match the request method.' });
    }
    if (body.method === 'tools/call') {
        const headerName = req.get('mcp-name');
        if (!headerName) {
            return jsonError(400, { code: -32020, message: 'Header mismatch: the Mcp-Name header is required for tools/call.' });
        }
        if (decodeMcpName(headerName) !== String((body.params && body.params.name) || '')) {
            return jsonError(400, { code: -32020, message: 'Header mismatch: the Mcp-Name header does not match params.name.' });
        }
    }

    // Every result names the server and carries resultType "complete"; a
    // tool result that already carries _meta (the Phase-3 sign-in challenge)
    // keeps it — serverInfo merges in beside it.
    const serverInfo = { name: surface.name, version: surface.version };
    const complete = (result) => ({
        ...result,
        resultType: 'complete',
        _meta: { ...(result._meta || {}), [SERVER_INFO_META]: serverInfo }
    });

    let result;
    switch (String(body.method)) {
        case 'server/discover':
            // No initialize: discovery itself tells the client what this
            // server is and which versions it speaks.
            result = complete({
                supportedVersions: [...MODERN_VERSIONS, ...LEGACY_VERSIONS],
                capabilities: { tools: {} },
                instructions: surface.instructions,
                ttlMs: 3600000,
                cacheScope: 'public'
            });
            break;
        case 'tools/list': {
            const listed = await surface.listTools(ctx, deps);
            result = complete({ tools: listed.tools, ttlMs: 300000, cacheScope: 'public' });
            break;
        }
        case 'tools/call': {
            const called = await surface.callTool(ctx, deps, body.params || {});
            result = complete(called);
            break;
        }
        case 'ping':
            result = complete({});
            break;
        default:
            return jsonError(404, { code: -32601, message: 'Method not found' });
    }
    res.status(200).type('application/json')
        .send(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
}

module.exports = { MODERN_VERSIONS, LEGACY_VERSIONS, isModern, handleModern, decodeMcpName };