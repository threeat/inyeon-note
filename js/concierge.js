// AI 중매 상담: "주말에 같이 등산할 사람, 담배는 안 피웠으면" 같은 말을 매칭 조건 변경안으로 바꾼다.
// 새 점수 규칙을 만들지 않고, 이미 있는 장치(항목별 중요도, 거르기 조건, 나이·키 범위, 스타일, 내 관심사)만 고친다.
// 그래서 바뀐 순위도 리포트의 점수표와 거르기 단계로 그대로 설명된다.
// - 규칙: 키워드로 바로 해석 (AI 없이도 동작)
// - AI: LLM이 같은 형식의 변경안을 JSON으로 내고, 여기서 허용한 값만 남긴다
(function (root) {
  const Rules = root.Rules || (typeof require === 'function' ? require('./rules.js') : null);
  const LLM = root.LLM || (typeof require === 'function' ? require('./llm.js') : null);
  const { josa } = root.Hangul || (typeof require === 'function' ? require('./hangul.js') : null);
  const { OPTIONS, SCORE_RULES, FILTER_RULES, WEIGHT_LEVELS } = Rules;

  const LEVELS = WEIGHT_LEVELS.map((l) => l.value);
  const levelLabel = (v) => (WEIGHT_LEVELS.find((l) => l.value === v) || { label: `×${v}` }).label;
  const scoreLabel = (key) => (SCORE_RULES.find((r) => r.key === key) || {}).label;
  const filterRule = (key) => FILTER_RULES.find((f) => f.key === key && !f.always);
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  // 세부 취향 단어 → 관심사 ("재즈" → 음악)
  const DETAIL_TO_CATEGORY = {};
  Object.entries(OPTIONS.interestDetails).forEach(([c, list]) => list.forEach((d) => d.split('·').forEach((w) => { DETAIL_TO_CATEGORY[w] = c; })));
  const INTEREST_ALIASES = { 산: '등산', 트레킹: '등산', 헬스: '운동', 러닝: '운동', 테니스: '운동', 필라테스: '운동', 맛집: '요리', 책: '독서', 강아지: '반려동물', 고양이: '반려동물', 미술관: '전시회', 전시: '전시회', 캠핑: '여행', 노래: '음악', 공연: '음악', 커피: '카페' };

  // 변경 하나: { kind: 'weight' | 'filter' | 'age' | 'height' | 'styles' | 'interest', ..., why }
  function describe(c) {
    if (c.kind === 'weight') return `${scoreLabel(c.key)} 중요도 → '${levelLabel(c.value)}'`;
    if (c.kind === 'filter') return `${c.value ? '켬' : '끔'}: ${filterRule(c.key).toggle}`;
    if (c.kind === 'age') return `희망 나이 ${c.min}~${c.max}세`;
    if (c.kind === 'height') return `희망 키 ${c.min}~${c.max}cm`;
    if (c.kind === 'styles') return `끌리는 스타일에 추가: ${c.add.join(', ')}`;
    if (c.kind === 'interest') return `내 관심사에 추가: ${c.value}`;
    return '';
  }

  // ---------- 규칙 해석 ----------
  function ruleParse(text, me, prefs) {
    const t = String(text || '');
    const out = [];
    const weight = (key, value, why) => out.push({ kind: 'weight', key, value, why });
    const targetMale = (me.orientation === '양성애자' ? OPTIONS.genders : [OPTIONS.genders.find((g) => (me.orientation === '동성애자' ? g === me.gender : g !== me.gender))]).includes('남성');

    // 관심사: 말한 관심사가 내 관심사에 있으면 관심사 비중을 올리고, 없으면 내 관심사에 추가하자고 한다
    const words = new Set();
    OPTIONS.interests.forEach((c) => { if (t.includes(c)) words.add(c); });
    Object.entries({ ...DETAIL_TO_CATEGORY, ...INTEREST_ALIASES }).forEach(([w, c]) => { if (w.length > 1 && t.includes(w)) words.add(c); });
    const mine = [...words].filter((c) => me.interests.includes(c));
    const missing = [...words].filter((c) => !me.interests.includes(c));
    if (mine.length) weight('interests', 2, `${josa(mine.join(', '), '을/를')} 함께할 분을 찾으셔서, 공통 관심사 비중을 높여요.`);
    missing.forEach((c) => out.push({ kind: 'interest', value: c, why: `${josa(c, '은/는')} 아직 내 관심사에 없어 점수에 반영되지 않아요. 내 관심사에 넣으면 ${josa(c, '을/를')} 좋아하는 분과 점수가 올라가요.` }));

    // 나이
    const decade = t.match(/([2-5])0대\s*(초반|중반|후반)?/);
    const younger = /연하/.test(t);
    const older = /연상/.test(t);
    if (decade) {
      const base = Number(decade[1]) * 10;
      const [lo, hi] = { 초반: [0, 3], 중반: [3, 6], 후반: [6, 9] }[decade[2]] || [0, 9];
      out.push({ kind: 'age', min: base + lo, max: base + hi, why: `${decade[0]}이라고 하셔서 희망 나이를 맞춰요.` });
    } else if (/동갑|또래|비슷한\s*나이/.test(t)) {
      out.push({ kind: 'age', min: me.age - 2, max: me.age + 2, why: '나이가 비슷한 분을 원하셔서 앞뒤 2살로 좁혀요.' });
      weight('age', 3, '나이 차 점수도 크게 봐요.');
    } else if (younger || older) {
      out.push(younger
        ? { kind: 'age', min: Math.max(19, me.age - 6), max: me.age, why: '연하를 원하셔서 나보다 어리거나 같은 나이로 좁혀요.' }
        : { kind: 'age', min: me.age, max: me.age + 6, why: '연상을 원하셔서 나보다 많거나 같은 나이로 좁혀요.' });
    }

    // 키
    const tall = t.match(/키\s*(?:가)?\s*(\d{3})\s*(?:cm)?\s*이상/);
    if (tall) out.push({ kind: 'height', min: Number(tall[1]), max: Math.max(prefs.heightMax, Number(tall[1]) + 10), why: `키 ${tall[1]}cm 이상을 원하셔서 범위를 바꿔요.` });
    else if (/키\s*(?:가)?\s*(큰|크신|큰\s*편)/.test(t)) {
      const min = targetMale ? 178 : 165;
      out.push({ kind: 'height', min, max: Math.max(prefs.heightMax, min + 15), why: `키가 큰 분을 원하셔서 ${min}cm 이상으로 바꿔요.` });
    }

    // 흡연·음주
    if (/비흡연|담배\s*(?:는|를)?\s*(?:안|않|싫|x)|흡연\s*(?:은|자)?\s*(?:싫|x|안)/i.test(t)) out.push({ kind: 'filter', key: 'smoking', value: true, why: '담배를 피우는 분은 빼 달라고 하셔서 흡연자 제외를 켜요.' });
    if (/술\s*(?:은|을|도)?\s*(?:안|못|별로|싫|x)|금주|술\s*안\s*마시/i.test(t)) weight('lifestyle', 2, '술 이야기를 하셔서 음주·흡연 습관이 같은지를 더 크게 봐요.');
    else if (/술\s*(?:을|도)?\s*(?:좋아|자주|한잔|즐기)|술친구/.test(t)) weight('lifestyle', 2, '술을 같이 즐길 분을 원하셔서 음주 습관이 같은지를 더 크게 봐요.');

    // 종교
    if (/종교\s*(?:는|가)?\s*(?:상관\s*없|무관|안\s*봐)/.test(t)) weight('religion', 0, '종교는 상관없다고 하셔서 점수에서 빼요.');
    else if (/같은\s*종교|종교\s*(?:가|는)?\s*같|신앙/.test(t)) weight('religion', 3, '종교가 같은 분을 원하셔서 종교 점수를 가장 크게 봐요.');

    // 거리
    if (/거리\s*(?:는)?\s*(?:상관\s*없|무관)|장거리\s*(?:도|괜찮|상관)/.test(t)) weight('region', 0, '거리는 상관없다고 하셔서 점수에서 빼요.');
    else if (/가까(?:이|운)|동네|근처|같은\s*지역|자주\s*만날/.test(t)) weight('region', 3, '가까이 사는 분을 원하셔서 거리 점수를 가장 크게 봐요.');

    // 결혼관
    if (/가볍게|부담\s*없/.test(t)) weight('marriage', 0.5, '가볍게 만나고 싶다고 하셔서 결혼관 비중을 낮춰요.');
    else if (/결혼|진지|오래\s*만날|미래/.test(t)) weight('marriage', 2, '진지한 만남을 원하셔서 결혼 계획이 맞는지를 더 크게 봐요.');

    // 대화·가치관 → 자기소개 임베딩
    if (/대화|말이\s*(?:잘\s*)?통|잘\s*통하|가치관|결이|생각이\s*깊|성격/.test(t)) weight('intro', 2, '대화와 가치관을 말씀하셔서, 자기소개가 닮은 분에게 점수를 더 줘요.');

    // 외모·스타일
    if (/외모\s*(?:는)?\s*(?:상관\s*없|안\s*봐|중요하지\s*않)/.test(t)) weight('looks', 0, '외모는 상관없다고 하셔서 점수에서 빼요.');
    const styles = OPTIONS.styles.filter((s) => t.includes(s.replace(/한$|운$|인$/, '')) && !prefs.styles.includes(s));
    if (styles.length) {
      out.push({ kind: 'styles', add: styles, why: `${styles.join(', ')} 분위기를 말씀하셔서 끌리는 스타일에 넣어요.` });
      weight('looks', 2, '스타일을 말씀하셔서 외모 항목을 조금 더 봐요.');
    }

    return tidy(out, me, prefs);
  }

  // 같은 대상에 대한 변경은 마지막 것만 남기고, 이미 그 값이면 뺀다
  function tidy(changes, me, prefs) {
    const keyOf = (c) => (c.kind === 'weight' || c.kind === 'filter' ? `${c.kind}:${c.key}` : c.kind === 'interest' ? `interest:${c.value}` : c.kind);
    const last = new Map();
    changes.forEach((c) => last.set(keyOf(c), c));
    const current = (k) => (prefs.weights && typeof prefs.weights[k] === 'number' ? prefs.weights[k] : 1);
    return [...last.values()].filter((c) => {
      if (c.kind === 'weight') return current(c.key) !== c.value;
      if (c.kind === 'filter') return Boolean(prefs.filters[c.key]) !== c.value;
      if (c.kind === 'age') return c.min !== prefs.ageMin || c.max !== prefs.ageMax;
      if (c.kind === 'height') return c.min !== prefs.heightMin || c.max !== prefs.heightMax;
      if (c.kind === 'interest') return !me.interests.includes(c.value);
      return true;
    });
  }

  // ---------- AI 해석 ----------
  function aiPrompt(me, prefs) {
    return [
      '당신은 소개팅 앱 "인연노트"의 중매 상담사입니다. 사용자가 원하는 상대를 말로 설명하면, 아래 장치만으로 매칭 조건 변경안을 만듭니다.',
      '',
      `[항목별 중요도] 키: ${SCORE_RULES.map((r) => `${r.key}(${r.label})`).join(', ')}. 값: 0(안 봄), 0.5(조금), 1(보통), 2(중요), 3(매우 중요).`,
      `[거르기 조건] 키: ${FILTER_RULES.filter((f) => !f.always).map((f) => `${f.key}(${f.toggle})`).join(', ')}. 값: true/false.`,
      `[나이 범위] 19~60, [키 범위] 140~210cm, [스타일] ${OPTIONS.styles.join(', ')}, [관심사] ${OPTIONS.interests.join(', ')}`,
      '',
      `[현재 사용자] ${me.age}세 ${me.gender}, ${me.region}, 관심사 ${me.interests.join(', ')}`,
      `[현재 조건] 희망 나이 ${prefs.ageMin}~${prefs.ageMax}세, 희망 키 ${prefs.heightMin}~${prefs.heightMax}cm, 스타일 ${prefs.styles.join(', ') || '없음'}`,
      '',
      '[규칙]',
      '- 사용자가 실제로 말한 것만 바꾸세요. 짐작으로 조건을 늘리지 마세요.',
      '- 사용자 관심사에 없는 취미를 원하면 kind "interest"로 내 관심사에 추가하자고 제안하세요.',
      '- why는 사용자에게 보여 줄 한 문장 존댓말 설명입니다.',
      '- 반드시 JSON 한 덩어리로만 답하세요:',
      '{"changes": [{"kind": "weight", "key": "region", "value": 3, "why": "…"}, {"kind": "filter", "key": "smoking", "value": true, "why": "…"},',
      ' {"kind": "age", "min": 26, "max": 30, "why": "…"}, {"kind": "height", "min": 170, "max": 185, "why": "…"}, {"kind": "styles", "add": ["지적인"], "why": "…"}, {"kind": "interest", "value": "독서", "why": "…"}]}',
    ].join('\n');
  }

  // LLM이 낸 변경안에서 허용한 키와 범위 안의 값만 남긴다
  function sanitize(raw, me, prefs) {
    const list = raw && Array.isArray(raw.changes) ? raw.changes : [];
    const why = (c) => (typeof c.why === 'string' && c.why.trim() ? c.why.trim().slice(0, 120) : '말씀하신 내용에 맞춰 바꿔요.');
    const out = [];
    list.forEach((c) => {
      if (!c || typeof c !== 'object') return;
      if (c.kind === 'weight' && SCORE_RULES.some((r) => r.key === c.key) && LEVELS.includes(Number(c.value))) out.push({ kind: 'weight', key: c.key, value: Number(c.value), why: why(c) });
      else if (c.kind === 'filter' && filterRule(c.key) && typeof c.value === 'boolean') out.push({ kind: 'filter', key: c.key, value: c.value, why: why(c) });
      else if ((c.kind === 'age' || c.kind === 'height') && Number.isFinite(Number(c.min)) && Number.isFinite(Number(c.max))) {
        const [lo, hi] = c.kind === 'age' ? [19, 60] : [140, 210];
        const min = clamp(Math.round(Number(c.min)), lo, hi);
        const max = clamp(Math.round(Number(c.max)), lo, hi);
        out.push({ kind: c.kind, min: Math.min(min, max), max: Math.max(min, max), why: why(c) });
      } else if (c.kind === 'styles' && Array.isArray(c.add)) {
        const add = c.add.filter((s) => OPTIONS.styles.includes(s) && !prefs.styles.includes(s));
        if (add.length) out.push({ kind: 'styles', add, why: why(c) });
      } else if (c.kind === 'interest' && OPTIONS.interests.includes(c.value)) out.push({ kind: 'interest', value: c.value, why: why(c) });
    });
    return tidy(out, me, prefs);
  }

  async function aiParse(ai, text, me, prefs) {
    const res = await LLM.complete(ai, { system: aiPrompt(me, prefs), messages: [{ role: 'user', content: String(text).slice(0, 500) }], maxTokens: 800, json: true });
    return sanitize(LLM.parseJson(res.text), me, prefs);
  }

  // 상담: AI가 켜져 있으면 AI, 실패하거나 아무것도 못 찾으면 규칙. { changes, by: 'ai' | 'rule', error? }
  async function plan(text, me, prefs, ai) {
    if (LLM.ready(ai)) {
      try {
        const changes = await aiParse(ai, text, me, prefs);
        if (changes.length) return { changes, by: 'ai' };
      } catch (e) {
        return { changes: ruleParse(text, me, prefs), by: 'rule', error: e.message };
      }
    }
    return { changes: ruleParse(text, me, prefs), by: 'rule' };
  }

  // 변경안을 적용한 새 me, prefs (원본은 그대로)
  function apply(me, prefs, changes) {
    const nextMe = { ...me, interests: me.interests.slice() };
    const next = { ...prefs, styles: prefs.styles.slice(), filters: { ...prefs.filters }, weights: { ...(prefs.weights || {}) } };
    changes.forEach((c) => {
      if (c.kind === 'weight') next.weights[c.key] = c.value;
      if (c.kind === 'filter') next.filters[c.key] = c.value;
      if (c.kind === 'age') Object.assign(next, { ageMin: c.min, ageMax: c.max });
      if (c.kind === 'height') Object.assign(next, { heightMin: c.min, heightMax: c.max });
      if (c.kind === 'styles') next.styles = [...new Set([...next.styles, ...c.add])];
      if (c.kind === 'interest' && !nextMe.interests.includes(c.value)) nextMe.interests.push(c.value);
    });
    return { me: nextMe, prefs: next };
  }

  const EXAMPLES = ['주말에 같이 등산할 사람, 담배는 안 피웠으면 좋겠어요', '가까이 살고 대화가 잘 통하는 분', '결혼 생각이 있는 30대 초반', '종교는 상관없고 술 안 마시는 사람'];

  const Concierge = { plan, ruleParse, aiParse, sanitize, apply, describe, EXAMPLES };
  root.Concierge = Concierge;
  if (typeof module === 'object' && module.exports) module.exports = Concierge;
})(typeof window !== 'undefined' ? window : globalThis);
