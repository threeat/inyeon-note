const test = require('node:test');
const assert = require('node:assert');
const PROFILES = require('../js/profiles.js');
const Chat = require('../js/chat.js');

const ME = { name: '준석', gender: '남성', age: 28, job: '개발자', region: '서울', interests: ['등산', '요리', '영화'], interestDetails: { 등산: ['근교 산'], 요리: ['한식'], 영화: ['로맨스'] } };
const byId = (id) => PROFILES.find((p) => p.id === id);
const say = (p, text) => Chat.localReply(p, ME, [{ from: 'them', text: '안녕하세요' }, { from: 'me', text }]);

test('첫 인사는 이름 받침에 맞는 조사와 공통 관심사를 쓴다', () => {
  assert.match(Chat.greeting(byId('f13'), ME), /은서예요\. 요리 중에서도 한식 좋아하신다고/);
  assert.match(Chat.greeting(byId('f05'), ME), /유진이에요/);
});

test('기본 대화는 프로필 사실대로 답한다', () => {
  const p = byId('f13');
  assert.match(say(p, '무슨 일 하세요?'), /초등학교 교사로 일하고/);
  assert.match(say(p, '어디 사세요?'), /서울에 살아요/);
  assert.match(say(byId('f05'), '종교 있어요?'), /천주교예요/);
});

test('인사와 질문이 같이 오면 질문에 답한다', () => {
  assert.match(say(byId('f13'), '안녕하세요! 무슨 일 하세요?'), /교사/);
});

test('AI냐고 물으면 솔직하게 AI 캐릭터라고 말한다', () => {
  assert.match(say(byId('m02'), '혹시 AI예요?'), /AI 캐릭터/);
});

test('Claude 프롬프트에 프로필, 공통 관심사, 안전 규칙이 들어간다', () => {
  const s = Chat.systemPrompt(byId('f13'), ME);
  assert.match(s, /초등학교 교사/);
  assert.match(s, /공통 관심사: 요리, 영화, 등산 \(특히 요리는 한식 취향까지 같아요\)/);
  assert.match(s, /영화\(로맨스·코미디\)/);
  assert.match(s, /AI 캐릭터라고 솔직하게/);
  assert.match(s, /전화번호, 계좌, 돈/);
});

test('AI 답장 다듬기: 꾸밈 기호와 넘치는 이모지를 지우고, 대화 중 다시 하는 인사를 빼고, 3문장까지만', () => {
  const p = byId('f13');
  const talking = [{ from: 'them', text: '인사' }, { from: 'me', text: '질문' }, { from: 'them', text: '답' }, { from: 'me', text: '또 질문' }];
  assert.strictEqual(Chat.tidyReply('안녕하세요 준석님! 저 은서예요. 4학년 담임이에요.', p, talking), '4학년 담임이에요.');
  assert.strictEqual(Chat.tidyReply('저는 **찍먹**파예요. 😅🍲 바삭해야죠! 준석님은요? 진짜 궁금해요. 알려 주세요!', p, talking), '저는 찍먹파예요. 😅 바삭해야죠! 준석님은요?');
  assert.strictEqual(Chat.tidyReply('안녕하세요! 은서예요. 반가워요', p, [{ from: 'them', text: '인사' }]), '안녕하세요! 은서예요. 반가워요'); // 첫 답의 인사는 그대로
});

test('한국어를 잘하는 모델을 먼저 고른다', () => {
  const LLM = require('../js/llm.js');
  assert.strictEqual(LLM.preferredModel(['llama3.1:8b', 'qwen3:8b', 'exaone3.5:7.8b']), 'exaone3.5:7.8b');
  assert.strictEqual(LLM.preferredModel(['llama3.1:8b', 'mistral:7b']), 'llama3.1:8b');
  assert.strictEqual(LLM.isRecommended('exaone3.5:7.8b'), true);
});
