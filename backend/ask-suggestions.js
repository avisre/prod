'use strict';
// Ask starter questions picked from what this user has asked before. The same
// nine starters were shown to everyone: a Polish reader running due-diligence
// checklists, a reader asking about RSI and golden crosses, and three readers who
// only ever asked the onboarding TSLA question all saw NVDA margins and V vs MA.
// Built in code from the user's own questions, holdings and watchlist; no model call.

const coverage = require('./ask-coverage');

const PL_RE = /[ąćęłńóśźż]|\b(?:czy|jest|jakie|jaki|który|która|spółk\w*|kontynuuj|dlaczego|oraz|porównaj|pokaż|znajdź)\b/i;

// What a question is about. Ticker-bound angles first, then the ones that are not.
const TOPICS = {
    filings: /\b10-?[KQ]\b|\b8-?K\b|filing|annual report|quarterly report|raport\w*|sprawozdani\w*/i,
    growth: /growth|grow|revenue|sales|margin|earnings|wzrost\w*|przych\w*|marż\w*|zysk\w*/i,
    cashflow: /free cash|\bfcf\b|cash flow|capex|capital (?:spending|expenditure)|przepływ\w*/i,
    balance: /balance sheet|debt|leverage|liquidity|net cash|bilans\w*|zadłuż\w*|płynnoś\w*/i,
    valuation: /valuation|valued|\bp\/?e\b|cheap|expensive|undervalued|overvalued|\bdcf\b|fair value|wycen\w*/i,
    risks: /risk|ryzyk\w*|zagroż\w*/i,
    insiders: /insider|\bceo\b|management|board|executive|ownership|institution|zarząd\w*|instytucj\w*|akcjonariusz\w*/i,
    dividends: /dividend|payout|dywidend\w*/i,
    technicals: /\brsi\b|moving average|\bsma\b|golden cross|death cross|breakout|uptrend|downtrend|volume|technical|swing|momentum|52-week|średni\w* krocz\w*|wolumen\w*|trend\w*|techniczn\w*/i,
    compare: /\bvs\.?\s|versus|compare|comparison|porówn\w*/i,
    screen: /\b(?:find|screen|list)\b[\s\S]*\b(?:stocks|companies)\b|which (?:stocks|companies)|znajdź|wyszukaj|spółki,? które/i,
    funds: /\betfs?\b|mutual fund|index fund|fundusz\w*/i,
    portfolio: /my portfolio|my holdings?|portfel\w*/i
};
const ANGLES = ['filings', 'growth', 'cashflow', 'balance', 'valuation', 'risks', 'insiders', 'dividends', 'technicals'];

// What each topic means, for the follow-up hint given to the model.
const TOPIC_LABELS = { filings: 'what changed in the latest filings', growth: 'revenue, margin and earnings trends', cashflow: 'free cash flow',
    balance: 'balance-sheet strength', valuation: 'valuation', risks: 'risk factors', insiders: 'management, insiders and ownership',
    dividends: 'dividend sustainability', technicals: 'price trend (RSI, moving averages, volume)', compare: 'head-to-head comparisons',
    screen: 'screening for companies', funds: 'ETFs and funds', portfolio: 'their own portfolio' };

const TEXT = {
    en: {
        filings: (t) => `What changed in ${t}'s latest 10-Q compared with the one before?`,
        growth: (t) => `Walk me through ${t}'s revenue and margin trend over the last 5 years.`,
        cashflow: (t) => `Does ${t}'s free cash flow keep up with its capital spending and stock-based pay?`,
        balance: (t) => `How strong is ${t}'s balance sheet: net cash, debt and liquidity?`,
        valuation: (t) => `Is ${t} expensive against its own history and its peers?`,
        risks: (t) => `What does ${t}'s latest 10-K flag as risk factors, and what is new this year?`,
        insiders: (t) => `Have ${t}'s insiders been buying or selling over the last year, and who owns the most shares?`,
        dividends: (t) => `Is ${t}'s dividend covered by free cash flow?`,
        technicals: (t) => `Is ${t} above its 50- and 200-day averages, and what is its RSI?`,
        since: (t, d) => `What has ${t} filed since ${d}, and what changed?`,
        compare: (a, b) => `Compare ${a} with ${b}: growth, margins, balance sheet and valuation.`,
        techScreen: () => 'Find stocks with RSI above 50 and a golden cross in the last 30 days.',
        screen: () => 'Find companies that grew revenue 10%+ a year with net margins above 20%.',
        funds: () => 'What are the top 3 ETFs and mutual funds over 1 year and 3 years?',
        portfolio: () => 'Is my portfolio concentrated, and which holding is fundamentally weakest?',
        locale: 'en-GB'
    },
    pl: {
        filings: (t) => `Co się zmieniło w najnowszym raporcie 10-Q ${t} w porównaniu z poprzednim?`,
        growth: (t) => `Pokaż trend przychodów i marż ${t} w ostatnich 5 latach.`,
        cashflow: (t) => `Czy wolne przepływy pieniężne ${t} pokrywają nakłady inwestycyjne i wynagrodzenia w akcjach?`,
        balance: (t) => `Jak mocny jest bilans ${t}: gotówka netto, zadłużenie i płynność?`,
        valuation: (t) => `Czy ${t} jest drogi na tle własnej historii i konkurentów?`,
        risks: (t) => `Jakie czynniki ryzyka wskazuje najnowszy raport 10-K ${t} i co jest nowego w tym roku?`,
        insiders: (t) => `Czy insiderzy ${t} kupowali czy sprzedawali akcje w ostatnim roku i kto ma najwięcej akcji?`,
        dividends: (t) => `Czy dywidenda ${t} jest pokryta wolnymi przepływami pieniężnymi?`,
        technicals: (t) => `Czy kurs ${t} jest powyżej średnich 50- i 200-dniowych i jaki ma RSI?`,
        since: (t, d) => `Jakie nowe raporty ${t} pojawiły się od ${d} i co się w nich zmieniło?`,
        compare: (a, b) => `Porównaj ${a} z ${b}: wzrost, marże, bilans i wycena.`,
        techScreen: () => 'Znajdź spółki z RSI powyżej 50 i złotym krzyżem w ostatnich 30 dniach.',
        screen: () => 'Znajdź spółki, których przychody rosły o 10%+ rocznie przy marży netto powyżej 20%.',
        funds: () => 'Jakie są 3 najlepsze ETF-y i fundusze w horyzoncie 1 roku i 3 lat?',
        portfolio: () => 'Czy mój portfel jest skoncentrowany i która pozycja jest fundamentalnie najsłabsza?',
        locale: 'pl-PL'
    }
};
// topics answered by a question over many companies rather than one
const SCREENS = { technicals: 'techScreen', screen: 'screen', funds: 'funds', portfolio: 'portfolio' };
const MAX = 6;
const SINCE_DAYS = 7;
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// questions: [{ q, at }] newest first. Newer questions weigh more.
function profile(questions, { lookup } = {}) {
    const topics = new Map(), tickers = new Map(), asked = new Set(), lastAt = new Map();
    let polish = 0;
    questions.forEach(({ q, at }, i) => {
        const w = 1 / (1 + i / 5);
        if (PL_RE.test(q)) polish++;
        const named = coverage.namedTickers(q, lookup);
        const about = Object.keys(TOPICS).filter((k) => TOPICS[k].test(q));
        for (const k of about) topics.set(k, (topics.get(k) || 0) + w);
        for (const t of named) {
            tickers.set(t, (tickers.get(t) || 0) + w);
            if (at && !lastAt.has(t)) lastAt.set(t, new Date(at));
            for (const k of about) asked.add(`${t}|${k}`);
        }
    });
    const rank = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    return { topics: rank(topics), tickers: rank(tickers), asked, lastAt,
        language: questions.length && polish * 2 >= questions.length ? 'pl' : 'en' };
}

// holdings / watchlist: ticker lists. peerOf(symbol) → the closest peer's ticker or null.
function suggest({ questions = [], holdings = [], watchlist = [], peerOf = () => null, now = new Date(), lookup } = {}) {
    const p = profile(questions, { lookup });
    const own = [...new Set([...holdings, ...watchlist].map((s) => String(s || '').toUpperCase()).filter(Boolean))];
    const tickers = [...p.tickers, ...own.filter((s) => !p.tickers.includes(s))].slice(0, 3);
    if (!tickers.length && !p.topics.length) return { personalized: false, language: p.language, tickers: [], questions: [] };
    const T = TEXT[p.language];
    const already = new Set(questions.map((x) => norm(x.q)));
    const out = [], seen = new Set();
    const push = (q, why) => {
        if (out.length >= MAX || already.has(norm(q)) || seen.has(q)) return;
        seen.add(q);
        out.push({ q, why });
    };

    // A ticker they asked about a week or more ago: what is new since then.
    const used = new Set();
    // the ticker they research most among those last asked about a week or more ago
    const stale = p.tickers.find((t) => p.lastAt.has(t) && now - p.lastAt.get(t) >= SINCE_DAYS * 864e5);
    if (stale) {
        push(T.since(stale, p.lastAt.get(stale).toLocaleDateString(T.locale, { day: 'numeric', month: 'short' })), `since:${stale}`);
        used.add(`${stale}|filings`);
    }
    // Their own topics first, on each of their tickers, then angles they have not
    // tried there; within a round each ticker gets a different angle where it can.
    const angles = [...p.topics.filter((k) => ANGLES.includes(k)), ...ANGLES.filter((k) => !p.topics.includes(k))];
    const peer = tickers.length ? peerOf(tickers[0]) : null;
    for (let round = 0; round < 2; round++) {
        const inRound = new Set();
        for (const t of tickers) {
            const open = angles.filter((k) => !p.asked.has(`${t}|${k}`) && !used.has(`${t}|${k}`));
            const a = open.find((k) => !inRound.has(k)) || open[0];
            if (!a) continue;
            used.add(`${t}|${a}`);
            inRound.add(a);
            push(T[a](t), `${a}:${t}`);
        }
        if (round === 0 && tickers.length) {
            const other = peer || tickers[1];
            if (other && other !== tickers[0]) push(T.compare(tickers[0], other), `compare:${tickers[0]}`);
            // their main topic, on the closest peer of the company they research most
            const top = p.topics.find((k) => ANGLES.includes(k));
            if (peer && top && !tickers.includes(peer)) push(T[top](peer), `${top}:${peer}`);
            // the screen behind their main topic before a second round of angles
            const lead = p.topics.find((k) => SCREENS[k] && (k !== 'portfolio' || holdings.length));
            if (lead) push(T[SCREENS[lead]](), SCREENS[lead]);
        }
    }
    for (const k of p.topics) if (SCREENS[k] && (k !== 'portfolio' || holdings.length)) push(T[SCREENS[k]](), SCREENS[k]);
    for (const k of ['screen', 'techScreen', 'funds']) push(T[k](), k);
    if (holdings.length) push(T.portfolio(), 'portfolio');
    return { personalized: true, language: p.language, tickers, questions: out };
}

// One system line steering the answer's "> Next:" question toward what this user researches.
function nextHint(questions, opts) {
    const p = profile(questions, opts);
    const topics = p.topics.slice(0, 3).map((k) => TOPIC_LABELS[k]);
    if (!topics.length && !p.tickers.length) return '';
    return 'FOLLOW-UP FOR THIS USER: across their recent questions they mostly research '
        + (topics.length ? topics.join(', ') : 'individual companies')
        + (p.tickers.length ? ` and follow ${p.tickers.slice(0, 5).join(', ')}` : '')
        + '. When you choose the "> Next:" question, prefer one in that direction that fits this answer and that they have not already asked, in the language they write in. Never name a figure in it.';
}

module.exports = { suggest, profile, nextHint, TOPICS };
