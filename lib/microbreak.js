// Pure helpers for human-like idle micro-breaks between activity cycles.
function nextBreakAfter(cfg, rng = Math.random) {
  const min = cfg.everyMin, max = cfg.everyMax;
  return Math.round(min + rng() * (max - min));
}
function isBreakDue(state, cycles) {
  return cycles >= state.dueAtCycle;
}
function breakDurationMs(cfg, rng = Math.random) {
  const min = cfg.minSec, max = cfg.maxSec;
  return Math.round((min + rng() * (max - min)) * 1000);
}
module.exports = { nextBreakAfter, isBreakDue, breakDurationMs };
