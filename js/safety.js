// 채팅 안전 검사. 소개팅 앱에서 가장 흔한 피해(연락처 유도, 송금·투자 사기, 외부 링크, 성희롱·욕설)를 막는다.
// 1단계 규칙: 즉시, 무료, 오프라인. 보내는 메시지와 받은 메시지 모두에 쓴다.
// 2단계 AI: 규칙으로 못 잡는 돌려 말하기를 LLM이 판단한다. 받은 메시지에만, AI 설정이 켜져 있을 때 쓴다.
(function (root) {
  const LLM = root.LLM || (typeof require === 'function' ? require('./llm.js') : null);

  // mine: 내가 보내려 할 때 안내, theirs: 상대가 보냈을 때 경고
  const RULES = [
    {
      key: 'contact', label: '연락처 공유',
      // 메신저 이름만으로는 잡지 않는다 ("카톡 프사 바꿨어요"). 아이디·추가·"~로 얘기해요"처럼 넘기거나 옮기는 말이 붙어야 한다.
      re: /01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}|오픈\s?채팅|(?<![가-힣])(카톡|카카오톡|텔레그램|텔레|위챗|라인|인스타|디스코드)\s?(아이디|id|주소|친추|추가|디엠|dm|으로|로\s?(얘기|연락|와|옮|넘어|하자|해요|할래))/i,
      mine: '연락처나 외부 메신저는 서로 충분히 알게 된 뒤에 알려 주세요. 앱 밖에서는 신고와 차단이 어려워요.',
      theirs: '상대가 연락처나 외부 메신저 이야기를 꺼냈어요. 앱 밖으로 대화를 옮기자는 건 사기에서 자주 쓰는 수법이에요.',
    },
    {
      key: 'money', label: '돈·투자',
      re: /계좌|송금|입금|이체|돈\s?(좀\s?)?(빌려|보내)|빌려\s?줄|급전|대출|코인|리딩방|수익률|투자\s?(해|하|방|권)|재테크\s?방/,
      mine: '만나기 전에 돈 이야기는 오해를 살 수 있어요.',
      theirs: '돈·송금·투자 이야기가 나왔어요. 만난 적 없는 사람에게 절대 돈을 보내지 마세요. 로맨스 스캠일 수 있어요.',
    },
    {
      key: 'link', label: '외부 링크',
      re: /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|kr|net|ly|me|io)\b/i,
      mine: '링크는 상대가 경계할 수 있어요.',
      theirs: '외부 링크가 왔어요. 모르는 사이트에 로그인하거나 앱을 설치하지 마세요.',
    },
    {
      key: 'idnum', label: '개인 식별 정보',
      re: /\d{6}\s?-\s?[1-4]\d{6}/,
      mine: '주민등록번호 같은 개인 식별 정보는 보내지 마세요.',
      theirs: '주민등록번호 같은 개인 식별 정보가 담겨 있어요. 함부로 저장하거나 전달하지 마세요.',
    },
    {
      key: 'sexual', label: '성적인 표현',
      re: /섹스|야한\s?(사진|얘기)|몸매\s?사진|벗은|원나잇|조건\s?만남|스폰/,
      mine: '첫 대화에서 성적인 표현은 상대를 불쾌하게 하고 신고될 수 있어요.',
      theirs: '성적인 표현이 담긴 메시지예요. 불쾌하다면 대화를 멈추고 신고해 주세요.',
    },
    {
      key: 'abuse', label: '욕설',
      re: /씨발|시발|ㅅㅂ|병신|ㅂㅅ|좆|꺼져|미친\s?(년|놈)/,
      mine: '욕설이 들어 있어요. 상대가 불쾌할 수 있어요.',
      theirs: '욕설이 담긴 메시지예요. 불쾌하다면 대화를 멈추고 신고해 주세요.',
    },
  ];
  const byKey = Object.fromEntries(RULES.map((r) => [r.key, r]));

  // 걸린 규칙 목록: [{ key, label, mine, theirs }]
  const check = (text) => RULES.filter((r) => r.re.test(String(text || ''))).map(({ re, ...rest }) => rest);

  // ---------- 2단계: AI 판단 ----------
  const REVIEW_PROMPT = [
    '당신은 한국 소개팅 앱의 채팅 안전 검사기입니다. 상대가 보낸 메시지 하나를 보고, 받는 사람에게 경고가 필요한지 판단합니다.',
    '경고 대상: contact(앱 밖 연락처·메신저로 옮기자는 유도), money(송금·투자·대출·선물 요구 등 금전), sexual(성적인 표현·사진 요구),',
    'abuse(욕설·모욕·위협), personal(주소·직장 위치 등 과한 개인정보 요구).',
    '평범한 인사, 취미 이야기, 가벼운 농담, 앱 안에서 만남을 제안하는 것은 경고 대상이 아닙니다. 애매하면 경고하지 마세요.',
    '반드시 JSON 한 덩어리로만 답하세요: {"flag": true 또는 false, "category": "contact|money|sexual|abuse|personal|none", "reason": "받는 사람에게 보여 줄 한 문장"}',
  ].join('\n');
  const AI_LABEL = { personal: '과한 개인정보 요구' };

  // 경고가 필요하면 { key, label, theirs }, 아니면 null. 실패하면 오류를 던진다 (부르는 쪽에서 조용히 넘긴다).
  async function aiReview(ai, text) {
    const res = await LLM.complete(ai, { system: REVIEW_PROMPT, messages: [{ role: 'user', content: `메시지: """${text}"""` }], maxTokens: 300, json: true });
    const out = LLM.parseJson(res.text);
    if (!out || out.flag !== true || !out.category || out.category === 'none') return null;
    const rule = byKey[out.category];
    return { key: out.category, label: rule ? rule.label : AI_LABEL[out.category] || '주의', theirs: out.reason || (rule && rule.theirs) || '조심해야 할 메시지예요.' };
  }

  // 받은 메시지 검사: 규칙에 걸리면 규칙 결과, 아니면 AI 판단 (AI가 꺼져 있거나 실패하면 빈 목록)
  async function review(text, ai) {
    const hits = check(text);
    if (hits.length || !LLM.ready(ai)) return hits;
    try {
      const hit = await aiReview(ai, text);
      return hit ? [{ ...hit, byAi: true }] : [];
    } catch (e) {
      return [];
    }
  }

  const Safety = { check, review, aiReview, RULES };
  root.Safety = Safety;
  if (typeof module === 'object' && module.exports) module.exports = Safety;
})(typeof window !== 'undefined' ? window : globalThis);
