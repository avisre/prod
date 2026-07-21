// Shared symbol lookup utility using backend storage + Alpha fallback.
(function(){
  function resolveApiUrl() {
    if (typeof window !== 'undefined' && typeof window.API_URL === 'string' && window.API_URL) {
      return window.API_URL;
    }
    try {
      if (typeof window === 'undefined' || !window.location) return '/api';
      const { protocol, hostname, port } = window.location;
      const localHost = hostname === 'localhost' || hostname === '127.0.0.1';
      if (protocol === 'file:') {
        return 'http://localhost:5000/api';
      }
      if (localHost) {
        return '/api';
      }
      return '/api';
    } catch (_) {
      return '/api';
    }
  }

  const API_URL = resolveApiUrl();

  function getHeaders() {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  function normalizeStored(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter(item => item && item.symbol && item.name)
      .map(item => ({
        symbol: String(item.symbol).toUpperCase(),
        name: String(item.name),
        marketCap: item.marketCap || null,
        peRatio: item.peRatio || null,
        eps: item.eps || null,
        sector: item.sector || '',
        category: item.category || '',
        assetType: item.assetType || 'stock',
        assetTypeLabel: item.assetTypeLabel || (item.assetType === 'etf' ? 'ETF' : item.assetType === 'mutual_fund' ? 'Mutual fund' : 'Stock'),
        quoteType: item.quoteType || ''
      }));
  }

  async function searchAssets(query) {
    const trimmed = (query || '').trim();
    if (!trimmed) return [];
    const url = `${API_URL}/assets/search?q=${encodeURIComponent(trimmed)}&limit=12`;
    const resp = await fetch(url, { headers: getHeaders() });
    if (!resp.ok) return [];
    return normalizeStored(await resp.json().catch(() => []));
  }

  async function searchTopSheet(query) {
    if (!window.Top100Sheet || typeof window.Top100Sheet.search !== 'function') return [];
    return window.Top100Sheet.search(query, 10);
  }

  async function searchStored(query) {
    const trimmed = (query || '').trim();
    if (!trimmed) return [];
    const url = `${API_URL}/companies/search?q=${encodeURIComponent(trimmed)}&limit=10`;
    const resp = await fetch(url, { headers: getHeaders() });
    if (!resp.ok) return [];
    return normalizeStored(await resp.json().catch(() => []));
  }

  async function searchAlpha(query) {
    const trimmed = (query || '').trim();
    if (!trimmed) return [];
    const url = `${API_URL}/alpha/search?keywords=${encodeURIComponent(trimmed)}`;
    const resp = await fetch(url, { headers: getHeaders() });
    if (!resp.ok) return [];
    const data = await resp.json().catch(() => ({}));
    const list = Array.isArray(data?.bestMatches) ? data.bestMatches : [];
    return list.slice(0, 10).map((m) => ({
      symbol: String(m['1. symbol'] || '').toUpperCase(),
      name: String(m['2. name'] || '').trim()
    })).filter(item => item.symbol && item.name);
  }

  async function searchOne(query){
    const assets = await searchAssets(query).catch(() => []);
    if (assets.length) return assets;
    const topSheet = await searchTopSheet(query).catch(() => []);
    if (topSheet.length) return topSheet;
    const local = await searchStored(query).catch(() => []);
    if (local.length) return local;
    return searchAlpha(query).catch(() => []);
  }

  window.SymbolLookup = { searchOne };
})();
