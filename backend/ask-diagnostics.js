'use strict';

// A terminal event contains only coarse execution metadata. Never include the
// submitted text, generated answer, user identity, or tool arguments here.
function outcome(result, { mode, stream, entrypoint } = {}) {
    const quality = result?.quality || {};
    const used = Array.isArray(result?.toolsUsed) ? result.toolsUsed : [];
    return {
        source: result?.source || 'unknown',
        mode: mode === 'analyst' ? 'analyst' : 'normal',
        stream: !!stream,
        entrypoint: entrypoint || 'unknown',
        policy: quality.policy?.kind || 'unresolved',
        terminalReason: quality.terminalReason || (result?.source === 'ai' ? 'answered' : 'unclassified'),
        tools: used.length,
        failedTools: [...new Set(used.filter(tool => tool && tool.ok === false).map(tool => tool.tool))],
        correctionAttempted: !!quality.correctionAttempted,
        correctionSucceeded: quality.correctionAttempted ? !!quality.correctionSucceeded : null
    };
}

module.exports = { outcome };
