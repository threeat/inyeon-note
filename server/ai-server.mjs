// 인연노트 AI 서버: 로컬 Ollama 앞에 두는 작은 API 서버. 외부 라이브러리 없이 Node만으로 돈다.
// Ollama를 그대로 인터넷에 열면 누구나 모델을 받거나 지울 수 있어서(/api/pull, /api/delete),
// 이 서버는 "정해진 모델로 답장 만들기" 하나만 열어 준다.
//
//   POST /v1/complete  { system, messages: [{ role, content }], maxTokens?, json? } → { text }
//   GET  /health       → { ok, model, ollama }
//
// 실행: npm run ai-server   (설정은 환경변수, 아래 CONFIG 참고)
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const env = process.env;
export const CONFIG = {
  port: Number(env.PORT || 8787),
  // 이 PC 안에서만 받는다. 인터넷에는 Cloudflare Tunnel로만 연다 (같은 와이파이의 다른 기기도 직접 못 들어온다).
  host: env.HOST || '127.0.0.1',
  ollamaUrl: (env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, ''),
  model: env.MODEL || 'llama3.1:8b',
  // 호출을 허용할 페이지 주소. 쉼표로 여러 개, 끝의 *는 아무 포트나 (예: http://localhost:*)
  origins: (env.ALLOWED_ORIGINS || 'http://localhost:*,http://127.0.0.1:*').split(',').map((s) => s.trim()).filter(Boolean),
  accessKey: env.ACCESS_KEY || '',          // 넣으면 Authorization: Bearer <키>가 있어야 한다
  perMinute: Number(env.RATE_LIMIT || 20),  // IP 하나가 1분에 보낼 수 있는 요청 수
  globalPerMinute: Number(env.GLOBAL_RATE_LIMIT || 120), // 모든 IP를 합쳐 1분에 받는 요청 수 (IP를 바꿔 가며 보내는 것도 막는다)
  maxQueue: Number(env.MAX_QUEUE || 8),     // Ollama는 한 번에 하나씩 답하므로 줄이 이보다 길면 거절한다
  timeoutMs: Number(env.TIMEOUT_MS || 120000),
  // Cloudflare Tunnel 뒤에서 돌릴 때만 1로. 그때는 모든 요청이 터널 프로그램(127.0.0.1)에서 오므로
  // 방문자 IP를 CF-Connecting-IP 헤더에서 읽는다. 터널 없이 이 헤더를 믿으면 누구나 IP를 속여 횟수 제한을 피한다.
  trustCfIp: env.TRUST_CF_IP === '1',
};

// 한 요청의 크기 제한. 소개팅 채팅에 필요한 만큼만 받는다.
export const LIMITS = { bodyBytes: 64 * 1024, systemChars: 6000, messages: 40, contentChars: 2000, maxTokens: 1024 };

const originAllowed = (origin, list) => list.some((o) => (o.endsWith(':*') ? origin.startsWith(o.slice(0, -1)) && /^\d+$/.test(origin.slice(o.length - 1)) : origin === o));
const clean = (text) => String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();

// 받은 요청이 정해진 모양인지 확인한다. 문제가 있으면 오류 문장, 없으면 Ollama에 보낼 본문.
export function validate(body, cfg = CONFIG) {
  if (!body || typeof body !== 'object') return { error: '요청 본문이 JSON 객체가 아니에요.' };
  const { system, messages, maxTokens, json } = body;
  if (typeof system !== 'string' || !system.trim()) return { error: 'system이 필요해요.' };
  if (system.length > LIMITS.systemChars) return { error: `system은 ${LIMITS.systemChars}자 이하여야 해요.` };
  if (!Array.isArray(messages) || !messages.length) return { error: 'messages가 필요해요.' };
  if (messages.length > LIMITS.messages) return { error: `messages는 ${LIMITS.messages}개 이하여야 해요.` };
  for (const m of messages) {
    if (!m || !['user', 'assistant'].includes(m.role)) return { error: "messages의 role은 'user' 또는 'assistant'여야 해요." };
    if (typeof m.content !== 'string' || m.content.length > LIMITS.contentChars) return { error: `메시지 하나는 ${LIMITS.contentChars}자 이하의 글이어야 해요.` };
  }
  const n = Math.min(Math.max(Number(maxTokens) || 512, 1), LIMITS.maxTokens);
  return {
    payload: {
      model: cfg.model, // 모델은 서버가 정한다. 요청으로 바꿀 수 없다.
      stream: false,
      think: false, // 추론 모델이 답 전에 긴 생각을 쓰지 않게 (지원하지 않는 모델이면 빼고 다시 묻는다)
      format: json ? 'json' : undefined,
      // 앱의 llm.js와 같은 설정: 대화는 조금 자유롭게, 판단(JSON)은 차분하게, 긴 대화 기록도 담기게
      options: { num_predict: n, num_ctx: 8192, temperature: json ? 0.3 : 0.8, top_p: 0.9, repeat_penalty: 1.1 },
      messages: [{ role: 'system', content: system }, ...messages.map(({ role, content }) => ({ role, content }))],
    },
  };
}

export function createAiServer(cfg = CONFIG) {
  const hits = new Map(); // IP → 최근 1분 안의 요청 시각들
  let running = 0;
  const waiting = [];
  const acquire = () => (running < 1 ? (running++, Promise.resolve()) : new Promise((r) => waiting.push(r)));
  const release = () => { const next = waiting.shift(); if (next) next(); else running--; };

  let all = [];
  let lastPrune = Date.now();
  // 넘었으면 오류 문장, 아니면 null
  const limited = (ip) => {
    const now = Date.now();
    const recent = (t) => now - t < 60000;
    if (now - lastPrune > 60000) { // 1분 넘게 조용한 IP의 기록은 지운다
      for (const [k, list] of hits) if (!list.some(recent)) hits.delete(k);
      lastPrune = now;
    }
    all = all.filter(recent);
    const list = (hits.get(ip) || []).filter(recent);
    if (list.length >= cfg.perMinute) return `요청이 너무 많아요. 1분에 ${cfg.perMinute}번까지 보낼 수 있어요.`;
    if (all.length >= cfg.globalPerMinute) return 'AI 서버가 바빠요. 잠시 후 다시 시도해 주세요.';
    list.push(now);
    all.push(now);
    hits.set(ip, list);
    return null;
  };

  async function callOllama(path, body) {
    const res = await fetch(`${cfg.ollamaUrl}${path}`, body
      ? { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(cfg.timeoutMs) }
      : { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      const detail = await res.json().then((j) => j.error).catch(() => '');
      throw Object.assign(new Error(`Ollama 오류 (${res.status})${detail ? `: ${detail}` : ''}`), { status: 502 });
    }
    return res.json();
  }

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const send = (status, data) => {
      const headers = { 'Content-Type': 'application/json; charset=utf-8', Vary: 'Origin', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      if (origin && originAllowed(origin, cfg.origins)) {
        Object.assign(headers, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
      }
      res.writeHead(status, headers);
      res.end(status === 204 ? undefined : JSON.stringify(data));
    };
    const url = new URL(req.url, 'http://x');
    // 브라우저가 보내는 Origin이 허용 목록에 없으면 거절한다 (Origin이 없는 curl 등은 아래 키·횟수 제한으로 막는다)
    if (origin && !originAllowed(origin, cfg.origins)) return send(403, { error: `허용하지 않은 사이트예요 (${origin}). ALLOWED_ORIGINS에 넣어 주세요.` });
    if (req.method === 'OPTIONS') return send(204);

    if (req.method === 'GET' && url.pathname === '/health') {
      const ollama = await callOllama('/api/tags').then(({ models }) => ((models || []).some((m) => m.name === cfg.model) ? 'ok' : 'model-missing'), () => 'down');
      return send(ollama === 'ok' ? 200 : 503, { ok: ollama === 'ok', model: cfg.model, ollama });
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/complete') return send(404, { error: '없는 주소예요. POST /v1/complete 또는 GET /health를 쓰세요.' });

    if (cfg.accessKey && req.headers.authorization !== `Bearer ${cfg.accessKey}`) return send(401, { error: '접근 키가 맞지 않아요.' });
    const ip = (cfg.trustCfIp && req.headers['cf-connecting-ip']) || req.socket.remoteAddress;
    const over = limited(ip);
    if (over) return send(429, { error: over });
    if (waiting.length >= cfg.maxQueue) return send(503, { error: 'AI 서버가 바빠요. 잠시 후 다시 시도해 주세요.' });

    let raw = '';
    try {
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > LIMITS.bodyBytes) return send(413, { error: '요청이 너무 커요.' });
      }
    } catch (e) { return send(400, { error: '요청을 읽지 못했어요.' }); }
    let body;
    try { body = JSON.parse(raw); } catch (e) { return send(400, { error: '요청 본문이 JSON이 아니에요.' }); }
    const checked = validate(body, cfg);
    if (checked.error) return send(400, { error: checked.error });

    await acquire();
    try {
      let data;
      try {
        data = await callOllama('/api/chat', checked.payload);
      } catch (e) {
        if (!/think/i.test(e.message)) throw e;
        delete checked.payload.think;
        data = await callOllama('/api/chat', checked.payload);
      }
      send(200, { text: clean(data.message && data.message.content) });
    } catch (e) {
      const timeout = e.name === 'TimeoutError';
      send(timeout ? 504 : e.status || 502, { error: timeout ? 'AI 답장이 너무 오래 걸려요.' : e.status ? e.message : 'Ollama에 연결하지 못했어요. Ollama가 켜져 있는지 확인해 주세요.' });
    } finally { release(); }
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  createAiServer().listen(CONFIG.port, CONFIG.host, () => {
    console.log(`인연노트 AI 서버: http://${CONFIG.host}:${CONFIG.port}  (모델 ${CONFIG.model}, Ollama ${CONFIG.ollamaUrl})`);
    console.log(`허용한 사이트: ${CONFIG.origins.join(', ')}${CONFIG.accessKey ? ' · 접근 키 사용' : ''} · 1분에 IP당 ${CONFIG.perMinute}번, 전체 ${CONFIG.globalPerMinute}번`);
  });
}
