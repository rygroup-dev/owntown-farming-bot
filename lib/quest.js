// Map an active quest to the activity it needs. Known ids win; otherwise infer
// from keywords in the quest id so new quests work without a code change.
const KEYWORDS = [
  [/fish|catch|angler|koi|carp/i, 'fishing'],
  [/mine|mining|deepworks|ore|resonite|node/i, 'mining'],
  [/defeat|kill|threat|combat|hunt|slay|monster/i, 'combat'],
  [/sell|haul|market|list/i, 'sell'],
];
function questActionFor(questState, knownMap = {}) {
  if (!questState || !questState.activeId) return null;
  const id = questState.activeId;
  if (knownMap[id]) return knownMap[id];
  for (const [re, action] of KEYWORDS) if (re.test(id)) return action;
  return null;
}
module.exports = { questActionFor };
