// 질문 카드: 정해진 질문에 짧게 답해 프로필에 붙인다. 상대는 마음에 드는 답에 한마디를 남기며 관심을 보낼 수 있다.
// 가상 회원의 답은 profiles.js에, 내 답은 me.prompts([{ q, a }])에 있다. 점수에는 쓰지 않는다.
(function (root) {
  const QUESTIONS = [
    { key: 'weekend', text: '완벽한 주말은' },
    { key: 'firstDate', text: '첫 데이트로 가고 싶은 곳' },
    { key: 'into', text: '요즘 빠져 있는 것' },
    { key: 'match', text: '나와 잘 맞는 사람은' },
    { key: 'joy', text: '사소하지만 확실한 행복' },
    { key: 'together', text: '같이 해 보고 싶은 것' },
    { key: 'friends', text: '친구들이 말하는 나는' },
    { key: 'green', text: '이런 모습에 마음이 열려요' },
  ];
  const MAX_CARDS = 2;
  const MAX_ANSWER = 80;
  const byKey = Object.fromEntries(QUESTIONS.map((q) => [q.key, q]));
  const questionText = (key) => (byKey[key] ? byKey[key].text : '');

  // 저장된 카드를 정리한다: 아는 질문만, 빈 답 빼고, 같은 질문은 한 번만, 최대 2장
  function clean(cards) {
    const seen = new Set();
    return (Array.isArray(cards) ? cards : [])
      .map((c) => ({ q: c && c.q, a: String((c && c.a) || '').trim().slice(0, MAX_ANSWER) }))
      .filter((c) => byKey[c.q] && c.a && !seen.has(c.q) && seen.add(c.q))
      .slice(0, MAX_CARDS);
  }

  // 한마디를 남길 수 있는 대상: 질문 카드들 + 자기소개. { target, label, text }
  function targetsOf(person) {
    const list = clean(person.prompts).map((c) => ({ target: `q:${c.q}`, label: questionText(c.q), text: c.a }));
    if ((person.intro || '').trim()) list.push({ target: 'intro', label: '자기소개', text: person.intro.trim() });
    return list;
  }
  const findTarget = (person, target) => targetsOf(person).find((t) => t.target === target) || null;

  const Prompts = { QUESTIONS, MAX_CARDS, MAX_ANSWER, questionText, clean, targetsOf, findTarget };
  root.Prompts = Prompts;
  if (typeof module === 'object' && module.exports) module.exports = Prompts;
})(typeof window !== 'undefined' ? window : globalThis);
