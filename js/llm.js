// LLM 호출을 한곳에 모은 연결 층. 채팅·안전 검사·대화 도우미는 이 파일의 complete()만 부른다.
// - claude: 공식 SDK를 CDN에서 불러와 브라우저에서 바로 호출 (키는 사용자 브라우저에 저장)
// - ollama: 이 PC의 Ollama /api/chat을 브라우저에서 바로 호출 (나만 쓸 때)
// - server: 인연노트 AI 서버(server/ai-server.mjs)를 거쳐 Ollama 호출 (방문자 모두가 쓸 때)
(function (root) {
  const SDK_URL = 'https://esm.sh/@anthropic-ai/sdk@0.129.0';
  const CLAUDE_MODEL = 'claude-opus-5-5';
  const OLLAMA_URL = 'http://localhost:11434';
  // 배포한 AI 서버 주소 (예: https://inyeon-ai.example.com). 넣어 두면 새 방문자는 처음부터 이 서버로 AI를 쓴다.
  const AI_SERVER_URL = '';
  const PROVIDERS = ['off', 'claude', 'ollama', 'server'];
  const DEFAULT_SETTINGS = { provider: AI_SERVER_URL ? 'server' : 'off', apiKey: '', ollamaUrl: OLLAMA_URL, ollamaModel: '', serverUrl: AI_SERVER_URL, serverKey: '' };

  let sdkPromise = null;
  const loadSdk = () => (sdkPromise = sdkPromise || import(SDK_URL).then((m) => m.default));

  // 저장된 설정을 정리한다. 예전 계정은 apiKey만 있었으므로 키가 있으면 claude로 본다.
  function normalize(saved, legacyKey) {
    const s = { ...DEFAULT_SETTINGS, ...(saved || {}) };
    if (!saved && legacyKey) Object.assign(s, { provider: 'claude', apiKey: legacyKey });
    if (!PROVIDERS.includes(s.provider)) s.provider = 'off';
    s.ollamaUrl = (s.ollamaUrl || OLLAMA_URL).trim().replace(/\/+$/, '');
    s.serverUrl = (s.serverUrl || AI_SERVER_URL).trim().replace(/\/+$/, '');
    return s;
  }

  // 지금 설정으로 AI를 쓸 수 있는지
  const ready = (s) => Boolean(s && ((s.provider === 'claude' && s.apiKey) || (s.provider === 'ollama' && s.ollamaModel) || (s.provider === 'server' && s.serverUrl)));
  const LABELS = { claude: () => `Claude(${CLAUDE_MODEL})`, ollama: (s) => `로컬 ${s.ollamaModel}`, server: () => '인연노트 AI 서버' };
  const label = (s) => (ready(s) ? LABELS[s.provider](s) : '');

  // 추론 모델이 답 앞에 붙이는 생각 과정은 버린다
  const clean = (text) => String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  async function claudeComplete(s, { system, messages, maxTokens }) {
    const Anthropic = await loadSdk();
    const client = new Anthropic({ apiKey: s.apiKey, dangerouslyAllowBrowser: true });
    try {
      const res = await client.beta.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: maxTokens || 2000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low' },
        system,
        messages,
      });
      if (res.stop_reason === 'refusal') return { text: '', refused: true };
      return { text: clean(res.content.filter((b) => b.type === 'text').map((b) => b.text).join('')) };
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new Error('API 키가 올바르지 않아요. 내 정보에서 키를 확인해 주세요.');
      if (e instanceof Anthropic.PermissionDeniedError) throw new Error('이 API 키로는 이 모델을 쓸 수 없어요.');
      if (e instanceof Anthropic.RateLimitError) throw new Error('요청이 많아요. 잠시 후 다시 시도해 주세요.');
      if (e instanceof Anthropic.BadRequestError) throw new Error(`요청 오류: ${e.message}`);
      if (e instanceof Anthropic.APIConnectionError) throw new Error('AI 서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.');
      if (e instanceof Anthropic.APIError) throw new Error(`AI 응답 오류 (${e.status})`);
      throw e;
    }
  }

  // fetch 실패(TypeError)는 Ollama가 꺼져 있거나 CORS로 막힌 경우다
  async function ollamaFetch(s, path, body) {
    let res;
    try {
      res = await fetch(`${s.ollamaUrl}${path}`, body ? { method: 'POST', body: JSON.stringify(body) } : undefined);
    } catch (e) {
      throw new Error(`Ollama(${s.ollamaUrl})에 연결하지 못했어요. Ollama가 켜져 있는지, OLLAMA_ORIGINS에 이 사이트 주소가 들어 있는지 확인해 주세요.`);
    }
    if (!res.ok) {
      const detail = await res.json().then((j) => j.error).catch(() => '');
      if (res.status === 404) throw new Error(`Ollama에 모델이 없어요${detail ? ` (${detail})` : ''}. 'ollama pull <모델명>'으로 받아 주세요.`);
      throw new Error(`Ollama 오류 (${res.status})${detail ? `: ${detail}` : ''}`);
    }
    return res.json();
  }

  // 생성 설정. 대화는 조금 자유롭게, 판단(JSON)은 차분하게. num_ctx를 늘려 긴 프롬프트와 대화 기록이 잘리지 않게 한다.
  const genOptions = (maxTokens, json) => ({
    num_predict: maxTokens || 512, num_ctx: 8192,
    temperature: json ? 0.3 : 0.8, top_p: 0.9, repeat_penalty: 1.1,
  });

  async function ollamaComplete(s, { system, messages, maxTokens, json }) {
    const body = {
      model: s.ollamaModel,
      stream: false,
      think: false, // Qwen3 같은 추론 모델이 답 전에 긴 생각을 쓰지 않게
      format: json ? 'json' : undefined,
      options: genOptions(maxTokens, json),
      messages: [{ role: 'system', content: system }, ...messages],
    };
    let data;
    try {
      data = await ollamaFetch(s, '/api/chat', body);
    } catch (e) {
      // 추론 기능이 없는 모델이 think 값을 거절하면 빼고 다시 묻는다
      if (!/think/i.test(e.message)) throw e;
      delete body.think;
      data = await ollamaFetch(s, '/api/chat', body);
    }
    return { text: clean(data.message && data.message.content) };
  }

  // ---------- 인연노트 AI 서버 ----------
  async function serverFetch(s, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (s.serverKey) headers.Authorization = `Bearer ${s.serverKey}`;
    let res;
    try {
      res = await fetch(`${s.serverUrl}${path}`, body ? { method: 'POST', headers, body: JSON.stringify(body) } : undefined);
    } catch (e) {
      throw new Error(`AI 서버(${s.serverUrl})에 연결하지 못했어요. 서버가 켜져 있는지, ALLOWED_ORIGINS에 이 사이트 주소가 들어 있는지 확인해 주세요.`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok && !(path === '/health' && data.model)) throw new Error(data.error || `AI 서버 오류 (${res.status})`);
    return data;
  }
  const serverComplete = (s, { system, messages, maxTokens, json }) => serverFetch(s, '/v1/complete', { system, messages, maxTokens, json }).then((d) => ({ text: clean(d.text) }));
  // 서버 상태: { ok, model, ollama: 'ok' | 'model-missing' | 'down' }
  const serverHealth = (url, key) => serverFetch(normalize({ serverUrl: url, serverKey: key }), '/health');

  // 한국어 대화를 잘하는 순서. 같은 대화 7턴으로 비교해 정했다 (EXAONE이 가장 자연스러웠고 llama3.1은 한국어가 무너졌다).
  // EXAONE은 비상업용 라이선스라 실제 서비스에는 다른 모델이나 Claude를 쓴다.
  const KOREAN_RANK = [/exaone/i, /gemma3/i, /qwen2\.5/i, /qwen3/i, /llama/i];
  const rankOf = (name) => { const i = KOREAN_RANK.findIndex((re) => re.test(name)); return i < 0 ? KOREAN_RANK.length : i; };
  const preferredModel = (models) => models.slice().sort((a, b) => rankOf(a) - rankOf(b))[0] || '';
  const isRecommended = (name) => rankOf(name) === 0;

  // 대화용 모델만 고른다 (bge-m3 같은 임베딩 전용 모델은 뺀다)
  async function listOllamaModels(url) {
    const { models } = await ollamaFetch(normalize({ ollamaUrl: url }), '/api/tags');
    return (models || [])
      .filter((m) => (m.capabilities ? m.capabilities.includes('completion') : !/embed|bge|minilm/i.test(m.name)))
      .map((m) => m.name);
  }

  // messages는 Messages API 형식({ role, content }), 첫 메시지는 user여야 한다.
  // json: true면 JSON 한 덩어리로 답하게 한다 (Ollama는 format으로 강제, Claude는 프롬프트로 요청).
  async function complete(s, req) {
    if (!ready(s)) throw new Error('AI 설정이 꺼져 있어요.');
    const run = { claude: claudeComplete, ollama: ollamaComplete, server: serverComplete }[s.provider];
    return run(s, req);
  }

  // 모델이 JSON 앞뒤에 말을 덧붙여도 첫 { … } 덩어리를 꺼낸다
  function parseJson(text) {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch (e) { return null; }
  }

  const LLM = { complete, parseJson, listOllamaModels, preferredModel, isRecommended, serverHealth, normalize, ready, label, clean, CLAUDE_MODEL, OLLAMA_URL, AI_SERVER_URL, DEFAULT_SETTINGS };
  root.LLM = LLM;
  if (typeof module === 'object' && module.exports) module.exports = LLM;
})(typeof window !== 'undefined' ? window : globalThis);
