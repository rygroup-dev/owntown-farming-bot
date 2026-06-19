function distance(a, b) {
  const dx = (b.x || 0) - (a.x || 0);
  const dz = (b.z || 0) - (a.z || 0);
  return Math.sqrt(dx * dx + dz * dz);
}

function inRange(pos, target, range) {
  return distance(pos, target) <= range;
}

module.exports = { distance, inRange };
