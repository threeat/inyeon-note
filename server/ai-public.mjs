// AI 서버를 켜고 Cloudflare Quick Tunnel로 인터넷 https 주소를 받는다. 무료이고 가입이 필요 없다.
// 터널은 이 PC에서 Cloudflare로 나가는 연결이라 공유기 포트를 열지 않고, 집 IP도 드러나지 않는다.
// 실행: npm run ai-public   (끄기: Ctrl+C. 끄면 주소도 사라지고, 다시 켜면 새 주소가 나온다)
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { CONFIG, createAiServer } from './ai-server.mjs';

// GitHub Pages 주소. 다른 사이트에서도 부르게 하려면 ALLOWED_ORIGINS 환경변수로 바꾼다.
const SITE = 'https://threeat.github.io';
const cfg = {
  ...CONFIG,
  host: '127.0.0.1',  // 터널만 들어올 수 있게
  trustCfIp: true,    // 방문자 IP는 Cloudflare가 붙여 주는 헤더로 읽는다
  origins: process.env.ALLOWED_ORIGINS ? CONFIG.origins : [...CONFIG.origins, SITE],
};

const CLOUDFLARED = ['C:/Program Files (x86)/cloudflared/cloudflared.exe', 'C:/Program Files/cloudflared/cloudflared.exe'].find(existsSync) || 'cloudflared';

// Ollama와 모델부터 확인한다. 안 되면 주소를 열어도 소용없다.
try {
  const { models } = await (await fetch(`${cfg.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5000) })).json();
  if (!models.some((m) => m.name === cfg.model)) {
    console.error(`Ollama에 ${cfg.model} 모델이 없어요. 'ollama pull ${cfg.model}'로 받아 주세요.`);
    process.exit(1);
  }
} catch (e) {
  console.error(`Ollama(${cfg.ollamaUrl})에 연결하지 못했어요. Ollama를 먼저 켜 주세요.`);
  process.exit(1);
}

// Windows는 다른 프로그램이 같은 포트를 모든 주소로 쓰고 있어도 127.0.0.1로 또 열 수 있다.
// 그러면 예전 서버가 와이파이 쪽으로 계속 열려 있게 되므로, 이미 무언가 답하면 멈춘다.
const taken = await fetch(`http://127.0.0.1:${cfg.port}/health`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
if (taken) {
  console.error(`${cfg.port}번 포트에서 이미 다른 서버가 돌고 있어요. 켜 둔 AI 서버(npm run ai-server)를 끄고 다시 실행해 주세요.`);
  process.exit(1);
}

const server = createAiServer(cfg);
await new Promise((resolve, reject) => server.once('error', reject).listen(cfg.port, cfg.host, resolve)).catch((e) => {
  console.error(e.code === 'EADDRINUSE' ? `${cfg.port}번 포트를 이미 쓰고 있어요. 켜 둔 AI 서버를 끄거나 PORT를 바꿔 주세요.` : e.message);
  process.exit(1);
});
console.log(`AI 서버 켜짐: http://${cfg.host}:${cfg.port} (모델 ${cfg.model})`);
console.log(`허용한 사이트: ${cfg.origins.join(', ')}`);
console.log(`1분에 IP당 ${cfg.perMinute}번, 전체 ${cfg.globalPerMinute}번까지 받아요. 대화 내용은 저장하거나 기록하지 않아요.`);
console.log('Cloudflare 터널 여는 중…');

const tunnel = spawn(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--url', `http://${cfg.host}:${cfg.port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
let announced = false;
const watch = (chunk) => {
  const m = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (!m || announced) return;
  announced = true;
  console.log('');
  console.log(`  공개 주소: ${m[0]}`);
  console.log('');
  console.log("  앱의 '내 정보 → AI 대화 설정 → AI 서버'에 이 주소를 넣으세요.");
  console.log('  이 창을 닫거나 PC가 꺼지면 방문자는 기본 대화로 돌아가요.');
};
tunnel.stdout.on('data', watch);
tunnel.stderr.on('data', watch);
tunnel.on('error', () => {
  console.error("cloudflared를 찾지 못했어요. 'winget install Cloudflare.cloudflared'로 설치해 주세요.");
  process.exit(1);
});
tunnel.on('exit', (code) => {
  console.error(`Cloudflare 터널이 닫혔어요 (코드 ${code}).`);
  server.close();
  process.exit(code || 0);
});
const stop = () => { tunnel.kill(); server.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
