function getMarketDepth(marketHistory, defId) {
  const latest = Array.isArray(marketHistory) ? marketHistory[marketHistory.length - 1] : null;
  return latest ? (latest.counts?.[defId] || 0) : 0;
}

function getPriceTrend(marketHistory, defId) {
  if (!Array.isArray(marketHistory) || marketHistory.length < 3) return 'stable';
  const recent = marketHistory
    .slice(-3)
    .map((entry) => entry?.prices?.[defId])
    .filter(Boolean);
  if (recent.length < 2) return 'stable';
  const avg = recent.reduce((sum, value) => sum + value, 0) / recent.length;
  const change = (recent[recent.length - 1] - avg) / avg;
  if (change > 0.1) return 'rising';
  if (change < -0.1) return 'falling';
  return 'stable';
}

function buildSellDecision({
  defId,
  marketPrices = {},
  marketHistory = [],
  priceFloor = {},
  quicksell = {},
  marketplaceOnly = new Set(),
  safeQuicksell = new Set(),
  undercutPct = 0.08,
}) {
  const floor = priceFloor[defId] || 0;
  const qsPrice = quicksell[defId] || 0;
  const marketPrice = marketPrices[defId];
  const depth = getMarketDepth(marketHistory, defId);
  const trend = getPriceTrend(marketHistory, defId);
  const undercut = (basePrice, minFloor) => Math.max(minFloor, Math.round(basePrice * (1 - undercutPct) * 10) / 10);

  if (marketplaceOnly.has(defId)) {
    if (marketPrice && marketPrice >= floor) {
      return { action: 'MARKETPLACE', price: undercut(marketPrice, floor), marketBest: marketPrice, depth, trend };
    }
    return { action: 'HOLD', reason: `valuable (floor ${floor})`, floor };
  }

  if (safeQuicksell.has(defId)) {
    if (marketPrice && marketPrice > 0.5) {
      return { action: 'MARKETPLACE', price: undercut(marketPrice, floor || 0.1), marketBest: marketPrice, depth, trend };
    }
    return { action: 'QUICKSELL', price: qsPrice };
  }

  if (marketPrice && marketPrice > 0.1) {
    return { action: 'MARKETPLACE', price: undercut(marketPrice, 0.1), marketBest: marketPrice, depth, trend };
  }
  if (floor > 0) return { action: 'HOLD', reason: 'no market data, has value', floor };
  return { action: 'QUICKSELL', price: qsPrice || 1 };
}

module.exports = { buildSellDecision, getMarketDepth, getPriceTrend };
