// Frontend sheet cache for top 100 market-cap companies.
(function () {
  const SHEET_URL = 'data/top-100-companies.json';
  let loadedList = null;
  let loadedMap = null;
  let loadingPromise = null;

  function normalizeNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function normalizeItem(item) {
    if (!item || !item.symbol || !item.name) return null;
    return {
      symbol: String(item.symbol).trim().toUpperCase(),
      name: String(item.name).trim(),
      marketCap: normalizeNumber(item.marketCap),
      peRatio: normalizeNumber(item.peRatio),
      eps: normalizeNumber(item.eps),
      sector: String(item.sector || '').trim()
    };
  }

  function normalizeList(list) {
    if (!Array.isArray(list)) return [];
    return list.map(normalizeItem).filter(Boolean);
  }

  async function ensureLoaded() {
    if (loadedList) return loadedList;
    if (loadingPromise) return loadingPromise;
    loadingPromise = fetch(SHEET_URL)
      .then((response) => (response.ok ? response.json() : []))
      .then((raw) => {
        loadedList = normalizeList(raw);
        loadedMap = new Map(loadedList.map((item) => [item.symbol, item]));
        return loadedList;
      })
      .catch(() => {
        loadedList = [];
        loadedMap = new Map();
        return loadedList;
      })
      .finally(() => {
        loadingPromise = null;
      });
    return loadingPromise;
  }

  function getBySymbolSync(symbol) {
    if (!loadedMap) return null;
    const key = String(symbol || '').trim().toUpperCase();
    if (!key) return null;
    return loadedMap.get(key) || null;
  }

  async function getBySymbol(symbol) {
    await ensureLoaded();
    return getBySymbolSync(symbol);
  }

  function scoreMatch(query, item) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return -1;
    const symbol = item.symbol.toLowerCase();
    const name = item.name.toLowerCase();
    if (symbol === q) return 100;
    if (name === q) return 95;
    if (symbol.startsWith(q)) return 90;
    if (name.startsWith(q)) return 80;
    if (name.includes(q)) return 70;
    if (symbol.includes(q)) return 60;
    return -1;
  }

  async function search(query, limit = 10) {
    await ensureLoaded();
    const capped = Math.max(1, Math.min(Number(limit) || 10, 25));
    const scored = [];
    for (const item of loadedList || []) {
      const score = scoreMatch(query, item);
      if (score >= 0) scored.push({ score, item });
    }
    return scored
      .sort((a, b) => b.score - a.score || (b.item.marketCap || 0) - (a.item.marketCap || 0))
      .slice(0, capped)
      .map((entry) => entry.item);
  }

  window.Top100Sheet = {
    ensureLoaded,
    getBySymbol,
    getBySymbolSync,
    search
  };
})();
