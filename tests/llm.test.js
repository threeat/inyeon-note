const test = require('node:test');
const assert = require('node:assert');
const LLM = require('../js/llm.js');
const Chat = require('../js/chat.js');
const Safety = require('../js/safety.js');
const Starters = require('../js/starters.js');
const PROFILES = require('../js/profiles.js');

const ME = { name: '준석', gender: '남성', age: 28, job: '개발자', region: '서울', interests: ['등산', '요리', '영화'], interestDetails: { 등산: ['근교 산'], 요리: ['한식'], 영화: ['로맨스'] } };
const byId = (id) => PROFILES.find((p) => p.id === id);
const OLLAMA = LLM.normalize({ provider: 'ollama', ollamaModel: 'llama3.1:8b' });

// Ollama /api/chat을 흉내 낸다. 받은 요청은 calls에 남긴다.
function fakeOllama(answer, status = 200) {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, body: init && JSON.parse(init.body) });
    return { ok: status === 200, status, json: async () => (status === 200 ? { message: { content: answer } } : { error: 'model "x" not found' }) };
  };
  return calls;
}
test.afterEach(() => { delete global.fetch; });

test('예전 계정의 Claude 키는 claude 설정으로 옮긴다', () => {
  assert.deepStrictEqual(LLM.normalize(undefined, 'sk-ant-abc'), { ...LLM.DEFAULT_SETTINGS, provider: 'claude', apiKey: 'sk-ant-abc' });
  assert.strictEqual(LLM.normalize().provider, 'off');
  assert.strictEqual(LLM.normalize({ provider: '이상한 값' }).provider, 'off');
  assert.strictEqual(LLM.normalize({ ollamaUrl: 'http://pc:11434/ ' }).ollamaUrl, 'http://pc:11434');
});

test('키나 모델이 있어야 AI를 쓸 수 있다', () => {
  assert.strictEqual(LLM.ready(LLM.normalize({ provider: 'claude' })), false);
  assert.strictEqual(LLM.ready(LLM.normalize({ provider: 'ollama' })), false);
  assert.strictEqual(LLM.ready(OLLAMA), true);
  assert.strictEqual(LLM.label(OLLAMA), '로컬 llama3.1:8b');
});

test('JSON 앞뒤 군말과 생각 과정을 걷어 낸다', () => {
  assert.deepStrictEqual(LLM.parseJson('네! {"flag": false} 입니다'), { flag: false });
  assert.strictEqual(LLM.parseJson('JSON 없음'), null);
  assert.strictEqual(LLM.clean('<think>음…</think>\n안녕하세요'), '안녕하세요');
});

test('Ollama 호출: 시스템 프롬프트와 대화 기록을 /api/chat으로 보낸다', async () => {
  const calls = fakeOllama('안녕하세요! 저도 등산 좋아해요.');
  const res = await Chat.reply({ ai: OLLAMA, profile: byId('f13'), me: ME, history: [{ from: 'them', text: '안녕하세요' }, { from: 'me', text: '반가워요' }] });
  assert.deepStrictEqual(res, { text: '안녕하세요! 저도 등산 좋아해요.', mode: 'ai' });
  assert.strictEqual(calls[0].url, 'http://localhost:11434/api/chat');
  const { model, stream, messages } = calls[0].body;
  assert.strictEqual(model, 'llama3.1:8b');
  assert.strictEqual(stream, false);
  assert.match(messages[0].content, /초등학교 교사/);
  assert.deepStrictEqual(messages.slice(1).map((m) => m.role), ['user', 'assistant', 'user']);
});

test('AI가 꺼져 있으면 부르지 않고, 실패하면 기본 대화로 이어 가며 이유를 알려 준다', async () => {
  const calls = fakeOllama('', 404);
  const off = await Chat.reply({ ai: LLM.normalize(), profile: byId('f13'), me: ME, history: [{ from: 'me', text: '무슨 일 하세요?' }] });
  assert.strictEqual(off.mode, 'local');
  assert.strictEqual(calls.length, 0);
  const failed = await Chat.reply({ ai: OLLAMA, profile: byId('f13'), me: ME, history: [{ from: 'me', text: '무슨 일 하세요?' }] });
  assert.strictEqual(failed.mode, 'local');
  assert.match(failed.text, /교사/);
  assert.match(failed.error, /ollama pull/);
});

test('Ollama가 꺼져 있으면 연결과 OLLAMA_ORIGINS를 확인하라고 알려 준다', async () => {
  global.fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(LLM.complete(OLLAMA, { system: 's', messages: [] }), /OLLAMA_ORIGINS/);
});

test('모델 목록에서 임베딩 전용 모델은 뺀다', async () => {
  global.fetch = async () => ({ ok: true, json: async () => ({ models: [
    { name: 'bge-m3:latest', capabilities: ['embedding'] }, { name: 'llama3.1:8b', capabilities: ['completion', 'tools'] }, { name: 'nomic-embed-text' }] }) });
  assert.deepStrictEqual(await LLM.listOllamaModels('http://localhost:11434'), ['llama3.1:8b']);
});

// ---------- 안전 검사 ----------
test('규칙: 연락처, 돈, 링크, 욕설을 잡는다', () => {
  const keys = (t) => Safety.check(t).map((h) => h.key);
  assert.deepStrictEqual(keys('제 번호 010-1234-5678 이에요'), ['contact']);
  assert.deepStrictEqual(keys('카톡 아이디 알려 주세요'), ['contact']);
  assert.deepStrictEqual(keys('여기 불편한데 카톡으로 얘기해요'), ['contact']);
  assert.deepStrictEqual(keys('텔레로 넘어가실래요?'), ['contact']);
  assert.deepStrictEqual(keys('인스타 디엠 주세요'), ['contact']);
  assert.deepStrictEqual(keys('급하게 돈 좀 빌려 줄 수 있어요? 계좌 보낼게요'), ['money']);
  assert.deepStrictEqual(keys('코인 리딩방 들어오면 수익률 좋아요'), ['money']);
  assert.deepStrictEqual(keys('여기 들어가 봐요 https://bit.ly/abc'), ['link']);
  assert.deepStrictEqual(keys('ㅅㅂ 진짜'), ['abuse']);
});

test('규칙: 평범한 대화는 잡지 않는다', () => {
  ['안녕하세요! 주말에 등산 가세요?', '온라인 게임 좋아해요', '온라인으로 수업 들어요', '라인업이 좋던데요', '카톡 프사 바꿨어요',
    '인스타에서 본 맛집이에요', '저는 3년 내 결혼하고 싶어요', '돈가스 좋아해요'].forEach((t) =>
    assert.deepStrictEqual(Safety.check(t), [], t));
});

test('받은 메시지: 규칙에 안 걸리면 AI가 판단하고, AI 결과가 경고로 바뀐다', async () => {
  const calls = fakeOllama('{"flag": true, "category": "personal", "reason": "회사 위치를 캐묻고 있어요."}');
  const hits = await Safety.review('회사가 정확히 어느 건물이에요? 퇴근 몇 시에 해요?', OLLAMA);
  assert.deepStrictEqual(hits, [{ key: 'personal', label: '과한 개인정보 요구', theirs: '회사 위치를 캐묻고 있어요.', byAi: true }]);
  assert.strictEqual(calls[0].body.format, 'json');
});

test('받은 메시지: 규칙에 걸리면 AI를 부르지 않고, AI가 실패하면 경고 없이 넘어간다', async () => {
  const calls = fakeOllama('{"flag": false, "category": "none"}');
  assert.strictEqual((await Safety.review('카톡으로 얘기해요', OLLAMA))[0].key, 'contact');
  assert.strictEqual(calls.length, 0);
  assert.deepStrictEqual(await Safety.review('안녕하세요', OLLAMA), []);
  fakeOllama('', 500);
  assert.deepStrictEqual(await Safety.review('안녕하세요', OLLAMA), []);
});

// ---------- 대화 시작 도우미 ----------
test('첫 마디 추천: 세부 취향까지 같은 관심사를 먼저 꺼낸다', () => {
  const list = Starters.suggest(ME, byId('f13'));
  assert.strictEqual(list.length, 3);
  assert.match(list[0], /요리 중에서도 한식 좋아하시는 거 저랑 똑같아서/);
  assert.strictEqual(new Set(list).size, 3);
});

test('첫 마디 추천: 공통 관심사가 없어도 문장이 나온다', () => {
  const me = { ...ME, interests: ['독서'], interestDetails: {} };
  const list = Starters.suggest(me, byId('f03'));
  assert.ok(list.length >= 2);
  assert.match(list[0], /게임 좋아하시던데/);
});

test('AI 첫 마디 추천: JSON에서 문장을 꺼내고, 이상하면 오류를 던진다', async () => {
  fakeOllama('{"messages": ["은서님, 한식 중에 제일 자신 있는 메뉴가 뭐예요?", "", "로맨스 영화 중 인생작이 궁금해요!"]}');
  assert.deepStrictEqual(await Starters.aiSuggest(OLLAMA, ME, byId('f13')), ['은서님, 한식 중에 제일 자신 있는 메뉴가 뭐예요?', '로맨스 영화 중 인생작이 궁금해요!']);
  fakeOllama('추천할게요!');
  await assert.rejects(Starters.aiSuggest(OLLAMA, ME, byId('f13')), /만들지 못했어요/);
});
