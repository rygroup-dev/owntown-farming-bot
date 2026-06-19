const { distance } = require('./movement');

// Pick the best alive monster: closest first (cheap, reliable), tie-break by lower hp.
function pickTarget({ monsters = [], pos = { x: 0, z: 0 } }) {
  const alive = monsters.filter((m) => m && m.alive && m.pos);
  if (alive.length === 0) return null;
  alive.sort((a, b) => {
    const da = distance(pos, a.pos);
    const db = distance(pos, b.pos);
    if (da !== db) return da - db;
    return (a.hp || 0) - (b.hp || 0);
  });
  return alive[0];
}
module.exports = { pickTarget };
