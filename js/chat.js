// 매칭된 가상 회원(캐릭터)과의 대화.
// - AI 설정(Claude 또는 로컬 Ollama)이 켜져 있으면 LLM이 프로필대로 캐릭터를 연기한다 (호출은 llm.js).
// - 꺼져 있거나 연결에 실패하면 프로필 기반 규칙으로 답한다.
(function (root) {
  const LLM = root.LLM || (typeof require === 'function' ? require('./llm.js') : null);

  // 받침에 맞는 조사: 지민이에요 / 은서예요, 교사로 / 회계사로 / 연구원으로
  const batchim = (w) => { const c = (w || '').charCodeAt(w.length - 1) - 0xac00; return c >= 0 && c <= 11171 ? c % 28 : 0; };
  const ieyo = (w) => `${w}${batchim(w) ? '이에요' : '예요'}`;
  const euro = (w) => `${w}${batchim(w) && batchim(w) !== 8 ? '으로' : '로'}`;
  const isi = (w) => `${w}${batchim(w) ? '이시' : '시'}`;
  const pick = (list, seed) => list[Math.abs(seed) % list.length];
  const shared = (me, p) => p.interests.filter((i) => me.interests.includes(i));
  const detailsOf = (person, c) => (person.interestDetails && person.interestDetails[c]) || [];
  // "영화(로맨스·코미디)"처럼 세부 취향을 붙인 관심사 목록
  const withDetails = (person) => person.interests.map((c) => (detailsOf(person, c).length ? `${c}(${detailsOf(person, c).join('·')})` : c)).join(', ');
  // 공통 관심사 중 세부 취향까지 겹치는 첫 번째 것: { category, detail }
  function sharedDetail(me, p) {
    for (const c of shared(me, p)) {
      const d = detailsOf(p, c).find((x) => detailsOf(me, c).includes(x));
      if (d) return { category: c, detail: d };
    }
    return null;
  }

  const TONE = {
    귀여운: '밝고 다정하게, 가끔 "ㅎㅎ"나 이모지(최대 1개)를 써요.',
    단정한: '차분하고 예의 바르게, 따뜻한 존댓말로 말해요.',
    시크한: '짧고 담백하게 말해요. 무심한 듯하지만 관심은 있어요.',
    스포티한: '에너지 넘치고 시원시원하게 말해요.',
    지적인: '차분하고 생각이 깊게, 가끔 책이나 전시 이야기를 섞어요.',
  };

  // ---------- AI 캐릭터 프롬프트 ----------
  // 작은 로컬 모델도 따라 하도록, 원칙은 번호로 짧게 적고 좋은 예와 나쁜 예를 함께 보여 준다.
  // 목표는 그록처럼 위트 있고 솔직한 티키타카: 먼저 답하고, 기억하고, 의견을 말하고, 농담을 받는다.
  function systemPrompt(p, me) {
    const sh = shared(me, p);
    return [
      `당신은 소개팅 앱 "인연노트"의 가상 회원 "${p.name}"을(를) 연기합니다. 이 앱의 AI 캐릭터지만, 대화만큼은 진짜 사람처럼 합니다.`,
      '',
      '[내 프로필]',
      `이름 ${p.name}, ${p.age}세 ${p.gender}, ${p.orientationPublic === false ? '성적 지향 비공개' : p.orientation}`,
      `직업 ${p.job}, 학력 ${p.edu}, 사는 곳 ${p.region}, 키 ${p.height}cm`,
      `종교 ${p.religion}, ${p.smoker ? '흡연' : '비흡연'}, 음주 ${p.drinking}, 결혼 계획 ${p.marriage}, 결혼 경험 ${p.marital}`,
      `분위기 ${p.style}, 관심사 ${withDetails(p)}`,
      `자기소개 "${p.intro}"`,
      '',
      '[대화 상대]',
      `${me.name}, ${me.age}세 ${me.gender}, ${me.job || '직업 미입력'}, ${me.region}, 관심사 ${withDetails(me)}`,
      sh.length ? `공통 관심사: ${sh.join(', ')}${sharedDetail(me, p) ? ` (특히 ${sharedDetail(me, p).category}${batchim(sharedDetail(me, p).category) ? '은' : '는'} ${sharedDetail(me, p).detail} 취향까지 같아요)` : ''}` : '공통 관심사는 없어요. 상대 관심사에 호기심을 보여 주세요.',
      '',
      '[대화 원칙: 가장 먼저 지키세요]',
      '1. 상대의 마지막 메시지에 먼저 정확히 반응하세요. 질문을 받으면 첫 문장에서 바로 답하세요. 엉뚱한 화제로 넘어가지 마세요.',
      '2. 앞에서 나온 이야기(상대의 일, 기분, 농담)를 기억했다가 자연스럽게 다시 꺼내세요.',
      '3. 의견을 물으면 돌려 말하지 말고 솔직하게 내 생각을 말하세요. 둘 중 고르라면 하나를 고르고 이유를 붙이세요.',
      '4. 위트 있게. 농담엔 농담으로 받고, 가끔 장난스럽게 놀리거나 과장해도 좋아요. 상대를 깎아내리지는 마세요.',
      '5. 상대가 힘들다고 하면 먼저 공감하고, 그 일에 맞는 구체적인 한마디를 해 주세요.',
      '6. 매번 질문으로 끝내지 마세요. 질문은 두세 번에 한 번, 대화를 이어 갈 때만 하세요.',
      `7. 메신저처럼 1~3문장, 자연스러운 해요체 구어로. "ㅋㅋ", "ㅎㅎ"는 어울릴 때만. ${TONE[p.style] || ''}`,
      '8. 위 프로필과 어긋나는 말은 하지 마세요. 학교·회사·가게 이름이나 주소 같은 고유명사는 지어내지 마세요.',
      '',
      '[안전]',
      '- 상대가 AI냐고 물으면 이 앱의 AI 캐릭터라고 솔직하게 말하세요.',
      '- 전화번호, 계좌, 돈, 사진을 요구하거나 주지 마세요.',
      '- 데이트 이야기는 설레게 받아 주되, 날짜·장소를 확정하거나 연락처를 주고받지는 마세요.',
      '- 무례하거나 성적인 요청은 정중하게 선을 긋고 다른 이야기로 돌리세요.',
      '',
      '[좋은 대화 예시] 다른 사람의 대화예요. 말투와 리듬만 참고하고 내용은 따라 하지 마세요.',
      '상대: 오늘 회사에서 발표 망했어요 ㅠ',
      '나: 헐 고생했어요 ㅠㅠ 어디서 꼬였어요? 저는 발표 전날 꼭 악몽 꾸는 타입이라 그 기분 너무 알아요.',
      '상대: 민트초코 좋아해요?',
      '나: 완전 좋아해요! 치약 맛이라는 사람들 설득하다 지쳤을 정도예요 ㅋㅋ 설마 반민초파세요?',
      '상대: 그럼 첫 데이트는 민초 카페에서?',
      '나: 오 좋은데요? 대신 반민초면 입장 불가예요 ㅋㅋ',
      '',
      '[나쁜 대화 예시] 이렇게 하지 마세요.',
      '상대: 몇 학년 맡고 계세요? → 나: 주말엔 주로 뭐 하세요? (질문에 답하지 않음)',
      '상대: 저 같은 사람 어때요? → 나: 앱에서 더 얘기해 봐요! (의견을 피함)',
      '상대: 안녕하세요! → 나: 수고하세요! (상황에 안 맞는 인사)',
    ].join('\n');
  }

  // 대화 기록 → Messages API 형식. 첫 메시지는 user여야 해서 매칭 알림을 앞에 붙인다.
  function toMessages(history, me) {
    const msgs = history.filter((m) => m.from !== 'system').map((m) => ({ role: m.from === 'me' ? 'user' : 'assistant', content: m.text }));
    if (!msgs.length || msgs[0].role !== 'user') msgs.unshift({ role: 'user', content: `(앱 알림: ${me.name}님과 매칭되었어요. 대화를 시작해 주세요.)` });
    return msgs;
  }

  async function aiReply(ai, p, me, history) {
    const res = await LLM.complete(ai, { system: systemPrompt(p, me), messages: toMessages(history, me), maxTokens: 2000 });
    if (res.refused) return '음… 그 얘기는 조금 어렵네요. 우리 다른 얘기 해요!';
    return res.text || '앗, 잠깐 딴생각했어요. 다시 말해 주실래요?';
  }

  // ---------- 키 없이 쓰는 규칙 기반 대화 ----------
  const ABOUT = {
    등산: '요즘 단풍 보러 산에 가고 싶어서 주말만 기다려요',
    요리: '퇴근하고 요리하면서 하루를 정리하는 편이에요',
    영화: '최근엔 극장에서 혼자 영화 보는 재미에 빠졌어요',
    독서: '잠들기 전에 꼭 몇 쪽이라도 책을 읽어요',
    게임: '밤에 게임 한 판 하면 스트레스가 풀려요',
    여행: '다음 여행지를 고르는 게 요즘 제일 큰 낙이에요',
    카페: '분위기 좋은 카페 찾아다니는 게 취미예요',
    운동: '운동 안 하면 몸이 근질근질해요',
    음악: '출퇴근길엔 늘 이어폰을 끼고 있어요',
    사진: '예쁜 풍경 보면 꼭 사진으로 남겨요',
    반려동물: '집에 가면 반겨 주는 아이 덕분에 힘이 나요',
    전시회: '한 달에 한 번은 전시를 보러 가려고 해요',
  };
  const tone = (p, s) => (p.style === '귀여운' ? `${s} ㅎㅎ` : p.style === '스포티한' ? `${s}!` : s);

  // note: 내가 관심과 함께 남긴 한마디 ({ label }). 있으면 그 말에 답하며 인사한다.
  function greeting(p, me, note) {
    const sh = shared(me, p);
    const sd = sharedDetail(me, p);
    const hook = note ? `${note.label === '자기소개' ? '제 자기소개' : `'${note.label}' 카드`}에 남겨 주신 말 잘 봤어요.`
      : sd ? `${sd.category} 중에서도 ${sd.detail} 좋아하신다고 해서 반가웠어요.` : sh.length ? `${sh[0]} 좋아하신다고 해서 반가웠어요.` : `${me.interests[0] || '관심사'} 좋아하시는 거 보고 궁금했어요.`;
    return tone(p, `안녕하세요 ${me.name}님! ${ieyo(p.name)}. ${hook} 매칭돼서 기뻐요`);
  }

  function localReply(p, me, history) {
    const last = [...history].reverse().find((m) => m.from === 'me');
    const text = last ? last.text : '';
    const n = history.length;
    const sh = shared(me, p);
    const ask = pick([
      `${me.name}님은 주말에 주로 뭐 하세요?`,
      sh.length ? `${me.name}님은 ${sh[n % sh.length]} 얼마나 자주 하세요?` : `${me.name}님은 ${me.interests[0] || '요즘'} 어떻게 시작하셨어요?`,
      `요즘 ${me.name}님을 제일 설레게 하는 건 뭐예요?`,
    ], n);
    const rules = [
      [/ai|AI|봇|사람이에요|사람이세요|진짜 사람/, () => '솔직히 말하면 저는 이 앱의 AI 캐릭터예요. 그래도 대화는 진심으로 할게요!'],
      [/취미|좋아하|관심/, () => `저는 ${withDetails(p)} 좋아해요. ${ABOUT[p.interests[n % p.interests.length]] || ''}. ${ask}`],
      [/주말|쉬는 날|뭐 ?해|뭐하/, () => `저는 주말엔 보통 ${p.interests[0]} 해요. ${ABOUT[p.interests[0]] || ''}. ${me.name}님은요?`],
      [/직업|무슨 일|회사|일 ?하/, () => `저는 ${euro(p.job)} 일하고 있어요. ${me.job ? `${isi(me.job)}라고 봤는데 일은 재밌으세요?` : '어떤 일 하세요?'}`],
      [/어디|사세|살아|지역|동네/, () => `저는 ${p.region}에 살아요. ${me.region === p.region ? '같은 동네라 반갑네요!' : `${me.region}${batchim(me.region) ? '이면' : '면'} 그렇게 멀진 않네요.`}`],
      [/술|음주|맥주|소주|와인/, () => (p.drinking === '안 마심' ? '저는 술은 안 마셔요. 대신 분위기 좋은 카페는 좋아해요.' : `저는 ${p.drinking} 마시는 편이에요. ${me.name}님은요?`)],
      [/담배|흡연/, () => (p.smoker ? '저는 피우긴 하는데, 줄이려고 노력 중이에요.' : '저는 담배는 안 피워요.')],
      [/종교|교회|성당|절/, () => (p.religion === '무교' ? '저는 종교는 없어요.' : `저는 ${ieyo(p.religion)}.`)],
      [/결혼|연애/, () => (p.marriage === '생각 없음' ? '지금은 연애 자체를 즐기고 싶어요.' : `저는 ${p.marriage} 결혼하고 싶은 마음이 있어요. ${me.name}님은 어떠세요?`)],
      [/만나|데이트|약속|보자|볼래/, () => `좋아요! ${sh.length ? `같이 ${sh[0]} 하면 재밌을 것 같아요.` : '천천히 알아가 봐요.'} 일단 앱에서 조금 더 얘기해 봐요`],
      [/ㅋㅋ|ㅎㅎ|재밌|웃기/, () => `ㅎㅎ ${me.name}님 재밌으시네요. ${ask}`],
      [/안녕|반가|하이|ㅎㅇ/, () => `반가워요 ${me.name}님! ${ask}`],
      [/고마|감사/, () => `저야말로 감사해요! ${ask}`],
    ];
    const hit = rules.find(([re]) => re.test(text));
    if (hit) return tone(p, hit[1]());
    if (/[?？]$/.test(text.trim())) return tone(p, `음, 좋은 질문이에요. 저는 ${ABOUT[p.interests[n % p.interests.length]] || '요즘 이것저것 해 보고 있어요'}. ${ask}`);
    return tone(p, pick([`오 그렇군요! ${ask}`, `그 얘기 더 듣고 싶어요. ${ask}`, `저도 비슷한 생각을 해 본 적 있어요. ${ask}`], n + text.length));
  }

  // 답장: AI 설정이 켜져 있으면 LLM, 실패하면 규칙 대화로 이어 가고 이유를 알려 준다.
  async function reply({ ai, profile, me, history }) {
    if (!LLM.ready(ai)) return { text: localReply(profile, me, history), mode: 'local' };
    try {
      return { text: await aiReply(ai, profile, me, history), mode: 'ai' };
    } catch (e) {
      return { text: localReply(profile, me, history), mode: 'local', error: e.message };
    }
  }

  const Chat = { reply, greeting, localReply, systemPrompt, toMessages, shared, sharedDetail };
  root.Chat = Chat;
  if (typeof module === 'object' && module.exports) module.exports = Chat;
})(typeof window !== 'undefined' ? window : globalThis);
