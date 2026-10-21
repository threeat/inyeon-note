// 자기소개(intro) 임베딩: 계산, 저장 형식, 유사도.
// 가상 회원 벡터를 미리 만드는 스크립트(scripts/build-embeddings.mjs)와 브라우저가 이 파일을 함께 쓴다.
// 모델·접두어·문장 나누기가 한쪽만 바뀌면 유사도를 비교할 수 없기 때문이다.
(function (root) {
  const MODEL = 'Xenova/multilingual-e5-small';
  const PREFIX = 'query: '; // e5 계열은 접두어가 필요하다. 사람끼리 비교(대칭)라 양쪽 모두 query를 쓴다.
  const LIB_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';

  // 문장 단위로 나눠 두면 "어느 문장이 비슷했는지"를 근거로 보여줄 수 있다.
  const splitSentences = (text) => String(text || '').split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

  // ---------- 저장 형식: 벡터마다 int8로 줄여 base64 문자열 하나로 둔다 (384차원 → 516자) ----------
  const b64encode = (bytes) => (typeof Buffer !== 'undefined' ? Buffer.from(bytes).toString('base64') : btoa(String.fromCharCode(...bytes)));
  const b64decode = (str) => (typeof Buffer !== 'undefined'
    ? new Uint8Array(Buffer.from(str, 'base64')) : Uint8Array.from(atob(str), (c) => c.charCodeAt(0)));

  function encode(vec) {
    const scale = Math.max(...vec.map(Math.abs)) / 127 || 1;
    const bytes = new Uint8Array(4 + vec.length);
    new DataView(bytes.buffer).setFloat32(0, scale, true);
    vec.forEach((x, i) => { bytes[4 + i] = Math.round(x / scale) & 0xff; });
    return b64encode(bytes);
  }
  const decoded = new Map();
  function decode(str) {
    if (!decoded.has(str)) {
      const bytes = b64decode(str);
      const scale = new DataView(bytes.buffer, bytes.byteOffset).getFloat32(0, true);
      decoded.set(str, Float32Array.from(new Int8Array(bytes.buffer, bytes.byteOffset + 4), (x) => x * scale));
    }
    return decoded.get(str);
  }

  // ---------- 유사도: 평균 벡터를 빼고 코사인 ----------
  // 이 모델은 관련 없는 문장끼리도 0.8 이상이 나온다. 모든 소개글이 공통으로 가진 성분(말투, 문장 모양)을
  // 평균으로 빼야 내용의 차이가 드러난다.
  function similarity(a, b, mean) {
    const x = decode(a); const y = decode(b); const m = mean ? decode(mean) : null;
    let dot = 0; let nx = 0; let ny = 0;
    for (let i = 0; i < x.length; i++) {
      const u = x[i] - (m ? m[i] : 0); const v = y[i] - (m ? m[i] : 0);
      dot += u * v; nx += u * u; ny += v * v;
    }
    return nx && ny ? dot / Math.sqrt(nx * ny) : 0;
  }
  function meanOf(encodedList) {
    const vs = encodedList.map(decode);
    return encode(Array.from(vs[0], (_, i) => vs.reduce((s, v) => s + v[i], 0) / vs.length));
  }

  // 미리 계산한 벡터가 지금의 소개글로 만든 것인지 확인하는 짧은 지문 (FNV-1a)
  function fingerprint(text) {
    let h = 0x811c9dc5;
    for (const ch of String(text)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }

  // ---------- 계산 (브라우저: CDN에서 라이브러리를 처음 쓸 때 한 번만 불러온다) ----------
  let extractor = null;
  function getExtractor(loadLib) {
    if (!extractor) {
      extractor = (async () => {
        const lib = await (loadLib ? loadLib() : import(LIB_URL));
        return lib.pipeline('feature-extraction', MODEL, { dtype: 'q8' });
      })();
      extractor.catch(() => { extractor = null; }); // 실패하면 다음에 다시 시도할 수 있게
    }
    return extractor;
  }

  // 결과: { model, text, vec, sentences: [{ text, vec }] }. vec은 encode된 문자열.
  async function embedIntro(text, loadLib) {
    const sentences = splitSentences(text);
    const ex = await getExtractor(loadLib);
    const out = await ex([text, ...sentences].map((t) => PREFIX + t), { pooling: 'mean', normalize: true });
    const [whole, ...parts] = out.tolist().map(encode);
    return { model: MODEL, text, vec: whole, sentences: sentences.map((s, i) => ({ text: s, vec: parts[i] })) };
  }

  const IntroEmbed = { MODEL, PREFIX, LIB_URL, splitSentences, encode, decode, similarity, meanOf, fingerprint, embedIntro };
  root.IntroEmbed = IntroEmbed;
  if (typeof module === 'object' && module.exports) module.exports = IntroEmbed;
})(typeof window !== 'undefined' ? window : globalThis);
