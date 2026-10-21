// 가상 회원 자기소개(intro)의 임베딩을 미리 계산해 js/embeddings.js로 저장한다.
// 계산은 브라우저와 같은 js/intro-embed.js를 쓴다 (모델·접두어·문장 나누기가 같아야 비교할 수 있다).
// 실행: npm run embeddings        (유사도 표만 보기: npm run embeddings -- --table)
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PROFILES = require('../js/profiles.js');
const IntroEmbed = require('../js/intro-embed.js');

const loadLib = async () => {
  const lib = await import('@huggingface/transformers');
  lib.env.cacheDir = fileURLToPath(new URL('../.cache/', import.meta.url));
  return lib;
};

const vectors = {};
for (const p of PROFILES) {
  const { text, ...rest } = await IntroEmbed.embedIntro(p.intro, loadLib); // 원문은 profiles.js에 있으니 저장하지 않는다
  vectors[p.id] = { ...rest, sentences: rest.sentences.map((s) => s.vec) };
}
const mean = IntroEmbed.meanOf(PROFILES.map((p) => vectors[p.id].vec));
const sentenceMean = IntroEmbed.meanOf(PROFILES.flatMap((p) => vectors[p.id].sentences));

if (process.argv.includes('--table')) {
  const sim = (a, b) => IntroEmbed.similarity(vectors[a.id].vec, vectors[b.id].vec, mean);
  const pairs = [];
  PROFILES.forEach((a, i) => PROFILES.forEach((b, j) => { if (i < j) pairs.push([sim(a, b), a, b]); }));
  pairs.sort((x, y) => y[0] - x[0]);
  const show = ([s, a, b]) => console.log(`${s.toFixed(3)}  ${a.name}「${a.intro}」\n       ${b.name}「${b.intro}」`);
  console.log('--- 가장 비슷한 12쌍 ---'); pairs.slice(0, 12).forEach(show);
  console.log('--- 가장 다른 5쌍 ---'); pairs.slice(-5).forEach(show);
  const sims = pairs.map((p) => p[0]);
  const q = (r) => sims[Math.floor((sims.length - 1) * (1 - r))].toFixed(3);
  console.log(`--- 분포 (${sims.length}쌍) --- 최소 ${q(0)} / 50% ${q(0.5)} / 75% ${q(0.75)} / 90% ${q(0.9)} / 95% ${q(0.95)} / 최대 ${q(1)}`);
} else {
  const js = `// 자동 생성 파일: scripts/build-embeddings.mjs (npm run embeddings). 직접 고치지 말 것.
// 가상 회원 자기소개(intro)의 임베딩. 형식과 계산 방법은 js/intro-embed.js.
// vectors[id] = 소개 전체, sentences[id] = 문장별 (profiles.js의 intro를 문장으로 나눈 순서), mean / sentenceMean = 유사도를 잴 때 빼는 평균 벡터.
(function (root) {
  const EMBEDDINGS = {
    model: ${JSON.stringify(IntroEmbed.MODEL)},
    mean: ${JSON.stringify(mean)},
    sentenceMean: ${JSON.stringify(sentenceMean)},
    // 만들 때의 소개글 지문. profiles.js의 intro를 고치고 다시 만들지 않으면 그 회원은 비교에서 빠진다.
    fingerprints: ${JSON.stringify(Object.fromEntries(PROFILES.map((p) => [p.id, IntroEmbed.fingerprint(p.intro)])))},
    vectors: {
${PROFILES.map((p) => `      ${p.id}: ${JSON.stringify(vectors[p.id].vec)},`).join('\n')}
    },
    sentences: {
${PROFILES.map((p) => `      ${p.id}: ${JSON.stringify(vectors[p.id].sentences)},`).join('\n')}
    },
  };
  root.EMBEDDINGS = EMBEDDINGS;
  if (typeof module === 'object' && module.exports) module.exports = EMBEDDINGS;
})(typeof window !== 'undefined' ? window : globalThis);
`;
  writeFileSync(new URL('../js/embeddings.js', import.meta.url), js);
  console.log(`js/embeddings.js 저장: ${PROFILES.length}명, 문장 ${PROFILES.reduce((s, p) => s + vectors[p.id].sentences.length, 0)}개`);
}
