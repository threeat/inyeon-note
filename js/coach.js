// 프로필 코치: 내 프로필에서 고칠 점과, 고치면 매칭에 무엇이 좋아지는지 알려 준다.
// - 점검: 사진, 자기소개, 질문 카드, 세부 취향을 규칙으로 본다 (AI 없이도 동작)
// - AI: 자기소개를 읽고 더 구체적으로 쓰는 방법을 제안한다. 글을 대신 바꾸지는 않는다.
(function (root) {
  const LLM = root.LLM || (typeof require === 'function' ? require('./llm.js') : null);
  const Prompts = root.Prompts || (typeof require === 'function' ? require('./prompts.js') : null);

  // 누구에게나 해당돼서 나를 알려 주지 못하는 표현
  const VAGUE = ['좋은 사람', '착한 사람', '평범한', '진실된', '진지한 만남', '잘 부탁', '많관부', '편한 사람', '성격 좋은'];
  // "~안 하는 사람"처럼 싫은 것으로 자신을 설명하는 표현
  const NEGATIVE = /(없는|안\s*하는|않는|싫은)\s*(사람|분)|사절|노\s*(?:답|매너)/;

  // 자기소개 문장 점검: [{ kind, text }]
  function introHints(intro) {
    const t = String(intro || '').trim();
    const hints = [];
    if (!t) return hints;
    const sentences = t.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
    if (t.length < 40) hints.push({ kind: 'short', text: `지금 ${t.length}자예요. 쉬는 날 하는 일과 좋아하는 데이트를 2~3문장으로 늘리면 뜻이 닮은 분을 더 잘 찾아요.` });
    else if (sentences.length < 2) hints.push({ kind: 'oneSentence', text: '한 문장뿐이에요. 주말 모습 한 문장, 좋아하는 데이트 한 문장처럼 나눠 써 보세요.' });
    const vague = VAGUE.filter((w) => t.includes(w));
    if (vague.length) hints.push({ kind: 'vague', text: `'${vague.join("', '")}' 같은 말은 누구나 써서 나를 보여 주지 못해요. 대신 실제로 하는 일을 적어 보세요. 예) "주말엔 둘레길을 걷고 국밥집을 찾아가요."` });
    if (NEGATIVE.test(t)) hints.push({ kind: 'negative', text: '싫은 것보다 좋아하는 것을 적으면 첫인상이 부드러워요. 꼭 피하고 싶은 조건은 "절대 조건"에서 켜면 돼요.' });
    if (!/\d|주말|퇴근|아침|저녁|밤|쉬는\s*날|휴가/.test(t)) hints.push({ kind: 'concrete', text: '언제, 어디서, 무엇을 하는지가 보이면 대화 소재가 생겨요. "퇴근하면", "주말엔"처럼 때를 넣어 보세요.' });
    return hints;
  }

  // 프로필 점검: { score(0~100), items: [{ key, ok, title, tip, impact }] }
  function check(me) {
    const cards = Prompts.clean(me.prompts);
    const withDetails = me.interests.filter((c) => (me.interestDetails && me.interestDetails[c] || []).length).length;
    const intro = (me.intro || '').trim();
    const hints = introHints(intro);
    const items = [
      { key: 'photo', weight: 20, ok: Boolean(me.photo), title: '프로필 사진',
        tip: '얼굴이 잘 보이는 사진을 올려 주세요.', impact: '상대가 나를 알아보고 믿을 수 있어요.' },
      { key: 'intro', weight: 30, ok: intro.length >= 40 && !hints.some((h) => h.kind === 'short'), title: '자기소개 2~3문장',
        tip: intro ? '조금 더 길게 써 주세요.' : '쉬는 날 하는 일, 좋아하는 데이트를 2~3문장으로 써 주세요.',
        impact: '자기소개 항목(최대 10점)이 켜져, 뜻이 닮은 분이 위로 올라와요.' },
      { key: 'introQuality', weight: 15, ok: intro.length > 0 && !hints.some((h) => ['vague', 'negative', 'concrete'].includes(h.kind)), title: '구체적인 자기소개',
        tip: hints.filter((h) => h.kind !== 'short').map((h) => h.text)[0] || '자기소개를 먼저 써 주세요.',
        impact: '구체적인 문장일수록 비슷한 하루를 보내는 분과 유사도가 높게 나와요.' },
      { key: 'prompts', weight: 20, ok: cards.length >= Prompts.MAX_CARDS, title: `질문 카드 ${Prompts.MAX_CARDS}장`,
        tip: `지금 ${cards.length}장이에요. 질문 카드에 답하면 상대가 그 답에 한마디를 남길 수 있어요.`,
        impact: '한마디와 함께 온 관심은 매칭 기준이 5점 낮아져요. 상대도 말 걸 거리가 생겨요.' },
      { key: 'details', weight: 15, ok: me.interests.length > 0 && withDetails === me.interests.length, title: '관심사 세부 취향',
        tip: `관심사 ${me.interests.length}개 중 ${withDetails}개만 세부 취향을 골랐어요.`,
        impact: '세부 취향까지 겹치는 분을 알아봐요. 첫 마디 추천도 더 구체적이 돼요.' },
    ];
    const score = items.reduce((s, it) => s + (it.ok ? it.weight : 0), 0);
    return { score, items: items.map(({ weight, ...rest }) => rest), hints };
  }

  // AI 코칭: { tips: [문장 3개], example: 고쳐 쓴 예시 } — 사용자의 사실을 지어내지 않게 한다
  async function aiReview(ai, me) {
    const cards = Prompts.clean(me.prompts).map((c) => `${Prompts.questionText(c.q)}: ${c.a}`).join(' / ');
    const system = [
      '당신은 소개팅 앱 "인연노트"의 프로필 코치입니다. 사용자의 자기소개를 읽고 더 매력적이고 구체적으로 쓰는 방법을 알려 줍니다.',
      '[규칙]',
      '- 조언 3개: 각각 한 문장 존댓말, 실제 문장을 짚어서 구체적으로.',
      '- 예시: 사용자가 쓴 사실만 써서 2~3문장으로 고쳐 쓴 자기소개. 없는 직업·취미·경험을 지어내지 마세요. 200자 이내.',
      '- 외모 평가, 연락처, 과장된 표현은 넣지 마세요.',
      '- 반드시 JSON 한 덩어리로만 답하세요: {"tips": ["…", "…", "…"], "example": "…"}',
    ].join('\n');
    const user = `관심사: ${me.interests.join(', ')}\n자기소개: "${(me.intro || '').trim() || '(없음)'}"${cards ? `\n질문 카드: ${cards}` : ''}`;
    const res = await LLM.complete(ai, { system, messages: [{ role: 'user', content: user }], maxTokens: 700, json: true });
    const out = LLM.parseJson(res.text) || {};
    const tips = Array.isArray(out.tips) ? out.tips.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, 3) : [];
    const example = typeof out.example === 'string' ? out.example.trim().slice(0, 200) : '';
    if (!tips.length && !example) throw new Error('AI가 코칭 내용을 만들지 못했어요.');
    return { tips, example };
  }

  const Coach = { check, introHints, aiReview };
  root.Coach = Coach;
  if (typeof module === 'object' && module.exports) module.exports = Coach;
})(typeof window !== 'undefined' ? window : globalThis);
