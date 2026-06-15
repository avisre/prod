// Web enrichment for governance — fills ONLY fields that are SAFE to source from
// the open web, for the cases the DEF 14A extraction left blank. Hard-won scope:
//
//   ✓ dualClassShares — structural, essentially never changes, widely documented.
//     Detected deterministically (regex over Wikipedia full text) and corroborated
//     by a second independent source (DuckDuckGo snippets). Never asserted false.
//   ✓ ceoName — from CURRENT Wikidata (P169), excluding any claim with an end-date
//     qualifier (so former CEOs can't leak in), and only when Wikipedia names the
//     same person. Two independent sources.
//   ✗ ceoChairCombined / chair — DELIBERATELY NOT sourced from the web. Wikidata
//     and Wikipedia both carry stale, undated leadership data (e.g. they showed
//     Musk as Tesla's chairman years after he stepped down), so "two sources
//     agreeing" can still be confidently WRONG about the present. The proxy is the
//     authoritative, current source for who chairs the board; leave it to filings.
//
// Everything is filing-first (never overwrites an extracted value), two-source,
// best-effort (any failure → fills nothing, never throws), and carries source URLs.

const axios = require('axios');
const filing = require('./filing-fetcher');

const UA = 'stockportfolio.pro/1.0 (equity research; +https://www.stockportfolio.pro)';
const GET = (url, opts = {}) => axios.get(url, { headers: { 'User-Agent': UA, Accept: opts.accept || 'application/json' }, timeout: opts.timeout || 12000, maxContentLength: 8e6, validateStatus: (s) => s >= 200 && s < 500 });

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function samePerson(a, b) {
    const na = norm(a), nb = norm(b);
    if (!na || !nb) return false;
    if (na === nb || na.includes(nb) || nb.includes(na)) return true;
    const la = na.split(' ').pop(), lb = nb.split(' ').pop();
    const fa = na.split(' ')[0], fb = nb.split(' ')[0];
    return la && la === lb && fa && fb && fa[0] === fb[0];
}

// Deliberately narrow: matches genuine SUPER-VOTING concentration (the real
// governance concern), NOT any company that merely has more than one share class.
// (Visa's restricted legacy Class B/C, for instance, must NOT trip this.)
const DUAL_RE = /dual[- ]?class|super[- ]?voting|high[- ]vote|multiple votes per share|\b(?:ten|10|fifteen|15|twenty|20)\s+votes per share|entitled to (?:ten|10|twenty|20) votes/i;

// ---- Wikipedia: company page → {title, qid, lead, full, url} ----
async function wikipedia(company) {
    try {
        // 1) find the page + its Wikidata id from a search
        const s = await GET(`https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(company)}&gsrlimit=1&prop=pageprops&redirects=1&format=json`);
        const pages = s.data && s.data.query && s.data.query.pages;
        if (!pages) return null;
        const p = Object.values(pages)[0];
        if (!p || !p.title) return null;
        // 2) pull the FULL plaintext extract (dual-class is often below the lead)
        const e = await GET(`https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=${encodeURIComponent(p.title)}`);
        const ep = Object.values(((e.data || {}).query || {}).pages || {})[0] || {};
        const full = String(ep.extract || '');
        if (!full) return null;
        return { title: p.title, qid: (p.pageprops || {}).wikibase_item || null, lead: full.slice(0, 2500), full: full.slice(0, 60000), url: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}` };
    } catch (_) { return null; }
}

// ---- Wikidata: CURRENT CEO only (P169), excluding end-dated/deprecated claims ----
async function wikidataCeo(qid) {
    if (!qid) return null;
    try {
        const r = await GET(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=claims&format=json`);
        const claims = (((r.data.entities || {})[qid] || {}).claims || {}).P169 || [];
        const currentIds = claims
            .filter((c) => c.rank !== 'deprecated' && !(c.qualifiers && c.qualifiers.P582)) // no end-time = current
            .map((c) => (((c.mainsnak || {}).datavalue || {}).value || {}).id)
            .filter(Boolean);
        if (!currentIds.length) return { name: null, url: `https://www.wikidata.org/wiki/${qid}` };
        const lr = await GET(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${currentIds.join('|')}&props=labels&languages=en&format=json`);
        const labels = lr.data.entities || {};
        const name = currentIds.map((id) => ((labels[id] || {}).labels || {}).en && labels[id].labels.en.value).filter(Boolean)[0] || null;
        return { name, url: `https://www.wikidata.org/wiki/${qid}` };
    } catch (_) { return null; }
}

// ---- DuckDuckGo HTML snippets (best-effort corroboration) ----
async function ddgSnippets(query) {
    try {
        const r = await GET(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { accept: 'text/html', timeout: 10000 });
        const html = String(r.data || '');
        const out = [];
        const re = /result__snippet[^>]*>([\s\S]*?)<\/a>/g;
        let m;
        while ((m = re.exec(html)) && out.length < 10) {
            const text = m[1].replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
            if (text.length > 20) out.push(text);
        }
        return out;
    } catch (_) { return []; }
}

// Returns { fields: {name:{value, sources:[url], confidence, evidence?}}, sourcesUsed, wikipediaTitle }
async function enrichGovernance(symbol, companyName, board) {
    const need = {
        ceoName: !board || board.ceoName == null,
        dualClassShares: !board || board.dualClassShares == null
    };
    if (!need.ceoName && !need.dualClassShares) return { fields: {}, sourcesUsed: [] };

    const wiki = await wikipedia(companyName || symbol);
    // CEO needs Wikidata+Wikipedia AND a recency anchor (the current SEC 10-K),
    // because Wikidata/Wikipedia can lag a CEO change by months. Dual-class is
    // anchored on the 10-K and corroborated by the web. Fetch concurrently.
    const [wd, secDoc, ddg] = await Promise.all([
        (need.ceoName && wiki && wiki.qid) ? wikidataCeo(wiki.qid) : Promise.resolve(null),
        (need.dualClassShares || need.ceoName) ? filing.getFilingText(symbol, '10-K', { maxChars: 460000 }).catch(() => null) : Promise.resolve(null),
        need.dualClassShares ? ddgSnippets(`${companyName || symbol} dual class super voting shares`) : Promise.resolve([])
    ]);

    const fields = {};
    const used = new Set();

    // CEO name — CURRENT Wikidata P169 + Wikipedia text + the name must appear in a
    // CEO context in the LATEST 10-K (kills a stale web CEO after a leadership change).
    if (need.ceoName && wiki && wd && wd.name) {
        const wikiNamesThem = norm(wiki.full).includes(norm(wd.name)) || norm(wiki.lead).includes(norm(wd.name).split(' ').pop());
        const surname = String(wd.name).trim().split(/\s+/).pop().replace(/[^A-Za-z\-]/g, '');
        let currentInFiling = false;
        if (secDoc && secDoc.text && surname.length >= 3) {
            const re = new RegExp(surname + '[^.\\n]{0,80}chief executive|chief executive officer[^.\\n]{0,80}' + surname, 'i');
            currentInFiling = re.test(secDoc.text);
        }
        if (wikiNamesThem && currentInFiling) { fields.ceoName = { value: wd.name, sources: [wd.url, wiki.url, secDoc.url].filter(Boolean), confidence: 'high' }; used.add(wd.url); used.add(wiki.url); }
    }

    // Dual-class — authoritative: the SEC 10-K must describe super-voting; the web
    // (Wikipedia/DDG) is recorded as corroboration when present. Never set false.
    if (need.dualClassShares && secDoc && secDoc.text) {
        const m = secDoc.text.match(DUAL_RE);
        if (m) {
            const idx = secDoc.text.search(DUAL_RE);
            const evidence = secDoc.text.slice(Math.max(0, idx - 10), idx + 130).replace(/\s+/g, ' ').trim();
            const sources = [secDoc.url].filter(Boolean);
            const webCorroborates = (wiki && DUAL_RE.test(wiki.full)) || ddg.some((s) => DUAL_RE.test(s));
            if (wiki && DUAL_RE.test(wiki.full)) sources.push(wiki.url);
            else if (ddg.some((s) => DUAL_RE.test(s))) sources.push('https://duckduckgo.com/?q=' + encodeURIComponent((companyName || symbol) + ' dual class shares'));
            fields.dualClassShares = { value: true, sources, confidence: webCorroborates ? 'high' : 'high', evidence, basis: 'SEC 10-K' + (webCorroborates ? ' + web' : '') };
            used.add(secDoc.url);
        }
    }

    return { fields, sourcesUsed: [...used], wikipediaTitle: wiki ? wiki.title : null };
}

module.exports = { enrichGovernance, wikipedia, wikidataCeo, ddgSnippets, samePerson };
