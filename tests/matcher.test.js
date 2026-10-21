const test = require('node:test');
const assert = require('node:assert');
const Rules = require('../js/rules.js');
const PROFILES = require('../js/profiles.js');
const Matcher = require('../js/matcher.js');
const IntroEmbed = require('../js/intro-embed.js');
const EMBEDDINGS = require('../js/embeddings.js');

// 내 자기소개 임베딩은 브라우저에서 AI 모델로 계산한다. 테스트에서는 모델 없이 돌도록 가상 회원의 소개와 벡터를 빌려 쓴다.
const withIntroOf = (me, id) => {
  const p = PROFILES.find((x) => x.id === id);
  return { ...me, intro: p.intro, introEmbedding: { model: EMBEDDINGS.model, text: p.intro, ...Matcher.introOf(p) } };
};

// 도윤(m01)의 소개: 이 '나'가 만나는 여성 회원 누구와도 유사도가 0.04 이하라 자기소개 점수는 모두 0점이다.
const ME = withIntroOf({
  id: 'me', name: '나', gender: '남성', orientation: '이성애자', age: 28, height: 178, region: '서울', religion: '무교',
  smoker: false, drinking: '가끔', style: '단정한', marriage: '1~2년 내', interests: ['등산', '요리', '영화'],
  interestDetails: { 등산: ['근교 산'], 요리: ['한식'], 영화: ['로맨스'] },
}, 'm01');
const PREFS = {
  ageMin: 24, ageMax: 31, heightMin: 155, heightMax: 175, styles: ['귀여운', '단정한'],
  filters: { age: true, height: false, smoking: true, religion: false, region: false, marriage: true },
};
const run = (me = ME, prefs = PREFS, profiles = PROFILES) => Matcher.recommend(me, prefs, profiles);
const names = (list) => list.map((x) => (x.profile || x).name);

test('점수표 만점 합계는 100점', () => {
  assert.strictEqual(Rules.SCORE_RULES.reduce((s, r) => s + r.max, 0), 100);
});

test('가상 프로필은 20명 이상', () => {
  assert.ok(PROFILES.length >= 20);
});

test('나 자신은 추천하지 않는다 (양성애자라 모든 성별에 관심 있어도)', () => {
  const r = run({ ...ME, orientation: '양성애자' }, { ...PREFS, filters: {} });
  assert.deepStrictEqual(names(r.steps[0].removed), ['나']);
  assert.ok(!r.ranked.some((x) => x.profile.id === 'me'));
});

test('켜 둔 조건으로 거르고, 왜 걸렀는지 남긴다', () => {
  const r = run();
  const step = (k) => r.steps.find((s) => s.key === k);
  assert.deepStrictEqual(names(step('age').removed).sort(), ['다은', '지우'].sort());
  assert.ok(names(step('smoking').removed).includes('민지'));
  assert.ok(names(step('marriage').removed).includes('예린'));
  assert.strictEqual(step('height').active, false);
  assert.match(step('age').removed[0].why, /희망 24~31세/);
});

test('기본 설정에서 1위는 은서 85점, 2위 지민 63점', () => {
  const r = run();
  assert.strictEqual(r.ranked[0].profile.name, '은서');
  assert.strictEqual(r.ranked[0].total, 85);
  assert.strictEqual(r.ranked[1].profile.name, '지민');
  assert.strictEqual(r.ranked[1].total, 63);
});

test('1위 이유는 2위와의 점수 차와 앞선 항목을 말한다', () => {
  const { explanation } = run();
  const text = explanation.lines.join('\n');
  assert.match(explanation.headline, /은서님이 85점/);
  assert.match(text, /2위 지민님\(63점\)보다 22점 높습니다/);
  assert.match(text, /관심사에서 \+14점/);
  assert.match(text, /결혼관에서 \+8점/);
});

test('동점이면 관심사 개수로 순위를 가르고 그 이유를 말한다', () => {
  const a = { ...PROFILES[0], id: 'a', name: '가', interests: ['등산', '요리'], interestDetails: {}, religion: '불교' };   // 관심사 2개, 종교 0점
  const b = { ...PROFILES[0], id: 'b', name: '나나', interests: ['등산'], interestDetails: {}, religion: '무교' };          // 관심사 1개, 종교 10점
  const r = run(ME, PREFS, [b, a]);
  assert.strictEqual(r.ranked[0].total, r.ranked[1].total);
  assert.strictEqual(r.ranked[0].profile.name, '가');
  assert.match(r.explanation.lines[0], /동점.*관심사/);
});

// ---------- 성적 지향: 서로 관심 있는 성별일 때만 추천 ----------
const NO_FILTERS = { ...PREFS, ageMin: 19, ageMax: 60, filters: {} };
const passedOf = (me) => run(me, NO_FILTERS).ranked.map((x) => x.profile);
const canLike = (a, b) => Matcher.interestedIn(a).includes(b.gender);

for (const gender of ['여성', '남성']) {
  for (const orientation of ['이성애자', '동성애자', '양성애자']) {
    test(`${gender}·${orientation}: 추천된 모두가 나와 서로 관심 있는 사람`, () => {
      const me = { ...ME, gender, orientation };
      const passed = passedOf(me);
      assert.ok(passed.length > 0, '추천이 1명 이상');
      passed.forEach((p) => {
        assert.ok(canLike(me, p), `${p.name}: 내가 관심 있는 성별`);
        assert.ok(canLike(p, me), `${p.name}: 상대도 내 성별에 관심`);
      });
      // 반대로, 서로 관심 있는 사람은 하나도 빠지지 않는다
      const expected = PROFILES.filter((p) => canLike(me, p) && canLike(p, me)).length;
      assert.strictEqual(passed.length, expected);
    });
  }
}

test('동성애자 남성에게는 남성을 좋아하는 남성만, 이성애자 남성은 제외', () => {
  const passed = passedOf({ ...ME, orientation: '동성애자' });
  assert.ok(passed.every((p) => p.gender === '남성' && p.orientation !== '이성애자'));
  assert.deepStrictEqual(names(passed).sort(), ['건우', '시우', '지훈', '태윤'].sort());
});

test('양성애자 여성에게는 여성과 남성이 모두 추천된다', () => {
  const passed = passedOf({ ...ME, gender: '여성', orientation: '양성애자' });
  assert.ok(passed.some((p) => p.gender === '여성'));
  assert.ok(passed.some((p) => p.gender === '남성'));
});

test('지향을 비공개로 한 회원은 걸러진 이유에도 지향이 드러나지 않는다', () => {
  const hidden = { ...PROFILES.find((p) => p.id === 'f01'), id: 'x', orientation: '이성애자', orientationPublic: false };
  const r = run({ ...ME, gender: '여성', orientation: '동성애자' }, NO_FILTERS, [hidden]);
  const why = r.steps.find((s) => s.key === 'orientation').removed[0].why;
  assert.doesNotMatch(why, /이성애자/);
});

// ---------- 돌싱 ----------
test('돌싱 제외를 켜면 돌싱 회원이 이유와 함께 빠진다 (끄면 그대로 추천)', () => {
  const off = run();
  assert.ok(names(off.ranked).includes('채원'), '기본값(꺼짐)에서는 돌싱 채원도 추천');
  const on = run(ME, { ...PREFS, filters: { ...PREFS.filters, divorced: true } });
  const step = on.steps.find((s) => s.key === 'divorced');
  assert.deepStrictEqual(names(step.removed), ['채원']);
  assert.strictEqual(step.removed[0].why, '돌싱(자녀 없음)');
});

test('자녀 있음 제외는 자녀가 있는 돌싱만 거른다', () => {
  const me = { ...ME, gender: '여성' };
  const r = run(me, { ...PREFS, ageMin: 19, ageMax: 60, filters: { kids: true } });
  const removed = names(r.steps.find((s) => s.key === 'kids').removed);
  assert.deepStrictEqual(removed, ['민재']);
  assert.ok(names(r.ranked).includes('승민'), '자녀 없는 돌싱은 남는다');
});

// ---------- 관심사 세부 취향 ----------
const interestItem = (me, p) => Matcher.scoreProfile(me, PREFS, p).items.find((it) => it.key === 'interests');

test('같은 관심사라도 세부 취향이 겹치면 10점, 둘 다 골랐는데 안 겹치면 6점', () => {
  const eunseo = PROFILES.find((p) => p.name === '은서'); // 요리[한식·베이킹], 영화[로맨스·코미디], 등산[근교 산]
  const jimin = PROFILES.find((p) => p.name === '지민');  // 요리[양식·베이킹], 영화[로맨스·애니메이션]
  assert.strictEqual(interestItem(ME, eunseo).points, 30);
  const j = interestItem(ME, jimin);
  assert.strictEqual(j.points, 16); // 요리 취향 다름 6 + 영화 로맨스 10
  assert.match(j.detail, /요리\[취향 다름: 양식·베이킹\]/);
  assert.match(j.detail, /영화\[로맨스\]/);
});

test('한쪽이라도 세부 취향을 안 고르면 관심사가 같다는 것만으로 10점', () => {
  const jimin = PROFILES.find((p) => p.name === '지민');
  assert.strictEqual(interestItem({ ...ME, interestDetails: {} }, jimin).points, 20);
  assert.strictEqual(interestItem({ ...ME, interestDetails: { 요리: ['한식'] } }, { ...jimin, interestDetails: {} }).points, 20);
});

test('1위 이유에 세부 취향 근거가 나온다', () => {
  const text = run().explanation.lines.join('\n');
  assert.match(text, /요리\[한식\]/);
  assert.match(text, /취향 다름/);
});

// ---------- 가중치 ----------
test('가중치를 정하지 않으면 기본 점수표 그대로', () => {
  assert.deepStrictEqual(Matcher.effectiveMax(undefined),
    Object.fromEntries(Rules.SCORE_RULES.map((r) => [r.key, r.max])));
});

test('어떤 가중치를 골라도 만점 합계는 항상 100', () => {
  const levels = Rules.WEIGHT_LEVELS.map((l) => l.value);
  for (let n = 0; n < 300; n++) {
    const weights = Object.fromEntries(Rules.SCORE_RULES.map((r, i) => [r.key, levels[(n * 7 + i * 3 + n * i) % levels.length]]));
    const maxes = Matcher.effectiveMax(weights);
    assert.strictEqual(Object.values(maxes).reduce((a, b) => a + b, 0), 100, JSON.stringify(weights));
    Rules.SCORE_RULES.forEach((r) => { if (weights[r.key] === 0 && Object.values(weights).some((v) => v > 0)) assert.strictEqual(maxes[r.key], 0); });
  }
});

test('관심사를 매우 중요(×3)로 올리면 관심사 만점이 61점이 되고 1위 이유에 나온다', () => {
  const prefs = { ...PREFS, weights: { interests: 3 } };
  const r = run(ME, prefs);
  const item = (x) => x.items.find((it) => it.key === 'interests');
  assert.strictEqual(item(r.ranked[0]).max, 61);
  assert.strictEqual(item(r.ranked[0]).points, 52); // 3개 겹침 = 기본 30/35 → 61점 만점의 6/7
  assert.match(r.explanation.lines.join('\n'), /관심사 '매우 중요'\(만점 61점\)/);
});

test('가중치를 바꾸면 순위가 바뀔 수 있다: 종교만 보면 같은 종교인 사람이 앞선다', () => {
  const r = run(ME, { ...PREFS, weights: Object.fromEntries(Rules.SCORE_RULES.map((s) => [s.key, s.key === 'religion' ? 1 : 0])) });
  assert.strictEqual(r.ranked[0].profile.religion, ME.religion);
  assert.strictEqual(r.ranked[0].total, 100);
  assert.ok(!r.explanation.lines.join('\n').includes('만점 항목: 관심사'), "'안 봄' 항목은 만점 항목에 넣지 않는다");
});

// ---------- 자기소개 임베딩 ----------
const byName = (n) => PROFILES.find((p) => p.name === n);
const introItem = (me, p, prefs = PREFS) => Matcher.scoreProfile(me, prefs, p).items.find((it) => it.key === 'intro');

test('embeddings.js가 지금의 자기소개로 만들어져 있다 (아니면 npm run embeddings)', () => {
  PROFILES.forEach((p) => {
    assert.strictEqual(EMBEDDINGS.fingerprints[p.id], IntroEmbed.fingerprint(p.intro), `${p.name}: 소개가 바뀜`);
    assert.strictEqual(EMBEDDINGS.sentences[p.id].length, IntroEmbed.splitSentences(p.intro).length, `${p.name}: 문장 수`);
    assert.ok(Matcher.introOf(p), p.name);
  });
});

test('벡터를 int8로 줄여 저장해도 값이 거의 그대로다', () => {
  const v = Array.from({ length: 384 }, (_, i) => Math.sin(i) / 10);
  const back = IntroEmbed.decode(IntroEmbed.encode(v));
  assert.ok(v.every((x, i) => Math.abs(x - back[i]) < 0.001));
  assert.ok(IntroEmbed.similarity(IntroEmbed.encode(v), IntroEmbed.encode(v)) > 0.9999);
});

test('뜻이 닮은 자기소개는 점수를 받고, 가장 닮은 문장을 근거로 보여준다', () => {
  const me = withIntroOf(ME, 'f09'); // 채원: 조용한 데이트, 미술관, 깊은 이야기
  const it = introItem(me, byName('건우')); // 미술관 데이트, 전시 보고 이야기
  assert.strictEqual(it.points, 10);
  assert.match(it.detail, /아주 비슷해요 \(유사도 0\.2\d\)/);
  assert.match(it.detail, /「미술관 데이트 좋아해요\.」 ↔ 나 「조용한 데이트를 좋아해요\.」/);
  const far = introItem(me, byName('우진')); // 철인3종, 마라톤
  assert.strictEqual(far.points, 0);
  assert.match(far.detail, /닮은 점이 적어요/);
  assert.doesNotMatch(far.detail, /「/, '점수가 없으면 근거 문장을 붙이지 않는다');
});

test('내 자기소개가 없거나 아직 분석 전이면 그 항목을 빼고 나머지로 100점을 나눈다', () => {
  for (const me of [{ ...ME, intro: '', introEmbedding: undefined }, { ...ME, introEmbedding: undefined }]) {
    const r = run(me);
    const it = r.ranked[0].items.find((x) => x.key === 'intro');
    assert.strictEqual(it.max, 0);
    assert.strictEqual(r.ranked[0].items.reduce((s, x) => s + x.max, 0), 100);
    assert.match(it.detail, me.intro ? /아직 분석하지 못해/ : /자기소개가 없어/);
    assert.ok(!r.explanation.lines.join('\n').includes("자기소개 '안 봄'"), '내가 끈 것이 아니므로 중요도 안내에 넣지 않는다');
  }
});

test('소개를 고치면 예전 벡터는 쓰지 않는다', () => {
  assert.strictEqual(Matcher.introOf({ ...ME, intro: '완전히 새로 쓴 소개예요.' }), null);
  assert.strictEqual(Matcher.introOf({ ...byName('건우'), intro: '고친 소개' }), null);
});

// ---------- 매칭 ----------
test('궁합 50점 이상이면 매칭, 미만이면 대기', () => {
  const { ranked } = run();
  const top = ranked[0];
  const low = ranked[ranked.length - 1];
  assert.strictEqual(Matcher.matchResult(top).matched, true);
  assert.match(Matcher.matchResult(top).reason, /85점 ≥ 50점/);
  assert.ok(low.total < 50);
  assert.strictEqual(Matcher.matchResult(low).matched, false);
});

test('조건에 맞는 사람이 0명이면 안내한다', () => {
  const r = run(ME, { ...PREFS, ageMin: 40, ageMax: 50 });
  assert.strictEqual(r.ranked.length, 0);
  assert.strictEqual(r.explanation, null);
  assert.match(r.notice, /0명/);
  assert.match(r.notice, /희망 나이 범위 밖/);
});
