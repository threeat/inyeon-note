// 만남 후기로 추천 다듬기: "또 만나고 싶어요"면 그 사람과 잘 맞았던 항목의 중요도를,
// "아니었어요"면 고른 이유에 해당하는 항목의 중요도를 한 단계 올린다.
// 무엇이 왜 바뀌었는지 돌려주고, 이전 중요도를 함께 남겨 되돌릴 수 있게 한다. 상대에게는 알리지 않는다.
(function (root) {
  const Rules = root.Rules || (typeof require === 'function' ? require('./rules.js') : null);
  const { josa } = root.Hangul || (typeof require === 'function' ? require('./hangul.js') : null);
  const LADDER = Rules.WEIGHT_LEVELS.map((l) => l.value); // 0, 0.5, 1, 2, 3
  const levelLabel = (v) => (Rules.WEIGHT_LEVELS.find((l) => l.value === v) || { label: `×${v}` }).label;
  const current = (weights, key) => (weights && typeof weights[key] === 'number' ? weights[key] : 1);
  const up = (v) => LADDER[Math.min(LADDER.indexOf(LADDER.includes(v) ? v : 1) + 1, LADDER.length - 1)];

  // '아니었어요'의 이유 → 올릴 항목 (null이면 바꾸지 않음)
  const REASONS = [
    { key: 'talk', label: '대화가 잘 안 통했어요', item: 'intro' },
    { key: 'interests', label: '함께할 거리가 없었어요', item: 'interests' },
    { key: 'lifestyle', label: '생활 습관이 달랐어요', item: 'lifestyle' },
    { key: 'distance', label: '오가기가 멀었어요', item: 'region' },
    { key: 'future', label: '바라는 관계가 달랐어요', item: 'marriage' },
    { key: 'spark', label: '그냥 끌리지 않았어요', item: null },
  ];

  // scored: 그 사람의 점수 결과(matcher.scoreProfile). verdict: 'again' | 'not'. reason: REASONS의 key
  // → { weights: 새 중요도, changes: [{ key, label, from, to, why }] }
  function learn(weights, scored, verdict, reason) {
    const next = { ...(weights || {}) };
    const changes = [];
    const bump = (item, why) => {
      const from = current(next, item.key);
      const to = up(from);
      if (to === from) return;
      next[item.key] = to;
      changes.push({ key: item.key, label: item.label, from: levelLabel(from), to: levelLabel(to), why });
    };
    const items = scored.items.filter((it) => it.max > 0);
    if (verdict === 'again') {
      // 만점의 70% 넘게 받은 항목 중 비율이 높은 2개
      items.filter((it) => it.points / it.max >= 0.7).sort((a, b) => b.points / b.max - a.points / a.max).slice(0, 2)
        .forEach((it) => bump(it, `${scored.profile.name}님과 ${josa(it.label, '이/가')} 잘 맞았어요 (${it.points}/${it.max}점).`));
    } else if (verdict === 'not') {
      const r = REASONS.find((x) => x.key === reason);
      const it = r && r.item && scored.items.find((x) => x.key === r.item);
      if (it) bump(it, `'${r.label}'라고 하셔서 ${josa(it.label, '을/를')} 더 꼼꼼히 봐요.`);
    }
    return { weights: next, changes };
  }

  const Feedback = { learn, REASONS };
  root.Feedback = Feedback;
  if (typeof module === 'object' && module.exports) module.exports = Feedback;
})(typeof window !== 'undefined' ? window : globalThis);
