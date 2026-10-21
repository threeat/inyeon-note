const test = require('node:test');
const assert = require('node:assert');
const PROFILES = require('../js/profiles.js');
const Prompts = require('../js/prompts.js');
const Matcher = require('../js/matcher.js');
const Concierge = require('../js/concierge.js');
const Coach = require('../js/coach.js');
const Dates = require('../js/dates.js');
const Feedback = require('../js/feedback.js');
const Chat = require('../js/chat.js');
const LLM = require('../js/llm.js');
const { josa } = require('../js/hangul.js');

const byId = (id) => PROFILES.find((p) => p.id === id);
const ME = { id: 'me', name: '준석', gender: '남성', orientation: '이성애자', age: 28, height: 178, region: '서울', religion: '무교', smoker: false, drinking: '가끔',
  style: '단정한', marriage: '1~2년 내', interests: ['등산', '요리', '영화'], interestDetails: { 등산: ['근교 산'], 요리: ['한식'], 영화: ['로맨스'] }, intro: '', prompts: [] };
const PREFS = { ageMin: 24, ageMax: 31, heightMin: 155, heightMax: 175, styles: ['귀여운', '단정한'], filters: { age: true, smoking: true, marriage: true } };
const OLLAMA = LLM.normalize({ provider: 'ollama', ollamaModel: 'llama3.1:8b' });
const fakeAnswer = (content) => { global.fetch = async () => ({ ok: true, json: async () => ({ message: { content } }) }); };
test.afterEach(() => { delete global.fetch; });

test('조사는 받침에 맞춘다', () => {
  assert.deepStrictEqual([josa('한식', '을/를'), josa('거리', '을/를'), josa('서울', '이라/라'), josa('부산', '과/와'), josa('대구', '이/가'), josa('서울', '으로/로')],
    ['한식을', '거리를', '서울이라', '부산과', '대구가', '서울로']);
});

// ---------- 질문 카드와 한마디 ----------
test('가상 회원 20명 모두 질문 카드 2장이 있고, 기존 자기소개는 그대로다', () => {
  PROFILES.forEach((p) => assert.strictEqual(Prompts.clean(p.prompts).length, 2, p.id));
  assert.match(byId('f13').intro, /^등산 끝나고 맛집 가는 게 행복이에요/);
});

test('질문 카드 정리: 모르는 질문·빈 답·중복 빼고 최대 2장, 80자', () => {
  const cards = Prompts.clean([{ q: 'weekend', a: '  산책 ' }, { q: 'weekend', a: '중복' }, { q: 'nope', a: 'x' }, { q: 'joy', a: '' }, { q: 'into', a: 'ㅋ'.repeat(100) }, { q: 'match', a: '넘침' }]);
  assert.deepStrictEqual(cards.map((c) => c.q), ['weekend', 'into']);
  assert.strictEqual(cards[0].a, '산책');
  assert.strictEqual(cards[1].a.length, 80);
  assert.deepStrictEqual(Prompts.targetsOf(byId('f13')).map((t) => t.target), ['q:weekend', 'q:joy', 'intro']);
});

test('한마디를 남기면 매칭 기준이 50점에서 45점으로 낮아지고 이유에 적힌다', () => {
  const scored = { total: 47, profile: { name: '은서' } };
  assert.strictEqual(Matcher.matchResult(scored).matched, false);
  const withNote = Matcher.matchResult(scored, { withNote: true });
  assert.strictEqual(withNote.matched, true);
  assert.strictEqual(withNote.threshold, 45);
  assert.match(withNote.reason, /47점 ≥ 45점.*한마디를 남겨 기준이 50점에서 45점으로/);
});

test('한마디로 매칭되면 상대가 그 한마디에 답하며 인사한다', () => {
  assert.match(Chat.greeting(byId('f13'), ME, { label: '완벽한 주말은' }), /'완벽한 주말은' 카드에 남겨 주신 말 잘 봤어요/);
  assert.match(Chat.greeting(byId('f13'), ME, { label: '자기소개' }), /제 자기소개에 남겨 주신 말/);
  assert.match(Chat.greeting(byId('f13'), ME), /요리 중에서도 한식/); // 한마디 없으면 예전과 같다
});

// ---------- AI 중매 상담 ----------
const describeAll = (text, prefs = PREFS) => Concierge.ruleParse(text, ME, prefs).map(Concierge.describe);

test('상담(규칙): 거리·대화·종교·술·결혼·외모를 중요도로 바꾼다', () => {
  assert.deepStrictEqual(describeAll('가까이 살고 대화가 잘 통하는 분'), ["거리 중요도 → '매우 중요'", "자기소개 중요도 → '중요'"]);
  assert.deepStrictEqual(describeAll('종교는 상관없고 술 안 마시는 사람'), ["생활습관 중요도 → '중요'", "종교 중요도 → '안 봄'"]);
  assert.deepStrictEqual(describeAll('결혼 생각 있는 진지한 분, 외모는 상관없어요'), ["결혼관 중요도 → '중요'", "외모 중요도 → '안 봄'"]);
});

test('상담(규칙): 나이·키·스타일·흡연을 범위와 거르기 조건으로 바꾼다', () => {
  assert.deepStrictEqual(describeAll('30대 초반'), ['희망 나이 30~33세']);
  assert.deepStrictEqual(describeAll('연하였으면'), ['희망 나이 22~28세']);
  assert.deepStrictEqual(describeAll('키 165 이상, 지적인 분'), ['희망 키 165~175cm', '끌리는 스타일에 추가: 지적인', "외모 중요도 → '중요'"]);
  assert.deepStrictEqual(describeAll('담배 안 피우는 사람', { ...PREFS, filters: {} }), ['켬: 흡연자 제외']);
  assert.deepStrictEqual(describeAll('담배 안 피우는 사람'), []); // 이미 켜져 있으면 바꿀 것이 없다
});

test('상담(규칙): 내 관심사에 없는 취미는 관심사 추가를 제안한다', () => {
  const changes = Concierge.ruleParse('재즈 좋아하고 같이 등산할 사람', ME, PREFS);
  assert.deepStrictEqual(changes.map(Concierge.describe), ["관심사 중요도 → '중요'", '내 관심사에 추가: 음악']);
  assert.match(changes[1].why, /음악은 아직 내 관심사에 없어/);
});

test('상담 적용: 원본은 그대로 두고 새 조건을 만든다, 순위가 실제로 바뀐다', () => {
  const changes = Concierge.ruleParse('가까이 사는 30대 초반', ME, PREFS);
  const next = Concierge.apply(ME, PREFS, changes);
  assert.strictEqual(PREFS.ageMin, 24);
  assert.deepStrictEqual([next.prefs.ageMin, next.prefs.ageMax, next.prefs.weights.region], [30, 33, 3]);
  const before = Matcher.recommend(ME, PREFS, PROFILES).ranked.map((r) => r.profile.id);
  const after = Matcher.recommend(next.me, next.prefs, PROFILES).ranked.map((r) => r.profile.id);
  assert.notDeepStrictEqual(after, before);
  after.forEach((id) => assert.ok(byId(id).age >= 30 && byId(id).age <= 33, id));
});

test('상담(AI): 허용하지 않은 키와 범위 밖 값은 버린다', () => {
  const out = Concierge.sanitize({ changes: [
    { kind: 'weight', key: 'region', value: 3, why: '가까운 분' },
    { kind: 'weight', key: 'salary', value: 3 }, { kind: 'weight', key: 'age', value: 7 },
    { kind: 'filter', key: 'self', value: false }, { kind: 'filter', key: 'religion', value: 'yes' },
    { kind: 'age', min: 10, max: 99 }, { kind: 'styles', add: ['섹시한', '지적인'] }, { kind: 'interest', value: '코딩' }] }, ME, PREFS);
  assert.deepStrictEqual(out.map(Concierge.describe), ["거리 중요도 → '매우 중요'", '희망 나이 19~60세', '끌리는 스타일에 추가: 지적인']);
});

test('상담: AI가 켜져 있으면 AI 해석, AI가 실패하면 규칙으로 해석하고 이유를 남긴다', async () => {
  fakeAnswer('{"changes":[{"kind":"weight","key":"intro","value":3,"why":"대화를 중시하셔서요"}]}');
  const ai = await Concierge.plan('말이 잘 통하는 사람', ME, PREFS, OLLAMA);
  assert.strictEqual(ai.by, 'ai');
  assert.deepStrictEqual(ai.changes.map(Concierge.describe), ["자기소개 중요도 → '매우 중요'"]);
  global.fetch = async () => { throw new TypeError('fetch failed'); };
  const fallback = await Concierge.plan('말이 잘 통하는 사람', ME, PREFS, OLLAMA);
  assert.strictEqual(fallback.by, 'rule');
  assert.match(fallback.error, /Ollama/);
  assert.deepStrictEqual(fallback.changes.map(Concierge.describe), ["자기소개 중요도 → '중요'"]);
});

// ---------- 프로필 코치 ----------
test('코치: 빈 프로필은 낮은 점수와 고칠 점, 잘 채운 프로필은 100점', () => {
  const empty = Coach.check({ ...ME, interestDetails: {} });
  assert.strictEqual(empty.score, 0);
  assert.ok(empty.items.every((it) => !it.ok && it.tip && it.impact));
  const full = Coach.check({ ...ME, photo: 'data:', intro: '주말엔 근교 산에 올라요. 내려와서 국밥집 찾는 게 낙이에요. 퇴근하면 로맨스 영화를 봐요.',
    prompts: [{ q: 'weekend', a: '산책' }, { q: 'joy', a: '국밥' }] });
  assert.strictEqual(full.score, 100);
});

test('코치: 막연한 표현, 싫은 것 위주, 때가 없는 문장을 짚는다', () => {
  const kinds = Coach.introHints('좋은 사람 만나고 싶어요. 담배 피우는 사람 사절').map((h) => h.kind);
  assert.deepStrictEqual(kinds, ['short', 'vague', 'negative', 'concrete']);
  assert.deepStrictEqual(Coach.introHints('주말엔 근교 산에 올라요. 내려와서 국밥집 찾아가는 게 제일 큰 낙이에요.'), []);
});

test('코치(AI): 조언과 예시를 받고, 이상한 답이면 오류', async () => {
  fakeAnswer('{"tips":["첫 문장을 구체적으로","주말 모습을 넣기","좋아하는 데이트 쓰기"],"example":"주말엔 산에 올라요."}');
  const out = await Coach.aiReview(OLLAMA, { ...ME, intro: '좋은 사람 만나고 싶어요' });
  assert.strictEqual(out.tips.length, 3);
  assert.strictEqual(out.example, '주말엔 산에 올라요.');
  fakeAnswer('코칭할게요');
  await assert.rejects(Coach.aiReview(OLLAMA, ME), /코칭 내용을 만들지 못했어요/);
});

// ---------- 데이트 제안·내 차례 ----------
test('데이트 제안: 세부 취향까지 같은 관심사로 코스를 짜고, 사는 곳에 맞춰 말한다', () => {
  const ideas = Dates.ideas(ME, byId('f13'));
  assert.strictEqual(ideas.length, 3);
  assert.deepStrictEqual(ideas.map((d) => d.title), ['요리 · 한식', '영화 · 로맨스', '등산 · 근교 산']);
  assert.match(ideas[0].message, /둘 다 서울이라 가까운 데로/);
  assert.match(Dates.ideas(ME, byId('m04'))[0].message, /서울과 부산이 멀어서/);
});

test('데이트 제안: 공통 관심사가 없어도 상대 관심사와 가벼운 첫 만남을 제안한다', () => {
  const ideas = Dates.ideas({ ...ME, interests: ['독서'], interestDetails: {} }, byId('f03'));
  assert.deepStrictEqual(ideas.map((d) => d.title), ['게임 (상대 관심사)', '가벼운 첫 만남']);
});

test('내 차례: 마지막 메시지를 상대가 보냈으면 내 차례', () => {
  assert.strictEqual(Dates.turnOf([{ from: 'system' }, { from: 'them' }]), 'mine');
  assert.strictEqual(Dates.turnOf([{ from: 'them' }, { from: 'me' }, { from: 'system' }]), 'theirs');
  assert.strictEqual(Dates.turnOf([{ from: 'system' }]), 'new');
});

// ---------- 만남 후기 ----------
const scoredF13 = () => Matcher.scoreProfile(ME, PREFS, byId('f13'));

test('후기 "또 보고 싶어요": 잘 맞았던 항목 2개의 중요도를 한 단계 올린다', () => {
  const { weights, changes } = Feedback.learn({}, scoredF13(), 'again');
  assert.strictEqual(changes.length, 2);
  changes.forEach((c) => { assert.strictEqual(weights[c.key], 2); assert.match(c.why, /은서님과 .*잘 맞았어요/); });
});

test('후기 "아니었어요": 고른 이유의 항목만 올리고, 끌림 문제면 바꾸지 않는다', () => {
  const far = Feedback.learn({ region: 2 }, scoredF13(), 'not', 'distance');
  assert.deepStrictEqual(far.weights, { region: 3 });
  assert.deepStrictEqual(far.changes.map((c) => [c.label, c.from, c.to]), [['거리', '중요', '매우 중요']]);
  assert.deepStrictEqual(Feedback.learn({}, scoredF13(), 'not', 'spark').changes, []);
  assert.deepStrictEqual(Feedback.learn({ region: 3 }, scoredF13(), 'not', 'distance').changes, []); // 이미 최고 단계
});
