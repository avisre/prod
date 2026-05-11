if (!localStorage.getItem('token')) {
  const next = 'news.html' + (location.search || '');
  window.location.replace(`login.html?next=${encodeURIComponent(next)}`);
}

(function () {
  function resolveApiUrl() {
    if (typeof window !== 'undefined' && typeof window.API_URL === 'string' && window.API_URL) {
      return window.API_URL;
    }
    try {
      if (typeof window === 'undefined' || !window.location) return '/api';
      const { protocol, hostname } = window.location;
      const localHost = hostname === 'localhost' || hostname === '127.0.0.1';
      if (protocol === 'file:') return 'http://localhost:5000/api';
      if (localHost) return '/api';
      return '/api';
    } catch (_) {
      return '/api';
    }
  }

  const API_URL = resolveApiUrl();
  // Asset-class quick filters — each maps to a fixed set of representative
  // tickers (or an Alpha news topic) that we feed to /api/alpha/news.
  // Clicking a class clears the search box and reloads the feed scoped
  // to that asset universe.
  const ASSET_CLASSES = [
    { key: 'all',         label: 'All',         tickers: '',                              topic: null },
    { key: 'stocks',      label: 'Stocks',      tickers: 'SPY,QQQ,DIA,IWM',               topic: null },
    { key: 'crypto',      label: 'Crypto',      tickers: 'BTC,ETH,COIN,MARA,RIOT',        topic: 'blockchain' },
    { key: 'forex',       label: 'Forex',       tickers: 'UUP,FXE,FXY,FXB,EWY',           topic: null },
    { key: 'bonds',       label: 'Bonds',       tickers: 'TLT,AGG,BND,IEF,LQD',           topic: null },
    { key: 'commodities', label: 'Commodities', tickers: 'GLD,USO,SLV,DBA,UNG',           topic: null },
    { key: 'etfs',        label: 'ETFs',        tickers: 'SPY,QQQ,VTI,VOO,SCHD',          topic: null },
    { key: 'sectors',     label: 'Sectors',     tickers: 'XLK,XLF,XLE,XLV,XLI,XLY,XLP',   topic: null }
  ];

  const ALPHA_TOPICS = [
    'all', 'top_stories', 'world_news', 'financial_markets', 'economy_monetary', 'economy_fiscal', 'economy_macro',
    'technology', 'blockchain', 'earnings', 'ipo', 'mergers_and_acquisitions', 'energy_transportation', 'finance',
    'life_sciences', 'manufacturing', 'real_estate', 'retail_wholesale'
  ];
  const TOPIC_LABELS = {
    all: 'All',
    top_stories: 'Top Stories',
    world_news: 'World',
    financial_markets: 'Markets',
    economy_monetary: 'Monetary',
    economy_fiscal: 'Fiscal',
    economy_macro: 'Macro',
    technology: 'Tech',
    blockchain: 'Crypto',
    earnings: 'Earnings',
    ipo: 'IPO',
    mergers_and_acquisitions: 'M&A',
    energy_transportation: 'Energy',
    finance: 'Finance',
    life_sciences: 'Life Sciences',
    manufacturing: 'Manufacturing',
    real_estate: 'Real Estate',
    retail_wholesale: 'Retail'
  };

  // Tape: classic Yahoo Finance ticker bar — indices, commodities, crypto.
  const TAPE_SYMBOLS = [
    { label: 'S&P 500', proxy: 'SPY' },
    { label: 'Dow 30', proxy: 'DIA' },
    { label: 'Nasdaq', proxy: 'QQQ' },
    { label: 'Russell 2000', proxy: 'IWM' },
    { label: 'VIX', proxy: 'VXX' },
    { label: 'Crude Oil', proxy: 'USO' },
    { label: 'Gold', proxy: 'GLD' },
    { label: '10-Yr Bond', proxy: 'TLT' },
    { label: 'Bitcoin USD', proxy: 'BITO' }
  ];
  const MARKET_INDICES = TAPE_SYMBOLS.slice(0, 4); // sidebar shows the four equity indices
  const TOP_ETFS = [
    { label: 'SPY', proxy: 'SPY' },
    { label: 'QQQ', proxy: 'QQQ' },
    { label: 'VOO', proxy: 'VOO' },
    { label: 'VTI', proxy: 'VTI' },
    { label: 'IWM', proxy: 'IWM' }
  ];

  const $ = (id) => document.getElementById(id);
  const getQP = (k) => new URLSearchParams(location.search).get(k);
  const Loader = {
    show() { const el = $('loading-overlay'); if (el) el.removeAttribute('hidden'); },
    hide() { const el = $('loading-overlay'); if (el) el.setAttribute('hidden', ''); }
  };

  function authHeaders() {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  function maybeSymbol(raw) {
    const s = String(raw || '').trim().toUpperCase();
    if (!s) return null;
    return /^[A-Z][A-Z0-9.\-]{0,7}$/.test(s) ? s : null;
  }

  function parseAlphaDate(value) {
    const raw = String(value || '').trim();
    if (!raw || raw.length < 8) return null;
    const year = Number(raw.slice(0, 4));
    const month = Number(raw.slice(4, 6)) - 1;
    const day = Number(raw.slice(6, 8));
    const hour = raw.length >= 11 ? Number(raw.slice(9, 11)) : 0;
    const minute = raw.length >= 13 ? Number(raw.slice(11, 13)) : 0;
    const second = raw.length >= 15 ? Number(raw.slice(13, 15)) : 0;
    const date = new Date(Date.UTC(year, month, day, hour, minute, second));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function relativeTime(date) {
    if (!date) return '';
    const diff = Date.now() - date.getTime();
    if (diff < 0) return 'just now';
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  async function fetchStoredSuggestions(query) {
    if (window.SymbolLookup && typeof window.SymbolLookup.searchOne === 'function') {
      return window.SymbolLookup.searchOne(query);
    }
    return [];
  }

  async function resolveTickers(rawInput) {
    if (!rawInput) return [];
    const out = [];
    const parts = rawInput.split(',').map((p) => p.trim()).filter(Boolean);
    for (const part of parts) {
      const ticker = maybeSymbol(part);
      if (ticker) { out.push(ticker); continue; }
      const matches = await fetchStoredSuggestions(part).catch(() => []);
      if (Array.isArray(matches) && matches[0]?.symbol) {
        out.push(String(matches[0].symbol).toUpperCase());
      }
    }
    return Array.from(new Set(out));
  }

  async function fetchNews({ tickers, topics, limit = 50 }) {
    const params = new URLSearchParams({ sort: 'LATEST', limit: String(limit) });
    if (tickers) params.set('tickers', tickers);
    if (topics && topics !== 'all') params.set('topics', topics);
    const resp = await fetch(`${API_URL}/alpha/news?${params.toString()}`, { headers: authHeaders() });
    if (!resp.ok) throw new Error('Unable to load news feed');
    const payload = await resp.json().catch(() => ({}));
    const feed = Array.isArray(payload?.feed) ? payload.feed : [];
    return feed.map((item) => {
      const sentiments = Array.isArray(item.ticker_sentiment) ? item.ticker_sentiment : [];
      const tickerScores = sentiments
        .map((entry) => {
          const sym = String(entry?.ticker || '').trim().toUpperCase();
          if (!sym) return null;
          const relevance = Number.parseFloat(entry?.relevance_score);
          const sentiment = Number.parseFloat(entry?.ticker_sentiment_score);
          return {
            ticker: sym,
            relevance: Number.isFinite(relevance) ? relevance : 0,
            sentiment: Number.isFinite(sentiment) ? sentiment : 0
          };
        })
        .filter(Boolean);
      const tickerList = Array.from(new Set(tickerScores.map((t) => t.ticker))).slice(0, 4);
      return {
        title: item.title || 'Untitled',
        url: item.url || '#',
        date: parseAlphaDate(item.time_published),
        summary: item.summary || '',
        source: item.source || 'Market News',
        sentimentLabel: item.overall_sentiment_label || '',
        tickers: tickerList,
        tickerScores,
        imageUrl: item.banner_image || item.source_logo || ''
      };
    });
  }

  async function fetchQuoteForProxy(proxy) {
    const url = `${API_URL}/alpha/time-series/daily?symbol=${encodeURIComponent(proxy)}&outputsize=compact`;
    const resp = await fetch(url, { headers: authHeaders() });
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    const series = data?.['Time Series (Daily)'];
    if (!series) return null;
    const dates = Object.keys(series).sort((a, b) => (a < b ? 1 : -1));
    if (dates.length < 2) return null;
    const latest = parseFloat(series[dates[0]]['4. close']);
    const prior = parseFloat(series[dates[1]]['4. close']);
    if (!Number.isFinite(latest) || !Number.isFinite(prior) || prior === 0) return null;
    const change = latest - prior;
    const pct = (change / prior) * 100;
    // Keep last 30 closes (oldest → newest) so the ticker tape can draw a sparkline.
    const closes = dates.slice(0, 30).reverse()
      .map((d) => parseFloat(series[d]['4. close']))
      .filter((v) => Number.isFinite(v));
    return { value: latest, change, pct, closes };
  }

  function fmtNumber(value, fractionDigits = 2) {
    if (!Number.isFinite(value)) return '—';
    return value.toLocaleString(undefined, {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits
    });
  }

  function changeTone(change) {
    if (!Number.isFinite(change)) return 'flat';
    if (change > 0) return 'positive';
    if (change < 0) return 'negative';
    return 'flat';
  }

  function changeText(change, pct) {
    if (!Number.isFinite(change) || !Number.isFinite(pct)) return '—';
    const sign = change > 0 ? '+' : (change < 0 ? '−' : '');
    return `${sign}${Math.abs(change).toFixed(2)} (${sign}${Math.abs(pct).toFixed(2)}%)`;
  }

  function renderTopics() {
    const row = $('topics-row');
    if (!row) return;
    row.innerHTML = '';
    ALPHA_TOPICS.forEach((topic) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `chip${topic === 'all' ? ' active' : ''}`;
      btn.dataset.topic = topic;
      btn.textContent = TOPIC_LABELS[topic] || topic.replace(/_/g, ' ');
      row.appendChild(btn);
    });
  }

  function renderAssetClasses() {
    const row = $('asset-classes-row');
    if (!row) return;
    row.innerHTML = '';
    ASSET_CLASSES.forEach((cls) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `yf-asset-chip${cls.key === 'all' ? ' active' : ''}`;
      btn.dataset.asset = cls.key;
      btn.textContent = cls.label;
      row.appendChild(btn);
    });
  }

  function sentimentTone(label) {
    const value = String(label || '').toLowerCase();
    if (!value) return 'neutral';
    if (value.includes('bull') || value.includes('positive')) return 'positive';
    if (value.includes('bear') || value.includes('negative')) return 'negative';
    return 'neutral';
  }

  function shortSentiment(label) {
    const tone = sentimentTone(label);
    if (tone === 'positive') return 'Bullish';
    if (tone === 'negative') return 'Bearish';
    if (label) return 'Neutral';
    return '';
  }

  // Thumb renderer reused for hero (image + caption below) and stream (image-left)
  const FALLBACK_ART = [
    'Media/news-art/chart-up.svg',
    'Media/news-art/chart-down.svg',
    'Media/news-art/bars.svg',
    'Media/news-art/donut.svg',
    'Media/news-art/skyline.svg',
    'Media/news-art/document.svg'
  ];

  // Random fallback picker that avoids picking the same art twice in a row.
  // Reset on every page load (state lives in the closure), so consecutive
  // articles in the rendered list never collide.
  let _lastFallbackIdx = -1;
  function pickFallbackArt() {
    const n = FALLBACK_ART.length;
    if (n <= 1) return FALLBACK_ART[0];
    let idx = Math.floor(Math.random() * n);
    if (idx === _lastFallbackIdx) idx = (idx + 1) % n;
    _lastFallbackIdx = idx;
    return FALLBACK_ART[idx];
  }

  // Reset between full re-renders so a fresh load starts with a clean slate.
  function resetFallbackArt() { _lastFallbackIdx = -1; }

  function placeholderClass(container) {
    if (container === 'top') return 'yf-top-image-placeholder';
    if (container === 'hero') return 'yf-hero-placeholder';
    return 'yf-story-thumb-placeholder';
  }

  function buildFallbackImage(alt) {
    const img = document.createElement('img');
    img.src = pickFallbackArt();
    img.alt = alt || 'Market news illustration';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.classList.add('yf-fallback-art');
    return img;
  }

  function renderImage(url, alt) {
    if (!url) return buildFallbackImage(alt);
    const img = document.createElement('img');
    img.src = url;
    img.alt = alt;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => {
      img.replaceWith(buildFallbackImage(alt));
    }, { once: true });
    return img;
  }

  function buildMeta(item, host = 'story') {
    const meta = document.createElement('div');
    meta.className = host === 'hero' ? 'yf-hero-meta' : 'yf-story-meta';

    const source = document.createElement('span');
    source.className = 'yf-source';
    source.textContent = item.source;
    meta.appendChild(source);

    if (item.date) {
      meta.appendChild(document.createTextNode('•'));
      const time = document.createElement('span');
      time.textContent = relativeTime(item.date);
      meta.appendChild(time);
    }

    const sentimentText = shortSentiment(item.sentimentLabel);
    if (sentimentText) {
      const sentiment = document.createElement('span');
      sentiment.className = `yf-sentiment ${sentimentTone(item.sentimentLabel)}`;
      sentiment.textContent = sentimentText;
      meta.appendChild(sentiment);
    }
    return meta;
  }

  function buildTickerRow(item) {
    if (!item.tickers.length) return null;
    const row = document.createElement('div');
    row.className = 'yf-story-tickers';
    item.tickers.forEach((ticker) => {
      const a = document.createElement('a');
      a.className = 'yf-ticker-chip';
      a.textContent = ticker;
      a.href = `fundamentals.html?symbol=${encodeURIComponent(ticker)}`;
      a.setAttribute('data-guarded', '');
      a.addEventListener('click', (e) => e.stopPropagation());
      row.appendChild(a);
    });
    return row;
  }

  function buildSimpleMeta(item) {
    const meta = document.createElement('div');
    const src = document.createElement('span');
    src.className = 'yf-source';
    src.textContent = item.source;
    meta.appendChild(src);
    if (item.date) {
      meta.appendChild(document.createTextNode(' • '));
      const time = document.createElement('span');
      time.textContent = relativeTime(item.date);
      meta.appendChild(time);
    }
    return meta;
  }

  function renderFeatured(item) {
    const card = $('news-feature');
    if (!card) return;
    card.innerHTML = '';
    if (!item) { card.hidden = true; return; }
    card.hidden = false;
    card.href = item.url;

    const wrap = document.createElement('div');
    wrap.className = 'yf-feature-image';
    wrap.appendChild(renderImage(item.imageUrl, item.title));
    card.appendChild(wrap);

    const title = document.createElement('h2');
    title.className = 'yf-feature-title';
    title.textContent = item.title;
    card.appendChild(title);

    const meta = buildSimpleMeta(item);
    meta.className = 'yf-feature-meta';
    if (item.tickers.length) {
      meta.appendChild(document.createTextNode(' • '));
      const ticker = document.createElement('span');
      ticker.className = 'yf-source';
      ticker.textContent = item.tickers[0];
      meta.appendChild(ticker);
    }
    card.appendChild(meta);
  }

  function renderSecondary(items) {
    const host = $('news-secondary');
    if (!host) return;
    host.innerHTML = '';
    items.forEach((item) => {
      const card = document.createElement('a');
      card.className = 'yf-secondary-card';
      card.href = item.url;
      card.target = '_blank';
      card.rel = 'noopener noreferrer';

      const wrap = document.createElement('div');
      wrap.className = 'yf-secondary-image';
      wrap.appendChild(renderImage(item.imageUrl, item.title));
      card.appendChild(wrap);

      const title = document.createElement('h3');
      title.className = 'yf-secondary-title';
      title.textContent = item.title;
      card.appendChild(title);

      const meta = buildSimpleMeta(item);
      meta.className = 'yf-secondary-meta';
      card.appendChild(meta);
      host.appendChild(card);
    });
  }

  function renderLatestList(items) {
    const list = $('news-latest');
    if (!list) return;
    list.innerHTML = '';
    items.forEach((item) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.className = 'yf-latest-item';
      a.href = item.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';

      const title = document.createElement('div');
      title.className = 'yf-latest-title';
      title.textContent = item.title;
      a.appendChild(title);

      const meta = buildSimpleMeta(item);
      meta.className = 'yf-latest-meta';
      if (item.tickers.length) {
        meta.appendChild(document.createTextNode(' • '));
        const ticker = document.createElement('span');
        ticker.className = 'yf-ticker-chip';
        ticker.textContent = item.tickers[0];
        meta.appendChild(ticker);
      }
      a.appendChild(meta);
      li.appendChild(a);
      list.appendChild(li);
    });
  }

  function renderStream(items) {
    const stream = $('news-stream');
    if (!stream) return;
    stream.innerHTML = '';

    items.forEach((item) => {
      const card = document.createElement('a');
      card.className = 'yf-story';
      card.href = item.url;
      card.target = '_blank';
      card.rel = 'noopener noreferrer';

      // Image LEFT (Yahoo's news list pattern)
      const thumb = document.createElement('div');
      thumb.className = 'yf-story-thumb';
      const fallback = item.tickers[0] || item.source || 'NEWS';
      thumb.appendChild(renderImage(item.imageUrl, item.title));
      card.appendChild(thumb);

      const body = document.createElement('div');
      body.className = 'yf-story-body';

      const title = document.createElement('h3');
      title.className = 'yf-story-title';
      title.textContent = item.title;
      body.appendChild(title);

      body.appendChild(buildMeta(item));

      if (item.summary) {
        const summary = document.createElement('p');
        summary.className = 'yf-story-summary';
        summary.textContent = item.summary;
        body.appendChild(summary);
      }

      const tickers = buildTickerRow(item);
      if (tickers) body.appendChild(tickers);

      card.appendChild(body);
      stream.appendChild(card);
    });
  }

  function renderTrending(items) {
    const list = $('trending-list');
    if (!list) return;

    // Weighted trending: score = sum(relevance × |sentiment|) per ticker.
    // A high-relevance, strongly-sentimented mention beats a tangential one.
    // We also keep a count for tie-breaking and the dominant sentiment sign
    // so the chip can hint at bullish vs bearish trend.
    const stats = new Map();
    items.forEach((item) => {
      (item.tickerScores || []).forEach((entry) => {
        const ticker = entry.ticker;
        if (!ticker) return;
        const score = Math.max(0, entry.relevance) * Math.abs(entry.sentiment);
        const prev = stats.get(ticker) || { score: 0, mentions: 0, signedSum: 0 };
        prev.score += score;
        prev.mentions += 1;
        prev.signedSum += entry.relevance * entry.sentiment;
        stats.set(ticker, prev);
      });
    });
    const ranked = Array.from(stats.entries())
      .map(([ticker, s]) => ({
        ticker,
        score: s.score,
        mentions: s.mentions,
        tone: s.signedSum > 0.05 ? 'positive' : (s.signedSum < -0.05 ? 'negative' : 'flat')
      }))
      .filter((row) => row.score > 0 || row.mentions > 0)
      .sort((a, b) => (b.score - a.score) || (b.mentions - a.mentions))
      .slice(0, 8);

    list.innerHTML = '';
    if (!ranked.length) {
      const li = document.createElement('li');
      li.className = 'yf-tickers-empty';
      li.textContent = 'No mentions yet.';
      list.appendChild(li);
      return;
    }
    ranked.forEach(({ ticker, score, mentions, tone }) => {
      const li = document.createElement('li');
      const link = document.createElement('a');
      link.className = 'ticker';
      link.href = `fundamentals.html?symbol=${encodeURIComponent(ticker)}`;
      link.textContent = ticker;
      link.setAttribute('data-guarded', '');
      const value = document.createElement('span');
      value.className = 'value';
      // Show the weighted score as a compact buzz number; mentions in parens.
      value.textContent = score.toFixed(2);
      const meta = document.createElement('span');
      meta.className = `count change ${tone}`;
      meta.textContent = `${mentions} mention${mentions === 1 ? '' : 's'}`;
      li.appendChild(link);
      li.appendChild(value);
      li.appendChild(meta);
      list.appendChild(li);
    });
  }

  function renderTickerList(targetId, defs, quotes) {
    const list = $(targetId);
    if (!list) return;
    list.innerHTML = '';
    defs.forEach((def, idx) => {
      const quote = quotes[idx];
      const li = document.createElement('li');
      const ticker = document.createElement('a');
      ticker.className = 'ticker';
      ticker.href = `fundamentals.html?symbol=${encodeURIComponent(def.proxy)}`;
      ticker.textContent = def.label;
      ticker.setAttribute('data-guarded', '');
      const value = document.createElement('span');
      value.className = 'value';
      const change = document.createElement('span');
      if (quote) {
        value.textContent = fmtNumber(quote.value);
        change.className = `change ${changeTone(quote.change)}`;
        change.textContent = changeText(quote.change, quote.pct);
      } else {
        value.textContent = '—';
        change.className = 'change flat';
        change.textContent = '—';
      }
      li.appendChild(ticker);
      li.appendChild(value);
      li.appendChild(change);
      list.appendChild(li);
    });
  }

  // Build a small inline SVG sparkline (W×H) from a list of closes.
  // Stroke color follows the trend (green if last >= first, else red).
  function buildSparkline(closes, w = 72, h = 26) {
    if (!Array.isArray(closes) || closes.length < 2) return null;
    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const range = max - min || 1;
    const stepX = w / (closes.length - 1);
    const points = closes.map((c, i) => {
      const x = i * stepX;
      const y = h - ((c - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const trendUp = closes[closes.length - 1] >= closes[0];
    const color = trendUp ? 'var(--yf-positive)' : 'var(--yf-negative)';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'yf-tape-spark');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    // Fill area under the line for a richer look
    const area = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    area.setAttribute('points', `0,${h} ${points} ${w},${h}`);
    area.setAttribute('fill', color);
    area.setAttribute('fill-opacity', '0.12');
    area.setAttribute('stroke', 'none');
    svg.appendChild(area);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    line.setAttribute('points', points);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', '1.6');
    line.setAttribute('stroke-linejoin', 'round');
    line.setAttribute('stroke-linecap', 'round');
    svg.appendChild(line);
    return svg;
  }

  function buildTapeCard(def, q) {
    const card = document.createElement('a');
    card.className = 'yf-tape-card';
    card.href = `fundamentals.html?symbol=${encodeURIComponent(def.proxy)}`;
    card.setAttribute('data-guarded', '');

    const label = document.createElement('div');
    label.className = 'yf-tape-label';
    label.textContent = def.label;
    card.appendChild(label);

    const row = document.createElement('div');
    row.className = 'yf-tape-row';

    const priceCol = document.createElement('div');
    priceCol.className = 'yf-tape-pricecol';
    const price = document.createElement('div');
    price.className = 'yf-tape-price';
    price.textContent = q ? fmtNumber(q.value) : '—';
    priceCol.appendChild(price);
    const ch = document.createElement('div');
    ch.className = `yf-tape-change ${changeTone(q?.change)}`;
    ch.textContent = q ? changeText(q.change, q.pct) : '—';
    priceCol.appendChild(ch);
    row.appendChild(priceCol);

    const spark = q && q.closes ? buildSparkline(q.closes) : null;
    if (spark) row.appendChild(spark);

    card.appendChild(row);
    return card;
  }

  function renderTape(defs, quotes) {
    const track = $('ticker-tape');
    if (!track) return;
    track.innerHTML = '';
    // Build the first set of cards.
    defs.forEach((def, idx) => track.appendChild(buildTapeCard(def, quotes[idx])));
    // Duplicate them so the marquee loop seams without a gap when the
    // animation reaches -50% translateX.
    defs.forEach((def, idx) => track.appendChild(buildTapeCard(def, quotes[idx])));
  }

  async function loadMarketData() {
    try {
      const tapeQuotes = await Promise.all(
        TAPE_SYMBOLS.map((d) => fetchQuoteForProxy(d.proxy).catch(() => null))
      );
      renderTape(TAPE_SYMBOLS, tapeQuotes);
    } catch (_) {
      renderTape(TAPE_SYMBOLS, TAPE_SYMBOLS.map(() => null));
    }
  }

  function renderMoverList(targetId, rows) {
    const list = $(targetId);
    if (!list) return;
    list.innerHTML = '';
    if (!rows || !rows.length) {
      const li = document.createElement('li');
      li.className = 'yf-tickers-empty';
      li.textContent = 'No data right now.';
      list.appendChild(li);
      return;
    }
    rows.slice(0, 6).forEach((row) => {
      const ticker = String(row.ticker || '').toUpperCase();
      const price = Number.parseFloat(row.price);
      const change = Number.parseFloat(row.change_amount);
      const pctRaw = String(row.change_percentage || '').replace('%', '').trim();
      const pct = Number.parseFloat(pctRaw);

      const li = document.createElement('li');
      const link = document.createElement('a');
      link.className = 'ticker';
      link.href = `fundamentals.html?symbol=${encodeURIComponent(ticker)}`;
      link.setAttribute('data-guarded', '');
      link.textContent = ticker;
      const value = document.createElement('span');
      value.className = 'value';
      value.textContent = Number.isFinite(price) ? price.toFixed(2) : '—';
      const ch = document.createElement('span');
      const tone = changeTone(change);
      ch.className = `change ${tone}`;
      ch.textContent = Number.isFinite(pct)
        ? `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`
        : '—';
      li.appendChild(link);
      li.appendChild(value);
      li.appendChild(ch);
      list.appendChild(li);
    });
  }

  async function loadMovers() {
    const setMessage = (msg) => {
      ['movers-gainers', 'movers-losers', 'movers-active'].forEach((id) => {
        const list = $(id);
        if (!list) return;
        list.innerHTML = '';
        const li = document.createElement('li');
        li.className = 'yf-tickers-empty';
        li.textContent = msg;
        list.appendChild(li);
      });
    };
    try {
      const resp = await fetch(`${API_URL}/alpha/movers`, { headers: authHeaders() });
      if (resp.status === 401) {
        setMessage('Sign in to see market movers.');
        return;
      }
      if (resp.status === 402) {
        setMessage('Active subscription required.');
        return;
      }
      if (resp.status === 429) {
        setMessage('Rate-limited. Try again shortly.');
        return;
      }
      if (!resp.ok) {
        console.warn('[news] movers fetch failed:', resp.status);
        setMessage(`Movers unavailable (HTTP ${resp.status}).`);
        return;
      }
      const data = await resp.json();
      const note = String(data?.Information || data?.Note || '');
      if (note && (!Array.isArray(data?.top_gainers) || !data.top_gainers.length)) {
        // Alpha sometimes returns a 200 with an "Information" rate-limit message.
        console.warn('[news] movers rate-limit note:', note.slice(0, 120));
        setMessage('Movers throttled by data provider.');
        return;
      }
      renderMoverList('movers-gainers', data.top_gainers);
      renderMoverList('movers-losers',  data.top_losers);
      renderMoverList('movers-active',  data.most_actively_traded);
    } catch (error) {
      console.error('[news] movers load error:', error);
      setMessage('Movers unavailable right now.');
    }
  }

  function loadRecentlyViewed() {
    const list = $('recent-viewed');
    if (!list) return;
    let stored = [];
    try { stored = JSON.parse(localStorage.getItem('recentSymbols') || '[]'); } catch (_) {}
    if (!Array.isArray(stored) || !stored.length) {
      list.innerHTML = '<li class="yf-tickers-empty">Visit a fundamentals page to start tracking.</li>';
      return;
    }
    list.innerHTML = '';
    stored.slice(0, 8).forEach((entry) => {
      const ticker = (entry && entry.symbol) || (typeof entry === 'string' ? entry : '');
      if (!ticker) return;
      const li = document.createElement('li');
      const link = document.createElement('a');
      link.className = 'ticker';
      link.href = `fundamentals.html?symbol=${encodeURIComponent(ticker)}`;
      link.setAttribute('data-guarded', '');
      link.textContent = ticker;
      const value = document.createElement('span');
      value.className = 'value';
      value.textContent = entry.name ? entry.name.slice(0, 18) : '';
      const meta = document.createElement('span');
      meta.className = 'count';
      if (entry.viewedAt) {
        const dt = new Date(entry.viewedAt);
        if (!Number.isNaN(dt.getTime())) meta.textContent = relativeTime(dt);
      }
      li.appendChild(link);
      li.appendChild(value);
      li.appendChild(meta);
      list.appendChild(li);
    });
  }

  function bindSearchInput() {
    const input = $('tickers');
    const results = $('news-search-results');
    if (!input || !results) return;

    function hideResults() {
      results.innerHTML = '';
      results.classList.add('hidden');
    }

    function applySelection(symbol) {
      const chunks = input.value.split(',');
      chunks[chunks.length - 1] = symbol;
      input.value = chunks.map((part) => part.trim()).filter(Boolean).join(', ');
      hideResults();
    }

    async function onInput() {
      const raw = input.value || '';
      const activeChunk = raw.split(',').pop().trim();
      if (activeChunk.length < 2) { hideResults(); return; }
      const list = await fetchStoredSuggestions(activeChunk).catch(() => []);
      if (!Array.isArray(list) || !list.length) { hideResults(); return; }
      results.innerHTML = '';
      list.slice(0, 8).forEach((entry) => {
        const li = document.createElement('li');
        li.textContent = `${entry.name} (${entry.symbol})`;
        li.addEventListener('mousedown', (event) => {
          event.preventDefault();
          applySelection(entry.symbol);
        });
        results.appendChild(li);
      });
      results.classList.remove('hidden');
    }

    input.addEventListener('input', onInput);
    document.addEventListener('click', (event) => {
      if (event.target === input || results.contains(event.target)) return;
      hideResults();
    });
  }

  function setupController() {
    let currentTopic = 'all';
    let currentAsset = 'all';
    const loadBtn = $('load');
    const input = $('tickers');
    const empty = $('news-empty');
    const hero = $('news-hero');

    function setEmpty(visible) {
      if (empty) empty.hidden = !visible;
      if (hero && visible) hero.hidden = true;
    }

    async function load() {
      if (!input) return;
      const raw = input.value.trim();
      Loader.show();
      setEmpty(false);
      try {
        // When an asset class is selected (non-"all"), it overrides the
        // search box's tickers and may also pin a topic. Search input
        // takes precedence only when no asset class is selected.
        const assetCls = ASSET_CLASSES.find((c) => c.key === currentAsset);
        let tickers = '';
        let topic = currentTopic;
        if (assetCls && assetCls.key !== 'all') {
          tickers = assetCls.tickers || '';
          if (assetCls.topic && topic === 'all') topic = assetCls.topic;
        } else {
          const resolved = await resolveTickers(raw);
          tickers = resolved.length ? resolved.join(',') : '';
        }
        const items = await fetchNews({ tickers, topics: topic, limit: 60 });
        if (!items.length) {
          renderFeatured(null);
          renderSecondary([]);
          renderLatestList([]);
          renderStream([]);
          renderTrending([]);
          setEmpty(true);
          return;
        }
        // 1 featured + up to 2 secondary cards on the left column,
        // 8 compact headlines in the middle "Latest" column,
        // remainder fills the bottom "More news" stream.
        resetFallbackArt();
        const featured = items[0];
        const secondary = items.slice(1, 3);
        const latest = items.slice(3, 11);
        const more = items.slice(11);

        renderFeatured(featured);
        renderSecondary(secondary);
        renderLatestList(latest);
        renderStream(more);
        renderTrending(items);
      } catch (error) {
        console.error('News load failed:', error);
        renderFeatured(null);
        renderSecondary([]);
        renderLatestList([]);
        renderStream([]);
        setEmpty(true);
      } finally {
        Loader.hide();
      }
    }

    if (loadBtn) {
      loadBtn.addEventListener('click', () => {
        load().catch(() => { Loader.hide(); setEmpty(true); });
      });
    }

    if (input) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          loadBtn?.click();
        }
      });
    }

    document.addEventListener('click', (event) => {
      const topicButton = event.target.closest('.chip[data-topic]');
      if (!topicButton) return;
      document.querySelectorAll('.chip[data-topic]').forEach((btn) => btn.classList.remove('active'));
      topicButton.classList.add('active');
      currentTopic = topicButton.dataset.topic || 'all';
      load().catch(() => { Loader.hide(); setEmpty(true); });
    });

    document.addEventListener('click', (event) => {
      const assetButton = event.target.closest('.yf-asset-chip[data-asset]');
      if (!assetButton) return;
      document.querySelectorAll('.yf-asset-chip[data-asset]').forEach((b) => b.classList.remove('active'));
      assetButton.classList.add('active');
      currentAsset = assetButton.dataset.asset || 'all';
      // When jumping to an asset class, clear the search box so the
      // override is visible. Search-driven workflow stays available
      // by clicking back to "All".
      if (input && currentAsset !== 'all') input.value = '';
      load().catch(() => { Loader.hide(); setEmpty(true); });
    });

    return { load };
  }

  document.addEventListener('DOMContentLoaded', () => {
    renderTopics();
    renderAssetClasses();
    bindSearchInput();
    const input = $('tickers');
    const qpTickers = getQP('tickers');
    if (input && qpTickers) input.value = qpTickers;
    const controller = setupController();
    loadMarketData();
    loadMovers();
    loadRecentlyViewed();
    controller.load().catch(() => { Loader.hide(); });
  });
})();
