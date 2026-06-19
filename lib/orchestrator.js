// Adaptive weights: boost an activity when items it yields are priced highly.
function activityWeights({ marketPrices = {}, base = {}, miningItems = [], fishingItems = [], highPrice = 10 }) {
  const out = { ...base };
  const maxOf = (ids) => ids.reduce((m, id) => Math.max(m, marketPrices[id] || 0), 0);
  if (out.mining != null && maxOf(miningItems) >= highPrice) out.mining = out.mining + 2;
  if (out.fishing != null && maxOf(fishingItems) >= highPrice) out.fishing = out.fishing + 2;
  return out;
}
module.exports = { activityWeights };
