// Weighted-random pick among eligible activities (non-deterministic rotation).
function pickActivity({ eligible = [], weights = {}, rng = Math.random }) {
  if (eligible.length === 0) return null;
  const w = eligible.map((a) => Math.max(0, weights[a] || 1));
  const total = w.reduce((s, x) => s + x, 0);
  if (total <= 0) return eligible[0];
  let r = rng() * total;
  for (let i = 0; i < eligible.length; i++) {
    r -= w[i];
    if (r < 0) return eligible[i];
  }
  return eligible[eligible.length - 1];
}
module.exports = { pickActivity };
