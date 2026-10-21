// 대화 시작 도우미: 매칭 직후 첫 메시지를 못 보내 끝나는 대화를 줄이려고, 두 사람 프로필로 말 걸 문장을 추천한다.
// - 규칙: 공통 관심사·세부 취향·지역으로 바로 만든다 (AI 없이도 늘 나온다).
// - AI: 자기소개까지 읽고 더 자연스러운 문장 3개를 만든다. 실패하면 규칙 결과를 쓴다.
(function (root) {
  const LLM = root.LLM || (typeof require === 'function' ? require('./llm.js') : null);

  const detailsOf = (person, c) => (person.interestDetails && person.interestDetails[c]) || [];
  const shared = (me, p) => p.interests.filter((i) => me.interests.includes(i));

  // 관심사마다 이어 갈 질문
  const ASK = {
    등산: '최근에 다녀온 산 중에 제일 좋았던 데가 어디예요?',
    요리: '요즘 자주 해 드시는 요리 있어요?',
    영화: '최근에 본 영화 중에 추천해 주실 만한 거 있어요?',
    독서: '요즘 읽고 계신 책이 궁금해요!',
    게임: '요즘 빠져 있는 게임 있어요?',
    여행: '지금까지 간 여행지 중에 어디가 제일 좋았어요?',
    카페: '아끼는 단골 카페 있으세요?',
    운동: '운동은 주로 언제 하세요? 저는 꾸준히 하는 게 제일 어렵더라고요.',
    음악: '요즘 제일 많이 듣는 노래가 뭐예요?',
    사진: '최근에 찍은 사진 중에 마음에 드는 거 있어요?',
    반려동물: '같이 사는 아이 이름이 궁금해요!',
    전시회: '최근에 본 전시 중에 기억에 남는 거 있어요?',
  };

  // 규칙으로 만든 첫 메시지 후보 (최대 3개)
  function suggest(me, p) {
    const out = [];
    const sh = shared(me, p);
    sh.forEach((c) => {
      const same = detailsOf(p, c).find((d) => detailsOf(me, c).includes(d));
      if (same) out.push(`안녕하세요! ${c} 중에서도 ${same} 좋아하시는 거 저랑 똑같아서 반가웠어요. ${ASK[c] || ''}`.trim());
    });
    sh.forEach((c) => out.push(`안녕하세요! 저도 ${c} 좋아해요. ${ASK[c] || ''}`.trim()));
    const theirs = p.interests.find((c) => !me.interests.includes(c));
    if (theirs) out.push(`프로필 보니 ${theirs} 좋아하시던데, 어떻게 시작하게 되셨어요? 저도 궁금해요.`);
    if (me.region && me.region === p.region) out.push(`같은 ${p.region}이시네요! 자주 가는 동네 있어요?`);
    out.push('안녕하세요! 자기소개 보고 이야기 나눠 보고 싶었어요. 쉬는 날엔 주로 뭐 하세요?');
    return [...new Set(out)].slice(0, 3);
  }

  const withDetails = (person) => person.interests.map((c) => (detailsOf(person, c).length ? `${c}(${detailsOf(person, c).join('·')})` : c)).join(', ');

  function prompt(me, p) {
    return [
      '당신은 소개팅 앱 "인연노트"의 대화 시작 도우미입니다. 방금 매칭된 두 사람 중 [나]가 [상대]에게 보낼 첫 메시지를 추천합니다.',
      '',
      `[나] ${me.name}, ${me.age}세, ${me.region}, 관심사 ${withDetails(me)}${me.intro ? `, 자기소개 "${me.intro}"` : ''}`,
      `[상대] ${p.name}, ${p.age}세, ${p.region}, 관심사 ${withDetails(p)}${p.intro ? `, 자기소개 "${p.intro}"` : ''}`,
      '',
      '[규칙]',
      `- [나]가 ${p.name}님에게 그대로 보낼 메시지 본문만 쓰세요. 설명이나 조언("~물어보면 좋겠어요")은 쓰지 마세요.`,
      '- 서로 다른 소재로 3개. 각각 존댓말 1~2문장이고, 상대가 쉽게 답할 수 있는 물음표 질문으로 끝내세요.',
      '- 상대 자기소개나 공통 관심사에서 구체적인 소재를 하나씩 집어 주세요.',
      '- 외모 평가, 연락처·사는 곳·직장 위치 질문, 만남 약속, 과한 칭찬은 넣지 마세요.',
      '- 반드시 JSON 한 덩어리로만 답하세요.',
      '',
      '[예시 형식]',
      '{"messages": ["안녕하세요! 저도 캠핑 좋아해요. 최근에 다녀온 캠핑장 중에 추천해 주실 곳 있어요?", "재즈 좋아하신다고 해서 반가웠어요. 요즘 자주 듣는 앨범이 뭐예요?", "주말마다 빵을 구우신다니 멋져요. 제일 자신 있는 메뉴가 뭐예요?"]}',
    ].join('\n');
  }

  // AI로 만든 첫 메시지 후보. 결과가 이상하면 오류를 던진다 (부르는 쪽에서 규칙 결과로 대신한다).
  async function aiSuggest(ai, me, p) {
    const res = await LLM.complete(ai, { system: prompt(me, p), messages: [{ role: 'user', content: '첫 메시지 3개를 추천해 주세요.' }], maxTokens: 600, json: true });
    const out = LLM.parseJson(res.text);
    const list = out && Array.isArray(out.messages) ? out.messages.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim()) : [];
    if (!list.length) throw new Error('AI가 추천 문장을 만들지 못했어요.');
    return list.slice(0, 3);
  }

  const Starters = { suggest, aiSuggest, prompt };
  root.Starters = Starters;
  if (typeof module === 'object' && module.exports) module.exports = Starters;
})(typeof window !== 'undefined' ? window : globalThis);
