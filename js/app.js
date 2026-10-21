// 화면 코드: 가입 → 매칭 분석 → 오늘의 추천 / 프로필 상세 / 매칭 리포트 / 내 정보.
// 추천 로직은 matcher.js에 있고, 여기서는 그 결과를 그리기만 한다.
(function () {
  const { OPTIONS, SCORE_RULES, FILTER_RULES, TIE_BREAK } = window.Rules;
  // 서버가 없는 데모라 계정은 이 브라우저의 localStorage에만 저장한다. 비밀번호는 PBKDF2 해시로만 보관.
  const ACCOUNTS_KEY = 'inyeon-note.accounts';
  const SESSION_KEY = 'inyeon-note.session';

  const DEFAULT_ME = {
    id: 'me', name: '', gender: '남성', orientation: '이성애자', orientationPublic: true, marital: '미혼', age: 28, height: 178, region: '서울', religion: '무교',
    smoker: false, drinking: '가끔', style: '단정한', marriage: '1~2년 내', interests: ['등산', '요리', '영화'],
    interestDetails: { 등산: ['근교 산'], 요리: ['한식'], 영화: ['로맨스'] },
    job: '', edu: '대졸', intro: '', prompts: [],
  };
  const DEFAULT_PREFS = {
    ageMin: 24, ageMax: 31, heightMin: 155, heightMax: 175, styles: ['귀여운', '단정한'],
    filters: Object.fromEntries(FILTER_RULES.filter((f) => !f.always).map((f) => [f.key, f.defaultOn])),
  };

  const state = {
    account: null,     // 로그인한 이메일
    me: null, prefs: null, likes: [],
    matches: [], chats: {}, // 매칭된 회원 id, 회원별 대화
    likeNotes: {},     // 관심과 함께 남긴 한마디: { 회원 id: { target, label, quote, text, at } }
    dateFeedback: {},  // 만남 후기: { 회원 id: { verdict, reason, changes, before, at } } 또는 { verdict: 'later', askAt } / { verdict: 'never' }
    ai: window.LLM.normalize(), // AI 설정: 끄기 / Claude / 로컬 Ollama (llm.js)
    chatId: null, chatDraft: '', typing: false, matchModal: null,
    chatWarn: null,   // 보내기 전에 안전 안내를 띄운 문장. 같은 문장을 한 번 더 보내면 그대로 보낸다
    starters: null,   // 대화 시작 추천: { id, list, loading, byAi }
    noteDraft: null,  // 프로필 상세에서 쓰는 한마디: { id, target, text, warned }
    consult: { text: '', loading: false, result: null, undo: null }, // AI 중매 상담
    coachAi: { loading: false, result: null, error: '' },            // AI 프로필 코치
    dateIdeas: false, // 채팅방의 데이트 제안 열림 여부
    notMetFor: null,  // '아니었어요'를 눌러 이유를 고르는 중인 회원 id
    screen: 'welcome', // welcome | login | signup | analyzing | main
    tab: 'home',       // home | report | me
    step: 0, draft: null, returnTab: null,
    detailId: null,
    login: { email: '', pw: '' },
  };

  // ---------- 계정과 저장 (저장소를 못 써도 앱은 동작) ----------
  function readAccounts() {
    try { return JSON.parse(localStorage.getItem(ACCOUNTS_KEY)) || {}; } catch (e) { return {}; }
  }
  function writeAccounts(accounts) {
    try { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts)); return true; } catch (e) { return false; }
  }
  function setSession(email) {
    try { if (email) localStorage.setItem(SESSION_KEY, email); else localStorage.removeItem(SESSION_KEY); } catch (e) { /* 무시 */ }
  }
  function applyAccountData(email, data) {
    // 성적 지향이 생기기 전에 저장된 정보도 열리도록 기본값을 채운다
    const me = { orientation: '이성애자', orientationPublic: true, marital: '미혼', interestDetails: {}, prompts: [], ...data.me };
    const prefs = { ...data.prefs, filters: { ...DEFAULT_PREFS.filters, ...data.prefs.filters } };
    Object.assign(state, { account: email, me, prefs, likes: data.likes || [],
      matches: data.matches || [], chats: data.chats || {}, ai: window.LLM.normalize(data.ai, data.apiKey),
      likeNotes: data.likeNotes || {}, dateFeedback: data.dateFeedback || {} });
  }
  function load() {
    let email = null;
    try { email = localStorage.getItem(SESSION_KEY); } catch (e) { /* 무시 */ }
    const acc = email && readAccounts()[email];
    if (acc && acc.data) {
      applyAccountData(email, acc.data);
      state.screen = 'main';
    }
  }
  function save() {
    if (!state.account) return true;
    const accounts = readAccounts();
    if (!accounts[state.account]) return false;
    accounts[state.account].data = { me: state.me, prefs: state.prefs, likes: state.likes,
      matches: state.matches, chats: state.chats, ai: state.ai, likeNotes: state.likeNotes, dateFeedback: state.dateFeedback };
    const ok = writeAccounts(accounts);
    if (!ok) toast('저장 공간이 부족해 저장하지 못했어요. 더 작은 사진을 써 보세요.');
    return ok;
  }

  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  async function hashPassword(pw, salt) {
    if (!window.crypto || !crypto.subtle) throw new Error('이 브라우저에서는 로그인 기능을 쓸 수 없어요. (https 또는 파일로 열어 주세요)');
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256);
    return hex(bits);
  }
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const normEmail = (e) => e.trim().toLowerCase();

  async function login(email, pw) {
    const acc = readAccounts()[normEmail(email)];
    if (!acc || (await hashPassword(pw, acc.salt)) !== acc.hash) return '이메일 또는 비밀번호가 맞지 않아요.';
    setSession(acc.email);
    applyAccountData(acc.email, acc.data);
    return null;
  }
  function logout() {
    setSession(null);
    go({ account: null, me: null, prefs: null, likes: [], matches: [], chats: {}, ai: window.LLM.normalize(), chatId: null, chatDraft: '', matchModal: null,
      chatWarn: null, starters: null, likeNotes: {}, dateFeedback: {}, noteDraft: null, dateIdeas: false, notMetFor: null,
      consult: { text: '', loading: false, result: null, undo: null }, coachAi: { loading: false, result: null, error: '' },
      screen: 'welcome', tab: 'home', detailId: null, login: { email: '', pw: '' } });
  }
  function deleteAccount() {
    const accounts = readAccounts();
    delete accounts[state.account];
    writeAccounts(accounts);
    logout();
    toast('계정을 삭제했어요.');
  }

  // 올린 사진을 4:5로 가운데 잘라 작게 줄인다 (localStorage 용량 때문)
  function loadPhoto(file) {
    return new Promise((resolve, reject) => {
      if (!file.type.startsWith('image/')) { reject(new Error('이미지 파일만 올릴 수 있어요.')); return; }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const W = 480, H = 600;
        const scale = Math.max(W / img.width, H / img.height);
        const w = img.width * scale, h = img.height * scale;
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('사진을 읽지 못했어요. 다른 사진을 골라 주세요.')); };
      img.src = url;
    });
  }
  function pickPhoto(onDone) {
    const input = el('input', { type: 'file', accept: 'image/*' });
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try { onDone(await loadPhoto(file)); } catch (e) { toast(e.message); }
    });
    input.click();
  }

  // ---------- DOM 도우미 ----------
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'style') node.style.cssText = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    });
    children.flat().forEach((c) => {
      if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
    });
    return node;
  }
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const go = (patch) => { Object.assign(state, patch); window.scrollTo(0, 0); render(); };

  // ---------- 움직임 ----------
  // 무언가 바뀔 때마다 화면 전체를 다시 그리므로, 움직임은 화면이 처음 열릴 때(.enter)와 처음 보는 것에만 붙인다.
  // 운영체제에서 '동작 줄이기'를 켰으면 CSS가 모든 움직임을 끄고, 숫자 올리기도 하지 않는다.
  const calm = () => Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const seenOnce = new Set();
  const fresh = (key) => !seenOnce.has(key) && Boolean(seenOnce.add(key));
  const seenMsgs = {}; // 채팅방별로 이미 보여 준 메시지 수
  let lastView = null;
  // 점수 숫자를 0부터 올린다 (점수 원 채우기는 CSS가 맡는다). delay 동안은 0으로 기다린다.
  function countUp(root, selector = '.ring b', delay = 0, duration = 900) {
    root.querySelectorAll(selector).forEach((b) => {
      const to = Number(b.textContent);
      if (!Number.isFinite(to)) return;
      const start = performance.now() + delay;
      const tick = (t) => {
        if (!b.isConnected) return;
        const k = Math.min(Math.max((t - start) / duration, 0), 1);
        b.textContent = String(Math.round(to * (1 - Math.pow(1 - k, 3))));
        if (k < 1) requestAnimationFrame(tick);
      };
      b.textContent = '0';
      requestAnimationFrame(tick);
    });
  }

  // 매칭 순간의 꽃가루: 두 사진이 부딪히는 순간(0.7초)에 하트와 종이 조각이 터져 흩날린다
  const drawHeart = (ctx, s) => {
    ctx.beginPath();
    ctx.moveTo(0, s * 0.35);
    ctx.bezierCurveTo(-s * 0.7, -s * 0.1, -s * 0.35, -s * 0.65, 0, -s * 0.25);
    ctx.bezierCurveTo(s * 0.35, -s * 0.65, s * 0.7, -s * 0.1, 0, s * 0.35);
    ctx.fill();
  };
  function launchConfetti(canvas) {
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    const colors = ['--brand', '--brand-2', '--c-looks', '--c-marriage'].map((v) => css.getPropertyValue(v).trim()).concat(['#ffffff', '#ffd6e0']);
    const cx = W / 2;
    const cy = Math.min(H * 0.42, 360);
    const parts = Array.from({ length: 120 }, (_, i) => {
      const angle = Math.random() * Math.PI * 2;
      const speed = 4 + Math.random() * 11;
      return { x: cx, y: cy, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 5, g: 0.22 + Math.random() * 0.12,
        s: 6 + Math.random() * 9, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3, c: colors[i % colors.length], heart: i % 3 === 0 };
    });
    const start = performance.now() + 700;
    const tick = (t) => {
      if (!canvas.isConnected) return;
      if (t >= start) {
        const k = (t - start) / 2800;
        ctx.clearRect(0, 0, W, H);
        parts.forEach((q) => {
          q.vx *= 0.985;
          q.vy = q.vy * 0.985 + q.g;
          q.x += q.vx + Math.sin((t - start) / 260 + q.r) * 0.6; // 살랑살랑 흔들리며 떨어진다
          q.y += q.vy;
          q.r += q.vr;
          ctx.save();
          ctx.globalAlpha = Math.max(0, 1 - k * k);
          ctx.translate(q.x, q.y);
          ctx.rotate(q.r);
          ctx.fillStyle = q.c;
          if (q.heart) drawHeart(ctx, q.s); else ctx.fillRect(-q.s / 2, -q.s / 4, q.s, q.s / 2);
          ctx.restore();
        });
        if (k >= 1) { ctx.clearRect(0, 0, W, H); return; }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  // 프로필 사진. 사진이 없으면(내 프로필) 그라데이션 아바타로 대신한다.
  const PALETTES = [['#f7a8b8', '#e86a8f'], ['#ffc49b', '#f2876b'], ['#b8c6ff', '#7d8ff0'], ['#a8e6cf', '#4fb38a'],
    ['#d7b8ff', '#9a6be0'], ['#ffd59e', '#e8a33d'], ['#9fd8f0', '#4a9fc9'], ['#f0b8d8', '#c9609a']];
  function photo(p, size) {
    if (p.photo) return el('div', { class: `photo ${size || ''}` }, el('img', { src: p.photo, alt: '', draggable: 'false' }));
    const n = [...p.id].reduce((s, c) => s + c.charCodeAt(0), 0);
    const [a, b] = PALETTES[n % PALETTES.length];
    return el('div', { class: `photo ${size || ''}`, style: `background:linear-gradient(150deg,${a},${b})`, 'aria-hidden': 'true' },
      el('span', null, (p.name || '나')[0]));
  }
  const isLiked = (id) => state.likes.includes(id);
  const isMatched = (id) => state.matches.includes(id);
  const profileById = (id) => window.PROFILES.find((p) => p.id === id);

  // 관심 보내기 → 궁합 점수가 기준 이상이면 상대도 수락해 매칭되고, 상대가 먼저 인사를 보낸다.
  // note가 있으면(질문 카드·자기소개에 남긴 한마디) 기준이 낮아지고, 매칭되면 그 한마디가 첫 메시지가 된다.
  function toggleLike(p, note) {
    if (isMatched(p.id)) { openChat(p.id); return; }
    if (isLiked(p.id)) {
      state.likes = state.likes.filter((x) => x !== p.id);
      delete state.likeNotes[p.id];
      save();
      toast(`${p.name}님에게 보낸 관심을 취소했어요`);
      render();
      return;
    }
    state.likes = [...state.likes, p.id];
    if (note) state.likeNotes[p.id] = { ...note, at: Date.now() };
    state.noteDraft = null;
    const scored = compute().ranked.find((r) => r.profile.id === p.id);
    const result = scored ? window.Matcher.matchResult(scored, { withNote: Boolean(note) }) : { matched: false, reason: '' };
    if (result.matched) {
      state.matches = [...state.matches, p.id];
      const now = Date.now();
      state.chats[p.id] = [
        { from: 'system', text: `💕 매칭 성공! ${result.reason}`, at: now },
        note ? { from: 'me', text: note.text, quote: { label: note.label, text: note.quote }, at: now } : null,
        { from: 'them', text: window.Chat.greeting(p, state.me, note), at: now },
      ].filter(Boolean);
      state.matchModal = { id: p.id, reason: result.reason, total: scored.total };
    } else {
      toast(`${p.name}님에게 관심을 보냈어요. ${result.reason}`);
    }
    save();
    render();
  }

  function openWeights() {
    go({ screen: 'main', tab: 'report', detailId: null, chatId: null });
    const box = document.getElementById('weights');
    if (box) box.scrollIntoView({ block: 'start' });
  }

  function openChat(id) { go({ screen: 'main', tab: 'chat', detailId: null, chatId: id, matchModal: null, chatDraft: '', chatWarn: null, starters: null, dateIdeas: false, notMetFor: null }); }

  // ---------- 자기소개 분석 (임베딩) ----------
  // 내 소개글은 브라우저에서 AI 모델로 계산한다. 처음 한 번은 모델 파일을 내려받느라 시간이 걸리고,
  // 그동안은 자기소개 항목을 빼고 나머지 항목으로 추천한다. 결과는 계정에 저장해 다시 계산하지 않는다.
  const introJob = { status: 'idle', text: null, error: '' }; // idle | loading | failed
  function ensureIntroEmbedding() {
    const { me, account } = state;
    const text = ((me && me.intro) || '').trim();
    if (!text || window.Matcher.introOf(me)) return;
    if (introJob.text === text && introJob.status !== 'idle') return; // 계산 중이거나 실패함 (실패는 '다시 시도'로만)
    Object.assign(introJob, { status: 'loading', text, error: '' });
    window.IntroEmbed.embedIntro(text).then((embedding) => {
      if (introJob.text !== text) return; // 그사이 소개를 고쳤으면 버린다
      introJob.status = 'idle';
      if (state.account !== account || ((state.me && state.me.intro) || '').trim() !== text) return;
      state.me.introEmbedding = embedding;
      save();
      toast('자기소개 분석이 끝나 추천 점수에 반영했어요.');
      if (state.screen === 'main') render();
    }, (e) => {
      if (introJob.text !== text) return;
      Object.assign(introJob, { status: 'failed', error: e.message || String(e) });
      if (state.screen === 'main') render();
    });
  }
  function retryIntro() {
    introJob.status = 'idle';
    ensureIntroEmbedding();
    render();
  }
  // 자기소개 항목이 지금 점수에 빠져 있다면 그 이유와 할 일을 알려 준다
  function introStatus(returnTab) {
    const text = (state.me.intro || '').trim();
    if (text && window.Matcher.introOf(state.me)) return null;
    if (!text) {
      return el('p', { class: 'intro-status' }, '자기소개를 쓰면 하루와 데이트 취향이 닮은 분을 더 잘 찾아요.',
        el('button', { class: 'link', onclick: () => startSignup('intro', returnTab) }, '자기소개 쓰기 ›'));
    }
    if (introJob.status === 'failed') {
      return el('p', { class: 'intro-status failed' }, `자기소개를 분석하지 못해 이 항목은 빼고 추천했어요. (${introJob.error})`,
        el('button', { class: 'link', onclick: retryIntro }, '다시 시도'));
    }
    return el('p', { class: 'intro-status', role: 'status' },
      '자기소개를 AI로 분석하는 중이에요. 처음 한 번은 모델 파일(약 135MB)을 내려받아 시간이 걸려요. 끝나면 점수에 바로 반영돼요.');
  }

  // ---------- 가입 단계 입력 부품 ----------
  function field(label, control, hint) {
    return el('div', { class: 'field' }, el('label', { class: 'field-label' }, label), control, hint ? el('p', { class: 'field-hint' }, hint) : null);
  }
  function textInput(obj, key, placeholder, max) {
    return el('input', { type: 'text', value: obj[key] || '', placeholder, maxlength: max || 20,
      oninput: (e) => { obj[key] = e.target.value; } });
  }
  function textArea(obj, key, placeholder, max, onChange) {
    return el('textarea', { placeholder, maxlength: max, rows: 5,
      oninput: (e) => { obj[key] = e.target.value; if (onChange) onChange(e.target.value); } }, obj[key] || '');
  }
  function numberInput(obj, key, min, max, unit) {
    return el('div', { class: 'num-input' },
      el('input', { type: 'number', inputmode: 'numeric', min, max, value: obj[key],
        oninput: (e) => { const v = parseInt(e.target.value, 10); if (Number.isFinite(v)) obj[key] = v; } }),
      el('span', null, unit));
  }
  function select(obj, key, values) {
    const s = el('select', { onchange: (e) => { obj[key] = e.target.value; } }, values.map((v) => el('option', { value: v }, v)));
    s.value = obj[key];
    return s;
  }
  // 하나만 고르는 버튼 묶음
  function segmented(obj, key, values, labels) {
    return el('div', { class: 'segmented', role: 'radiogroup' }, values.map((v, i) =>
      el('button', { type: 'button', role: 'radio', 'aria-checked': String(obj[key] === v), class: obj[key] === v ? 'on' : '',
        onclick: () => { obj[key] = v; render(); } }, labels ? labels[i] : v)));
  }
  // 여러 개 고르는 칩
  function chips(list, values, cls) {
    return el('div', { class: `chips ${cls || ''}` }, values.map((v) =>
      el('button', { type: 'button', 'aria-pressed': String(list.includes(v)), class: `chip ${list.includes(v) ? 'on' : ''}`,
        onclick: () => {
          const i = list.indexOf(v);
          if (i >= 0) list.splice(i, 1); else list.push(v);
          render();
        } }, v)));
  }
  function rangeInputs(obj, minKey, maxKey, lo, hi, unit) {
    return el('div', { class: 'range-row' }, numberInput(obj, minKey, lo, hi, unit), el('span', { class: 'tilde' }, '~'), numberInput(obj, maxKey, lo, hi, unit));
  }

  function switchRow(label, obj, key) {
    return el('label', { class: 'switch-row' },
      el('span', null, label),
      el('input', { type: 'checkbox', role: 'switch', checked: obj[key], onchange: (e) => { obj[key] = e.target.checked; } }),
      el('i', { class: 'switch', 'aria-hidden': 'true' }));
  }

  // 성별·지향으로 정해지는 "만나게 될 분" 설명
  function whoText(me) {
    const genders = window.Matcher.interestedIn(me);
    const who = genders.length > 1 ? '여성과 남성 모두 만나요.' : `${genders[0]}을 만나요.`;
    return `${who} 상대도 ${me.gender}에게 관심이 있는 분이어야 해요.`;
  }
  const detailsOf = (person, c) => (person.interestDetails && person.interestDetails[c]) || [];
  const sameDetails = (me, p, c) => detailsOf(p, c).filter((d) => detailsOf(me, c).includes(d));
  const mutual = (me, p) => window.Matcher.interestedIn(me).includes(p.gender) && window.Matcher.interestedIn(p).includes(me.gender);
  const orientationText = (p) => (p.orientationPublic === false ? '비공개' : p.orientation);

  function passwordInput(obj, key, placeholder, autocomplete) {
    return el('input', { type: 'password', value: obj[key] || '', placeholder, autocomplete, maxlength: 64,
      oninput: (e) => { obj[key] = e.target.value; } });
  }

  // 사진 고르기: 미리보기 + 선택/삭제 버튼
  function photoPicker(me) {
    return el('div', { class: 'photo-picker' },
      el('button', { type: 'button', class: 'pp-frame', 'aria-label': '프로필 사진 선택', onclick: () => pickPhoto((url) => { me.photo = url; render(); }) },
        me.photo ? photo(me, 'pick') : el('span', { class: 'pp-empty' }, el('b', null, '+'), '사진 추가')),
      el('div', { class: 'pp-actions' },
        el('button', { type: 'button', class: 'btn ghost sm', onclick: () => pickPhoto((url) => { me.photo = url; render(); }) }, me.photo ? '다른 사진으로 바꾸기' : '앨범에서 선택'),
        me.photo ? el('button', { type: 'button', class: 'link', onclick: () => { delete me.photo; render(); } }, '사진 삭제') : null),
      el('p', { class: 'field-hint' }, '얼굴이 잘 보이는 사진을 추천해요. 사진은 4:5 비율로 잘려서 이 브라우저에만 저장돼요.'));
  }

  // ---------- 가입 단계 정의 ----------
  // key로 단계를 찾는다. account 단계는 처음 가입할 때만 보인다.
  const STEPS = [
    {
      key: 'account',
      title: '계정을\n만들어 주세요',
      sub: '다음에 이 이메일과 비밀번호로 로그인해서 이어서 쓸 수 있어요.',
      body: ({ account }) => [
        field('이메일', el('input', { type: 'email', value: account.email, placeholder: 'name@example.com', autocomplete: 'email',
          oninput: (e) => { account.email = e.target.value; } })),
        field('비밀번호', passwordInput(account, 'pw', '6자 이상', 'new-password')),
        field('비밀번호 확인', passwordInput(account, 'pw2', '한 번 더 입력', 'new-password')),
      ],
      check: ({ account }) => {
        if (!EMAIL_RE.test(account.email.trim())) return '이메일 형식을 확인해 주세요.';
        if (readAccounts()[normEmail(account.email)]) return '이미 가입된 이메일이에요. 로그인해 주세요.';
        if (account.pw.length < 6) return '비밀번호는 6자 이상이어야 해요.';
        if (account.pw !== account.pw2) return '비밀번호가 서로 달라요.';
        return null;
      },
    },
    {
      key: 'basic',
      title: '반가워요!\n기본 정보를 알려주세요',
      body: ({ me }) => [
        field('이름(닉네임)', textInput(me, 'name', '예: 준석', 10)),
        field('성별', segmented(me, 'gender', OPTIONS.genders)),
        field('성적 지향', segmented(me, 'orientation', OPTIONS.orientations), whoText(me)),
        switchRow('프로필에 성적 지향 공개', me, 'orientationPublic'),
        el('div', { class: 'two' }, field('나이', numberInput(me, 'age', 19, 60, '세')), field('키', numberInput(me, 'height', 140, 210, 'cm'))),
        field('사는 지역', select(me, 'region', OPTIONS.regions)),
        el('div', { class: 'two' }, field('직업', textInput(me, 'job', '예: 개발자', 15)), field('학력', select(me, 'edu', ['고졸', '전문대졸', '대졸', '대학원졸', '대학 재학', '대학원 재학']))),
      ],
      check: ({ me }) => (!me.name.trim() ? '이름을 입력해 주세요.' : null),
    },
    {
      key: 'photo',
      title: '프로필 사진을\n올려 주세요',
      sub: '사진이 있으면 상대에게 더 믿음을 줘요. 건너뛰고 나중에 올려도 돼요.',
      body: ({ me }) => [photoPicker(me)],
    },
    {
      key: 'life',
      title: '생활 방식과\n가치관을 알려주세요',
      body: ({ me }) => [
        field('종교', segmented(me, 'religion', OPTIONS.religions)),
        field('흡연', segmented(me, 'smoker', [false, true], ['비흡연', '흡연'])),
        field('음주', segmented(me, 'drinking', OPTIONS.drinking)),
        field('결혼 계획', segmented(me, 'marriage', OPTIONS.marriage)),
        field('결혼 경험', segmented(me, 'marital', OPTIONS.marital), '프로필에 표시돼요. 상대가 돌싱인지로 거르고 싶다면 마지막 단계에서 \'돌싱이면 제외\'를 켜세요.'),
        field('나를 표현하는 스타일', segmented(me, 'style', OPTIONS.styles)),
      ],
    },
    {
      key: 'interests',
      title: '어떤 걸 좋아하세요?',
      sub: '공통 관심사는 매칭 점수에서 가장 크게 반영돼요. 세부 취향까지 고르면 더 잘 맞는 분을 찾아요.',
      body: ({ me }) => {
        me.interestDetails = me.interestDetails || {};
        // 관심사를 빼면 그 세부 취향도 지운다
        Object.keys(me.interestDetails).forEach((c) => { if (!me.interests.includes(c)) delete me.interestDetails[c]; });
        return [
          chips(me.interests, OPTIONS.interests),
          el('p', { class: 'count' }, `${me.interests.length}개 선택`),
          me.interests.length ? el('div', { class: 'details' },
            el('p', { class: 'field-label' }, '세부 취향 (선택)'),
            el('p', { class: 'field-hint' }, '같은 관심사에 세부 취향까지 겹치면 10점, 둘 다 골랐는데 다르면 6점이에요. 고르지 않으면 관심사만 같아도 10점.'),
            me.interests.map((c) => {
              if (!me.interestDetails[c]) me.interestDetails[c] = [];
              return el('div', { class: 'detail-group' },
                el('span', { class: 'dg-label' }, c),
                chips(me.interestDetails[c], OPTIONS.interestDetails[c] || [], 'sm'));
            })) : null,
        ];
      },
      check: ({ me }) => (!me.interests.length ? '관심사를 1개 이상 골라 주세요.' : null),
    },
    {
      key: 'intro',
      title: '나를 소개해\n주세요',
      sub: '쉬는 날 하는 일, 좋아하는 데이트를 2~3문장으로 써 주세요. AI가 뜻을 읽어 소개글이 닮은 분에게 점수를 더 줘요. 건너뛰어도 돼요.',
      body: ({ me }) => {
        const count = el('p', { class: 'count' }, `${(me.intro || '').length}/200자`);
        return [
          field('자기소개', textArea(me, 'intro', '예: 주말엔 근교 산에 올라요. 내려와서 맛집 찾아가는 게 낙이에요. 조용한 카페에서 이야기 나누는 데이트를 좋아해요.', 200,
            (v) => { count.textContent = `${v.length}/200자`; }), '같은 단어가 아니어도 뜻이 비슷하면 알아봐요. 소개글은 이 브라우저 안에서만 분석하고 밖으로 보내지 않아요.'),
          count,
        ];
      },
    },
    {
      key: 'prompts',
      title: '질문 카드에\n답해 주세요',
      sub: `마음에 드는 질문 ${window.Prompts.MAX_CARDS}개에 짧게 답해 주세요. 상대가 내 답에 한마디를 남기며 관심을 보낼 수 있어요. 건너뛰어도 돼요.`,
      body: ({ me }) => {
        // 편집하는 동안은 빈 칸도 두 칸 유지하고, 저장할 때 정리한다
        me.prompts = Array.isArray(me.prompts) ? me.prompts : [];
        while (me.prompts.length < window.Prompts.MAX_CARDS) me.prompts.push({ q: '', a: '' });
        return me.prompts.slice(0, window.Prompts.MAX_CARDS).map((card, i) => {
          const used = me.prompts.filter((c, j) => j !== i).map((c) => c.q);
          const pick = el('select', { 'aria-label': `질문 ${i + 1}`, onchange: (e) => { card.q = e.target.value; render(); } },
            el('option', { value: '' }, '질문 고르기'),
            window.Prompts.QUESTIONS.filter((q) => !used.includes(q.key)).map((q) => el('option', { value: q.key }, q.text)));
          pick.value = card.q;
          const count = el('p', { class: 'count' }, `${(card.a || '').length}/${window.Prompts.MAX_ANSWER}자`);
          return el('div', { class: 'prompt-edit' },
            field(`질문 카드 ${i + 1}`, pick),
            card.q ? el('textarea', { rows: 2, maxlength: window.Prompts.MAX_ANSWER, placeholder: '예: 둘레길 걷고 국밥 한 그릇',
              'aria-label': `질문 카드 ${i + 1} 답`, oninput: (e) => { card.a = e.target.value; count.textContent = `${e.target.value.length}/${window.Prompts.MAX_ANSWER}자`; } }, card.a || '') : null,
            card.q ? count : null);
        });
      },
    },
    {
      key: 'ideal',
      title: '어떤 분을\n만나고 싶으세요?',
      body: ({ me, prefs }) => [
        el('div', { class: 'notice-box' }, el('b', null, '🏳️‍🌈 만나게 될 분'), el('span', null, whoText(me)),
          el('small', null, '기본 정보에서 고른 성별과 성적 지향에 맞춰 자동으로 정해져요.')),
        field('희망 나이', rangeInputs(prefs, 'ageMin', 'ageMax', 19, 60, '세')),
        field('희망 키', rangeInputs(prefs, 'heightMin', 'heightMax', 140, 210, 'cm')),
        field('끌리는 스타일', chips(prefs.styles, OPTIONS.styles), `고른 스타일이면 외모 점수 ${SCORE_RULES.find((r) => r.key === 'looks').style}점`),
      ],
    },
    {
      key: 'filters',
      title: '이것만은\n절대 안 돼요',
      sub: '켠 조건에 걸리는 분은 점수를 매기기 전에 추천에서 빠져요. 나 자신과 다른 성별은 항상 빠집니다.',
      body: ({ prefs }) => FILTER_RULES.filter((f) => !f.always).map((f) => switchRow(f.toggle, prefs.filters, f.key)),
    },
  ];

  // 정보 수정(returnTab 있음)일 때는 계정 단계를 빼고 보여준다
  const stepsFor = (editing) => (editing ? STEPS.filter((s) => s.key !== 'account') : STEPS);

  function startSignup(key, returnTab) {
    const steps = stepsFor(Boolean(returnTab));
    const me = state.me ? clone(state.me) : clone(DEFAULT_ME);
    const prefs = state.prefs ? clone(state.prefs) : clone(DEFAULT_PREFS);
    const account = returnTab ? null : { email: '', pw: '', pw2: '' };
    go({ screen: 'signup', step: Math.max(0, steps.findIndex((s) => s.key === key)), draft: { me, prefs, account }, returnTab: returnTab || null });
  }

  async function finishSignup() {
    const { me, prefs, account } = state.draft;
    me.name = me.name.trim();
    me.intro = (me.intro || '').trim();
    me.prompts = window.Prompts.clean(me.prompts);
    if (me.introEmbedding && me.introEmbedding.text !== me.intro) delete me.introEmbedding; // 고친 소개는 다시 분석
    if (prefs.ageMin > prefs.ageMax) [prefs.ageMin, prefs.ageMax] = [prefs.ageMax, prefs.ageMin];
    if (prefs.heightMin > prefs.heightMax) [prefs.heightMin, prefs.heightMax] = [prefs.heightMax, prefs.heightMin];

    if (account) {
      // 새 계정 만들기. 비밀번호 원문은 저장하지 않는다.
      const email = normEmail(account.email);
      const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
      const accounts = readAccounts();
      accounts[email] = { email, salt, hash: await hashPassword(account.pw, salt), createdAt: new Date().toISOString(),
        data: { me, prefs, likes: [] } };
      if (!writeAccounts(accounts)) return '저장 공간이 부족해 가입하지 못했어요. 사진을 빼고 다시 시도해 주세요.';
      setSession(email);
      Object.assign(state, { account: email, me, prefs, likes: [], matches: [], chats: {}, ai: window.LLM.normalize(), likeNotes: {}, dateFeedback: {} });
    } else {
      const before = { me: state.me, prefs: state.prefs };
      Object.assign(state, { me, prefs });
      if (!save()) { Object.assign(state, before); return '저장 공간이 부족해 저장하지 못했어요. 더 작은 사진을 써 보세요.'; }
    }
    go({ screen: 'analyzing', draft: null });
    setTimeout(() => go({ screen: 'main', tab: 'home', detailId: null }), 1400);
    return null;
  }

  function renderSignup() {
    const editing = Boolean(state.returnTab);
    const steps = stepsFor(editing);
    const s = steps[state.step];
    const last = state.step === steps.length - 1;
    const err = el('p', { class: 'error', role: 'alert' });
    const back = () => {
      if (state.step > 0) go({ step: state.step - 1 });
      else if (editing) go({ screen: 'main', tab: state.returnTab, draft: null });
      else go({ screen: 'welcome', draft: null });
    };
    const nextBtn = el('button', { class: 'btn primary' }, last ? (editing ? '저장하고 다시 매칭' : '가입하고 매칭 시작') : (s.key === 'photo' && !state.draft.me.photo ? '나중에 할게요' : '다음'));
    nextBtn.addEventListener('click', async () => {
      const problem = s.check && s.check(state.draft);
      if (problem) { err.textContent = problem; return; }
      if (!last) { go({ step: state.step + 1 }); return; }
      nextBtn.disabled = true;
      try {
        const failed = await finishSignup();
        if (failed) err.textContent = failed;
      } catch (e) { err.textContent = e.message; }
      nextBtn.disabled = false;
    });
    return el('div', { class: 'screen signup' },
      el('header', { class: 'bar' },
        el('button', { class: 'icon-btn', 'aria-label': '뒤로', onclick: back }, '‹'),
        el('div', { class: 'progress', 'aria-label': `${state.step + 1} / ${steps.length} 단계` },
          el('i', { style: `width:${((state.step + 1) / steps.length) * 100}%` })),
        el('span', { class: 'step-no' }, `${state.step + 1}/${steps.length}`)),
      el('main', { class: 'content' },
        el('h1', { class: 'title' }, s.title),
        s.sub ? el('p', { class: 'sub' }, s.sub) : null,
        el('div', { class: 'fields' }, s.body(state.draft))),
      el('footer', { class: 'cta' }, err, nextBtn),
    );
  }

  // ---------- 로그인 ----------
  function renderLogin() {
    const f = state.login;
    const err = el('p', { class: 'error', role: 'alert' });
    const submit = el('button', { class: 'btn primary', type: 'submit' }, '로그인');
    const form = el('form', { class: 'fields', novalidate: true },
      field('이메일', el('input', { type: 'email', value: f.email, placeholder: 'name@example.com', autocomplete: 'email',
        oninput: (e) => { f.email = e.target.value; } })),
      field('비밀번호', passwordInput(f, 'pw', '비밀번호', 'current-password')),
      err, submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!f.email.trim() || !f.pw) { err.textContent = '이메일과 비밀번호를 입력해 주세요.'; return; }
      submit.disabled = true;
      try {
        const failed = await login(f.email, f.pw);
        if (failed) { err.textContent = failed; submit.disabled = false; return; }
        state.login = { email: '', pw: '' };
        toast(`${state.me.name}님, 다시 만나서 반가워요!`);
        go({ screen: 'main', tab: 'home', detailId: null });
      } catch (ex) { err.textContent = ex.message; submit.disabled = false; }
    });
    return el('div', { class: 'screen login' },
      el('header', { class: 'bar' }, el('button', { class: 'icon-btn', 'aria-label': '뒤로', onclick: () => go({ screen: 'welcome' }) }, '‹')),
      el('main', { class: 'content' },
        el('div', { class: 'logo' }, '♥'),
        el('h1', { class: 'title' }, '다시 오셨군요!\n로그인해 주세요'),
        form,
        el('p', { class: 'switch-auth' }, '아직 계정이 없나요? ',
          el('button', { class: 'link', onclick: () => startSignup('account') }, '무료로 가입하기'))));
  }

  // ---------- 시작 / 분석 화면 ----------
  function renderWelcome() {
    return el('div', { class: 'screen welcome' },
      el('div', { class: 'stack', 'aria-hidden': 'true' },
        ['f13', 'm01', 'f01'].map(profileById).filter(Boolean).map((p, i) => el('div', { class: `stack-card c${i}` }, photo(p, 'card'))),
        el('span', { class: 'stack-heart' }, '♥')),
      el('div', { class: 'hero' },
        el('div', { class: 'logo' }, '♥'),
        el('h1', null, '인연노트'),
        el('p', null, '조건이 아니라 ', el('b', null, '이유'), '로 만나는 소개팅'),
        el('ul', { class: 'promise' },
          el('li', null, '절대 안 되는 조건은 먼저 걸러요'),
          el('li', null, '무엇이 맞아서 몇 점인지 다 보여드려요'),
          el('li', null, '왜 이 사람이 1위인지 말해 드려요'),
          el('li', { class: 'pride' }, '이성애자·동성애자·양성애자 모두를 존중해요'))),
      el('footer', { class: 'cta' },
        el('p', { class: 'members' }, `지금 ${window.PROFILES.length}명의 회원이 기다리고 있어요`),
        el('button', { class: 'btn primary', onclick: () => startSignup('account') }, '무료로 시작하기'),
        el('button', { class: 'btn ghost login-btn', onclick: () => go({ screen: 'login' }) }, '이미 계정이 있어요 · 로그인')));
  }

  function renderAnalyzing() {
    const faces = window.PROFILES.filter((p) => mutual(state.me, p)).slice(0, 5);
    return el('div', { class: 'screen analyzing' },
      el('div', { class: 'pulse' }, '♥'),
      el('div', { class: 'face-stack', 'aria-hidden': 'true' }, faces.map((p) => photo(p, 'xs'))),
      el('h1', null, `${state.me.name}님과 맞는 분을 찾고 있어요`),
      el('p', null, `${window.PROFILES.length}명의 프로필에서 조건을 확인하고 점수를 매기는 중…`));
  }

  // ---------- 메인 ----------
  const compute = () => window.Matcher.recommend(state.me, state.prefs, window.PROFILES);

  function scoreRing(score, size) {
    return el('div', { class: `ring ${size || ''}`, style: `--p:${score}`, 'aria-label': `궁합 ${score}점` },
      el('b', null, score), el('small', null, '점'));
  }

  function likeButton(p, wide) {
    const matched = isMatched(p.id);
    const liked = isLiked(p.id);
    const cls = matched ? 'primary' : liked ? 'liked' : 'primary';
    const label = matched ? '💬 대화하기' : liked ? '♥ 관심 보냄 · 답을 기다리는 중' : '♡ 관심 보내기';
    return el('button', { class: `btn ${cls} ${wide ? '' : 'sm'}`, onclick: (e) => { e.stopPropagation(); toggleLike(p); } }, label);
  }

  function renderHome(result) {
    const passed = result.ranked.length;
    const today = new Date();
    const head = el('header', { class: 'page-head' },
      el('div', { class: 'top-row' },
        el('div', { class: 'brand' }, el('span', { class: 'brand-mark' }, '♥'), '인연노트'),
        el('button', { class: 'me-chip', 'aria-label': '내 정보', onclick: () => go({ tab: 'me' }) }, photo(state.me, 'xs'))),
      el('p', { class: 'date' }, `${today.getMonth() + 1}월 ${today.getDate()}일`),
      el('h1', null, '오늘의 추천'),
      el('p', { class: 'sub' }, passed
        ? `${state.me.name}님의 조건을 통과한 ${passed}명 중에서 궁합 점수 순으로 골랐어요.`
        : `${state.me.name}님의 조건을 통과한 분이 아직 없어요.`),
      el('button', { class: 'link weight-link', onclick: () => openWeights() }, '⚖ 항목별 중요도(가중치) 조절하기 ›'),
      introStatus('home'));

    if (!passed) {
      return [head, consultCard(), el('section', { class: 'card empty' },
        el('div', { class: 'empty-icon' }, '?'),
        el('h2', null, '조건에 맞는 분이 0명이에요'),
        el('p', null, result.notice),
        el('button', { class: 'btn primary', onclick: () => startSignup('filters', 'home') }, '절대 조건 수정하기'),
        el('button', { class: 'btn ghost', onclick: () => startSignup('ideal', 'home') }, '이상형 범위 넓히기'),
        el('button', { class: 'link', onclick: () => go({ tab: 'report' }) }, '누가 어떤 조건에 걸렸는지 보기 ›'))];
    }

    const w = result.ranked[0];
    const p = w.profile;
    const shared = p.interests.filter((i) => state.me.interests.includes(i));
    const hero = el('section', { class: 'card hero-card' },
      el('div', { class: 'hero-photo', onclick: () => go({ detailId: p.id }) },
        photo(p, 'xl'),
        el('span', { class: 'badge' }, '♥ 궁합 1위'),
        el('div', { class: 'hero-info' },
          el('h2', null, `${p.name}, ${p.age}`),
          el('p', null, `${p.job} · ${p.region} · ${p.height}cm`),
          shared.length ? el('div', { class: 'tags on-photo' }, shared.map((s) => {
            const same = sameDetails(state.me, p, s);
            return el('span', { class: 'tag' }, same.length ? `#${s}·${same[0]}` : `#${s}`);
          })) : null),
        scoreRing(w.total)),
      el('div', { class: 'hero-body' },
        el('p', { class: 'quote' }, `“${p.intro}”`),
        el('div', { class: 'why' },
          el('h3', null, '💡 왜 이 분이 1위인가요?'),
          el('p', { class: 'why-head' }, result.explanation.headline),
          el('ul', null, result.explanation.lines.map((l) => el('li', null, l)))),
        el('div', { class: 'actions' },
          el('button', { class: 'btn ghost', onclick: () => go({ detailId: p.id }) }, '프로필 자세히'),
          likeButton(p, true))));

    const others = result.ranked.slice(1);
    const list = others.length ? el('section', null,
      el('h2', { class: 'section-title' }, `다른 추천 ${others.length}명`),
      el('ul', { class: 'grid' }, others.map((r, i) => {
        const q = r.profile;
        const sh = q.interests.filter((x) => state.me.interests.includes(x));
        return el('li', null, el('button', { class: 'pcard', 'aria-label': `${i + 2}위 ${q.name}, ${r.total}점`, onclick: () => go({ detailId: q.id }) },
          photo(q, 'card'),
          el('span', { class: 'pc-rank' }, `${i + 2}위`),
          el('span', { class: 'pc-score' }, el('b', null, r.total), '점'),
          isLiked(q.id) ? el('span', { class: 'pc-heart' }, '♥') : null,
          el('span', { class: 'pc-info' },
            el('b', null, `${q.name}, ${q.age}`),
            el('small', null, `${q.job} · ${q.region}`),
            el('small', { class: 'pc-tags' }, sh.length ? sh.map((s) => `#${s}`).join(' ') : '공통 관심사 없음'))));
      }))) : null;

    return [head, consultCard(), hero, list];
  }

  function renderDetail(result) {
    const idx = result.ranked.findIndex((r) => r.profile.id === state.detailId);
    const r = result.ranked[idx];
    if (!r) { state.detailId = null; return renderMain(); }
    const p = r.profile;
    const info = [['성별', p.gender], ['성적 지향', orientationText(p)], ['키', `${p.height}cm`], ['지역', p.region], ['직업', p.job], ['학력', p.edu], ['종교', p.religion],
      ['흡연', p.smoker ? '흡연' : '비흡연'], ['음주', p.drinking], ['결혼 계획', p.marriage], ['결혼 경험', p.marital], ['스타일', p.style]];

    return el('div', { class: 'screen detail' },
      el('header', { class: 'bar floating' },
        el('button', { class: 'icon-btn', 'aria-label': '뒤로', onclick: () => go({ detailId: null }) }, '‹')),
      el('div', { class: 'detail-photo' }, photo(p, 'full'),
        el('div', { class: 'hero-info' },
          el('span', { class: 'badge' }, `궁합 ${idx + 1}위`),
          el('h1', null, `${p.name}, ${p.age}`),
          el('p', null, `${p.job} · ${p.region}`))),
      el('main', { class: 'content' },
        el('p', { class: 'quote big' }, `“${p.intro}”`),
        noteSpot(p, r, 'intro'),
        promptCards(p, r),
        el('section', { class: 'card' },
          el('h2', null, '기본 정보'),
          el('dl', { class: 'info' }, info.map(([k, v]) => el('div', null, el('dt', null, k), el('dd', null, v))))),
        el('section', { class: 'card' },
          el('h2', null, '관심사'),
          el('ul', { class: 'interest-list' }, p.interests.map((s) => {
            const isShared = state.me.interests.includes(s);
            const same = sameDetails(state.me, p, s);
            return el('li', { class: isShared ? 'shared' : '' },
              el('b', null, isShared ? `♥ ${s}` : s),
              el('span', { class: 'sub-tags' }, detailsOf(p, s).map((d) => el('span', { class: `sub-tag ${same.includes(d) ? 'same' : ''}` }, same.includes(d) ? `✓ ${d}` : d))));
          })),
          el('p', { class: 'hint' }, '♥ 나와 겹치는 관심사, ✓ 세부 취향까지 같은 것이에요.')),
        el('section', { class: 'card' },
          el('div', { class: 'score-head' }, el('h2', null, '나와의 궁합 분석'), scoreRing(r.total, 'sm')),
          el('ul', { class: 'breakdown' }, r.items.map((it) => el('li', null,
            el('div', { class: 'bd-top' }, el('span', null, it.label), el('b', null, `${it.points}`, el('small', null, ` / ${it.max}`))),
            el('div', { class: 'meter' }, el('i', { class: `seg-${it.key}`, style: `width:${it.max ? (it.points / it.max) * 100 : 0}%` })),
            el('p', null, it.detail)))),
          idx === 0
            ? el('div', { class: 'why compact' }, el('h3', null, '💡 1위인 이유'), el('ul', null, result.explanation.lines.map((l) => el('li', null, l))))
            : el('p', { class: 'hint' }, `1위 ${result.ranked[0].profile.name}님(${result.ranked[0].total}점)과 ${result.ranked[0].total - r.total}점 차이예요.`))),
      el('footer', { class: 'cta' }, likeButton(p, true)));
  }

  // ---------- AI 중매 상담 ----------
  // 말로 설명한 바람을 조건 변경안으로 바꾸고, 적용 전후의 추천을 미리 보여 준다. 적용은 사용자가 누를 때만.
  const top3 = (me, prefs) => {
    const res = window.Matcher.recommend(me, prefs, window.PROFILES);
    return { passed: res.ranked.length, top: res.ranked.slice(0, 3).map((x) => ({ id: x.profile.id, name: x.profile.name, total: x.total })) };
  };
  async function askConsult() {
    const c = state.consult;
    const text = c.text.trim();
    if (!text) { toast('원하는 분을 한 문장으로 적어 주세요.'); return; }
    Object.assign(c, { loading: true, result: null });
    render();
    const res = await window.Concierge.plan(text, state.me, state.prefs, state.ai);
    if (state.consult !== c) return; // 그사이 로그아웃 등
    const next = window.Concierge.apply(state.me, state.prefs, res.changes);
    Object.assign(c, { loading: false, result: { ...res, text, next, at: Date.now(), before: top3(state.me, state.prefs), after: top3(next.me, next.prefs) } });
    if (state.screen === 'main') render();
  }
  function applyConsult() {
    const c = state.consult;
    const { next, changes } = c.result;
    c.undo = { me: clone(state.me), prefs: clone(state.prefs), count: changes.length };
    Object.assign(state, { me: next.me, prefs: next.prefs });
    Object.assign(c, { result: null, text: '' });
    if (save()) toast(`조건 ${changes.length}개를 바꿨어요. 리포트에서 바뀐 점수표를 볼 수 있어요.`);
    render();
  }
  function undoConsult() {
    const { me, prefs } = state.consult.undo;
    Object.assign(state, { me, prefs });
    state.consult.undo = null;
    if (save()) toast('상담 전 조건으로 되돌렸어요.');
    render();
  }

  function consultCard() {
    const c = state.consult;
    const input = el('textarea', { rows: 2, maxlength: 300, placeholder: '예: 주말에 같이 등산할 사람, 담배는 안 피웠으면 좋겠어요', 'aria-label': '원하는 분 설명',
      oninput: (e) => { c.text = e.target.value; } });
    input.value = c.text;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); askConsult(); } });
    const res = c.result;
    const rankRow = (label, x) => el('div', { class: 'cs-rank' }, el('span', null, label),
      el('ol', null, x.top.map((t) => el('li', null, `${t.name} ${t.total}점`))), el('small', null, `조건 통과 ${x.passed}명`));
    return el('section', { class: 'card consult' },
      el('div', { class: 'card-head' }, el('h2', null, '🔎 AI 중매 상담'),
        el('span', { class: 'cs-by' }, window.LLM.ready(state.ai) ? window.LLM.label(state.ai) : '규칙 해석')),
      el('p', { class: 'hint top' }, '원하는 분을 말로 설명해 주세요. 점수표와 조건을 어떻게 바꿀지, 그러면 추천이 어떻게 달라지는지 먼저 보여 드려요.'),
      el('form', { class: 'cs-form', onsubmit: (e) => { e.preventDefault(); askConsult(); } }, input,
        el('button', { class: 'btn primary sm', type: 'submit', disabled: c.loading }, c.loading ? '해석하는 중…' : '조건 찾기')),
      !res && !c.loading ? el('div', { class: 'chips sm' }, window.Concierge.EXAMPLES.map((ex) =>
        el('button', { type: 'button', class: 'chip', onclick: () => { c.text = ex; render(); } }, ex))) : null,
      res ? el('div', { class: `cs-result ${fresh(`consult:${res.at}`) ? 'reveal' : ''}` },
        res.error ? el('p', { class: 'intro-status failed' }, `AI 연결 실패로 규칙으로 해석했어요. (${res.error})`) : null,
        res.changes.length
          ? [el('p', { class: 'cs-title' }, `이렇게 바꿔 볼게요 (${res.by === 'ai' ? 'AI 해석' : '키워드 해석'})`),
            el('ul', { class: 'cs-changes' }, res.changes.map((ch) => el('li', null, el('b', null, window.Concierge.describe(ch)), el('small', null, ch.why)))),
            el('div', { class: 'cs-compare' }, rankRow('지금', res.before), el('span', { class: 'cs-arrow', 'aria-hidden': 'true' }, '→'), rankRow('적용하면', res.after)),
            el('div', { class: 'note-actions' },
              el('button', { type: 'button', class: 'link', onclick: () => { c.result = null; render(); } }, '취소'),
              el('button', { type: 'button', class: 'btn primary sm', onclick: applyConsult }, '이대로 적용'))]
          : el('p', { class: 'hint' }, '말씀하신 내용에서 바꿀 조건을 찾지 못했어요. 관심사, 나이, 거리, 술·담배, 종교, 결혼 생각, 대화 스타일처럼 적어 보세요.')) : null,
      c.undo ? el('p', { class: 'cs-undo' }, `상담으로 조건 ${c.undo.count}개를 바꿨어요. `,
        el('button', { type: 'button', class: 'link', onclick: undoConsult }, '되돌리기')) : null);
  }

  // ---------- 질문 카드와 한마디 ----------
  function promptCards(p, r) {
    const cards = window.Prompts.clean(p.prompts);
    if (!cards.length) return null;
    return el('section', { class: 'prompt-list' }, cards.map((c) => el('article', { class: 'prompt-card' },
      el('p', { class: 'pc-q' }, window.Prompts.questionText(c.q)),
      el('p', { class: 'pc-a' }, c.a),
      noteSpot(p, r, `q:${c.q}`))));
  }

  // 카드 아래: 한마디 남기기 버튼, 또는 쓰는 중인 한마디 입력칸. 이미 관심을 보냈거나 매칭됐으면 남긴 한마디를 보여 준다.
  function noteSpot(p, r, target) {
    const sent = state.likeNotes[p.id];
    if (isMatched(p.id) || isLiked(p.id)) {
      return sent && sent.target === target ? el('p', { class: 'note-sent' }, `💬 내가 남긴 한마디: “${sent.text}”`) : null;
    }
    const t = window.Prompts.findTarget(p, target);
    const d = state.noteDraft;
    if (!d || d.id !== p.id || d.target !== target) {
      return el('button', { type: 'button', class: 'note-btn', onclick: () => { state.noteDraft = { id: p.id, target, text: '', warned: null }; render(); } },
        '💬 여기에 한마디 남기고 관심 보내기');
    }
    const { threshold, noteBonus } = window.Rules.MATCH_RULE;
    const warn = d.warned ? window.Safety.check(d.warned) : [];
    const send = () => {
      const text = d.text.trim();
      if (!text) { toast('한마디를 적어 주세요.'); return; }
      // 연락처·돈·욕설 등은 채팅과 똑같이 한 번 안내하고, 그대로 다시 보내면 보낸다
      if (d.warned !== text && window.Safety.check(text).length) { d.warned = text; render(); return; }
      toggleLike(p, { target, label: t.label, quote: t.text, text });
    };
    const box = el('textarea', { rows: 2, maxlength: 150, placeholder: `${p.name}님의 답에 이어질 한마디. 예) 저도 그거 좋아해요! 어디가 제일 좋았어요?`,
      'aria-label': '한마디', oninput: (e) => { d.text = e.target.value; } });
    box.value = d.text;
    setTimeout(() => box.focus({ preventScroll: true }), 0);
    return el('div', { class: 'note-compose' },
      box,
      warn.length ? el('div', { class: 'safety-note mine' }, el('b', null, '⚠ 보내기 전에 확인해 주세요'), warn.map((h) => el('p', null, h.mine)),
        el('small', null, '그래도 보내려면 한 번 더 누르세요.')) : null,
      el('p', { class: 'hint' }, `한마디와 함께 보내면 ${threshold - noteBonus}점부터 매칭돼요 (그냥 관심은 ${threshold}점). 지금 궁합은 ${r.total}점이에요.`),
      el('div', { class: 'note-actions' },
        el('button', { type: 'button', class: 'link', onclick: () => { state.noteDraft = null; render(); } }, '취소'),
        el('button', { type: 'button', class: 'btn primary sm', onclick: send }, '한마디와 관심 보내기')));
  }

  function renderReport(result) {
    let left = result.poolSize;
    const funnel = el('ol', { class: 'funnel' },
      el('li', { class: 'f-start' }, el('b', null, `전체 ${result.poolSize}명`), el('small', null, `회원 ${result.poolSize - 1}명 + 나`)),
      result.steps.map((s) => {
        left -= s.removed.length;
        return el('li', { class: s.active ? '' : 'off' },
          el('div', { class: 'f-row' },
            el('span', null, el('em', { class: `state ${s.active ? 'on' : ''}` }, s.always ? '항상' : s.active ? 'ON' : 'OFF'), s.label),
            el('span', { class: 'f-count' }, s.active ? `−${s.removed.length} → ${left}명` : '적용 안 함')),
          s.removed.length ? el('div', { class: 'removed' }, s.removed.map((x) => el('span', null, photo(x.profile, 'xxs'), el('b', null, x.profile.name), ` ${x.why}`))) : null);
      }),
      el('li', { class: `f-end ${left ? '' : 'zero'}` }, el('b', null, `통과 ${left}명`), el('small', null, left ? '이 분들만 점수를 매겨요' : '추천할 분이 없어요')));

    const table = weightEditor(result);

    const ranking = result.ranked.length ? el('ol', { class: 'mini-rank' }, result.ranked.map((r, i) =>
      el('li', null,
        el('button', { class: 'mr-btn', onclick: () => go({ tab: 'home', detailId: r.profile.id }) },
          el('span', { class: 'mr-name' }, photo(r.profile, 'xxs'), `${i + 1}. ${r.profile.name}`),
          el('span', { class: 'mr-bar' }, r.items.map((it) => el('i', { class: `seg-${it.key}`, style: `width:${it.points}%`, title: `${it.label} ${it.points}점` }))),
          el('b', null, r.total))))) : el('p', { class: 'hint' }, '점수를 매길 분이 없어요.');

    return [
      el('header', { class: 'page-head' }, el('h1', null, '매칭 리포트'), el('p', { class: 'sub' }, '추천이 어떻게 만들어졌는지 전부 공개해요.')),
      el('section', { class: 'card' }, el('h2', null, '① 거르기 · 절대 안 되는 조건'), funnel),
      el('section', { class: 'card', id: 'weights' }, el('h2', null, '② 점수표 · 무엇에 몇 점을, 왜'),
        el('p', { class: 'hint top' }, '항목마다 나에게 얼마나 중요한지 고르세요. 중요도에 비례해 만점을 다시 나누고, 합계는 늘 100점이에요. 바꾸면 순위가 바로 다시 계산돼요.'),
        table,
        el('p', { class: 'hint' }, `규칙 속 점수는 '보통' 기준이에요. 동점일 때: ${TIE_BREAK}`)),
      el('section', { class: 'card' }, el('h2', null, '③ 순위'),
        el('div', { class: 'legend' }, SCORE_RULES.map((r) => el('span', null, el('i', { class: `dot seg-${r.key}` }), r.label))),
        ranking),
    ];
  }

  // 항목별 중요도 고르기. 고르는 즉시 저장하고 다시 계산한다.
  function weightEditor(result) {
    const maxes = window.Matcher.effectiveMax(window.Matcher.activeWeights(state.me, state.prefs.weights));
    const current = (key) => (state.prefs.weights && typeof state.prefs.weights[key] === 'number' ? state.prefs.weights[key] : 1);
    const setWeight = (key, value) => {
      state.prefs.weights = { ...(state.prefs.weights || {}), [key]: value };
      save();
      render(); // 스크롤 위치를 지키려고 go() 대신 render()
    };
    const top = result.ranked[0];
    return el('div', { class: 'weights' },
      SCORE_RULES.map((r) => el('div', { class: `w-row ${current(r.key) === 0 ? 'off' : ''}` },
        el('div', { class: 'w-head' },
          el('span', { class: 'w-label' }, el('i', { class: `dot seg-${r.key}` }), r.label),
          el('span', { class: 'w-max' }, el('b', null, maxes[r.key]), '점',
            maxes[r.key] !== r.max ? el('small', null, ` (기본 ${r.max})`) : null)),
        el('div', { class: 'w-levels', role: 'radiogroup', 'aria-label': `${r.label} 중요도` },
          window.Rules.WEIGHT_LEVELS.map((l) => el('button', { type: 'button', role: 'radio', 'aria-checked': String(current(r.key) === l.value),
            class: current(r.key) === l.value ? 'on' : '', onclick: () => setWeight(r.key, l.value) }, l.label))),
        el('p', { class: 'w-rule' }, el('b', null, r.rule), ' · ', r.why),
        r.key === 'intro' ? introStatus('report') : null)),
      el('div', { class: 'w-foot' },
        el('span', null, '합계 ', el('b', null, Object.values(maxes).reduce((a, b) => a + b, 0)), '점'),
        top ? el('span', null, `지금 1위: ${top.profile.name} ${top.total}점`) : el('span', null, '추천할 분이 없어요'),
        el('button', { class: 'link', onclick: () => { state.prefs.weights = {}; save(); render(); } }, '모두 보통으로')));
  }

  function renderMe() {
    const { me, prefs } = state;
    const on = FILTER_RULES.filter((f) => !f.always && prefs.filters[f.key]).map((f) => f.toggle);
    const liked = window.PROFILES.filter((p) => isLiked(p.id));
    const row = (k, v) => el('div', null, el('dt', null, k), el('dd', null, v));
    return [
      el('header', { class: 'page-head' }, el('h1', null, '내 정보')),
      el('section', { class: 'card me-card' },
        el('button', { class: 'me-photo', 'aria-label': '프로필 사진 바꾸기', onclick: () => pickPhoto(changeMyPhoto) },
          photo(me, 'lg'), el('span', { class: 'cam', 'aria-hidden': 'true' }, '📷')),
        el('div', null, el('h2', null, `${me.name}, ${me.age}`), el('p', { class: 'sub' }, `${me.job || '직업 미입력'} · ${me.region} · ${me.height}cm`),
          el('div', { class: 'tags' }, me.interests.map((s) => el('span', { class: 'tag' }, detailsOf(me, s).length ? `${s} · ${detailsOf(me, s).join('·')}` : s))),
          el('div', { class: 'me-photo-actions' },
            el('button', { class: 'link', onclick: () => pickPhoto(changeMyPhoto) }, me.photo ? '사진 바꾸기' : '사진 올리기'),
            me.photo ? el('button', { class: 'link muted-link', onclick: () => changeMyPhoto(null) }, '사진 삭제') : null))),
      coachCard(),
      el('section', { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', null, '내 프로필'), el('button', { class: 'link', onclick: () => startSignup('basic', 'me') }, '수정')),
        el('dl', { class: 'info' }, row('성별', me.gender), row('성적 지향', `${me.orientation}${me.orientationPublic ? '' : ' (비공개)'}`), row('종교', me.religion), row('흡연', me.smoker ? '흡연' : '비흡연'),
          row('음주', me.drinking), row('결혼 계획', me.marriage), row('결혼 경험', me.marital), row('스타일', me.style))),
      el('section', { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', null, '자기소개'), el('button', { class: 'link', onclick: () => startSignup('intro', 'me') }, me.intro ? '수정' : '쓰기')),
        me.intro ? el('p', { class: 'me-intro' }, me.intro) : null,
        introStatus('me')),
      el('section', { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', null, '질문 카드'),
          el('button', { class: 'link', onclick: () => startSignup('prompts', 'me') }, window.Prompts.clean(me.prompts).length ? '수정' : '쓰기')),
        window.Prompts.clean(me.prompts).length
          ? el('div', { class: 'prompt-list' }, window.Prompts.clean(me.prompts).map((c) => el('article', { class: 'prompt-card' },
            el('p', { class: 'pc-q' }, window.Prompts.questionText(c.q)), el('p', { class: 'pc-a' }, c.a))))
          : el('p', { class: 'hint' }, '질문 카드에 답하면 상대가 그 답에 한마디를 남기며 관심을 보낼 수 있어요.')),
      el('section', { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', null, '이상형'), el('button', { class: 'link', onclick: () => startSignup('ideal', 'me') }, '수정')),
        el('dl', { class: 'info' }, row('만나는 성별', window.Matcher.interestedIn(me).join('·')), row('나이', `${prefs.ageMin}~${prefs.ageMax}세`),
          row('키', `${prefs.heightMin}~${prefs.heightMax}cm`), row('스타일', prefs.styles.join(', ') || '상관없음'))),
      el('section', { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', null, '항목별 중요도'), el('button', { class: 'link', onclick: openWeights }, '조절')),
        el('div', { class: 'tags' }, (() => {
          const maxes = window.Matcher.effectiveMax(window.Matcher.activeWeights(me, prefs.weights));
          return SCORE_RULES.map((r) => el('span', { class: `tag ${maxes[r.key] > r.max ? 'shared' : ''}` }, `${r.label} ${maxes[r.key]}점`));
        })())),
      el('section', { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', null, '절대 조건'), el('button', { class: 'link', onclick: () => startSignup('filters', 'me') }, '수정')),
        on.length ? el('ul', { class: 'plain' }, on.map((t) => el('li', null, t))) : el('p', { class: 'hint' }, '켜 둔 조건이 없어요.')),
      el('section', { class: 'card' },
        el('h2', null, `보낸 관심 ${liked.length}`),
        liked.length ? el('div', { class: 'liked-row' }, liked.map((p) =>
          el('button', { class: 'liked-item', onclick: () => go({ tab: 'home', detailId: p.id }) }, photo(p, 'sm'),
            el('span', null, state.likeNotes[p.id] ? `💬 ${p.name}` : p.name))))
          : el('p', { class: 'hint' }, '마음에 드는 분에게 관심을 보내 보세요.')),
      learnedCard(),
      aiSettings(),
      el('section', { class: 'card' },
        el('h2', null, '계정'),
        el('dl', { class: 'info' }, row('이메일', state.account)),
        el('p', { class: 'hint' }, '데모 앱이라 계정은 이 브라우저에만 저장돼요. 다른 기기에서는 로그인할 수 없어요.')),
      el('button', { class: 'btn ghost', onclick: logout }, '로그아웃'),
      el('button', { class: 'link danger-link', onclick: () => {
        if (confirm('계정과 입력한 정보, 보낸 관심을 모두 지울까요? 되돌릴 수 없어요.')) deleteAccount();
      } }, '회원 탈퇴'),
    ];
  }

  // ---------- 프로필 코치 ----------
  async function askCoach() {
    const ca = state.coachAi;
    Object.assign(ca, { loading: true, error: '', result: null });
    render();
    try { ca.result = await window.Coach.aiReview(state.ai, state.me); } catch (e) { ca.error = e.message; }
    ca.loading = false;
    if (state.screen === 'main') render();
  }
  function coachCard() {
    const res = window.Coach.check(state.me);
    const ca = state.coachAi;
    const fix = { photo: () => pickPhoto(changeMyPhoto), intro: () => startSignup('intro', 'me'), introQuality: () => startSignup('intro', 'me'),
      prompts: () => startSignup('prompts', 'me'), details: () => startSignup('interests', 'me') };
    // AI 예시는 바로 저장하지 않고, 자기소개 편집 화면에 채워 사용자가 고쳐서 저장하게 한다
    const useExample = () => { startSignup('intro', 'me'); state.draft.me.intro = ca.result.example; render(); };
    return el('section', { class: 'card coach' },
      el('div', { class: 'card-head' }, el('h2', null, '🪄 프로필 코치'), el('span', { class: 'coach-score' }, el('b', null, res.score), '/100')),
      el('div', { class: 'meter' }, el('i', { class: 'seg-interests', style: `width:${res.score}%` })),
      el('ul', { class: 'coach-list' }, res.items.map((it) => el('li', { class: it.ok ? 'ok' : '' },
        el('div', { class: 'coach-row' }, el('span', null, `${it.ok ? '✓' : '○'} ${it.title}`),
          it.ok ? null : el('button', { type: 'button', class: 'link', onclick: fix[it.key] }, '고치기')),
        it.ok ? null : el('p', null, it.tip),
        it.ok ? null : el('small', null, `고치면: ${it.impact}`)))),
      window.LLM.ready(state.ai)
        ? el('div', { class: 'coach-ai' },
          el('button', { type: 'button', class: 'btn ghost sm', disabled: ca.loading || !(state.me.intro || '').trim(), onclick: askCoach },
            ca.loading ? 'AI가 자기소개를 읽는 중…' : (state.me.intro || '').trim() ? 'AI에게 자기소개 코칭 받기' : '자기소개를 먼저 써 주세요'),
          ca.error ? el('p', { class: 'error' }, ca.error) : null,
          ca.result ? el('div', { class: 'coach-result' },
            ca.result.tips.length ? el('ul', null, ca.result.tips.map((t) => el('li', null, t))) : null,
            ca.result.example ? [el('p', { class: 'cs-title' }, '이렇게 고쳐 볼 수 있어요'), el('p', { class: 'me-intro' }, ca.result.example),
              el('button', { type: 'button', class: 'link', onclick: useExample }, '이 예시로 자기소개 고치기 ›')] : null) : null)
        : el('p', { class: 'hint' }, '내 정보 → AI 대화 설정을 켜면, AI가 자기소개를 읽고 어떻게 고치면 좋을지 제안해요.'));
  }

  // ---------- 만남 후기로 바뀐 중요도 ----------
  function undoFeedback(id) {
    const fb = state.dateFeedback[id];
    const weights = { ...(state.prefs.weights || {}) };
    Object.entries(fb.before).forEach(([k, v]) => { if (v === null) delete weights[k]; else weights[k] = v; });
    state.prefs.weights = weights;
    fb.undone = true;
    if (save()) toast('후기로 바꾼 중요도를 되돌렸어요.');
    render();
  }
  function learnedCard() {
    const rows = Object.entries(state.dateFeedback).filter(([, fb]) => fb.changes && fb.changes.length && !fb.undone);
    if (!rows.length) return null;
    return el('section', { class: 'card' },
      el('h2', null, '만남 후기로 다듬은 추천'),
      el('p', { class: 'hint top' }, '후기는 상대에게 알리지 않아요. 바뀐 중요도는 리포트의 점수표에 그대로 반영돼요.'),
      el('ul', { class: 'learned' }, rows.map(([id, fb]) => {
        const p = profileById(id);
        return el('li', null, el('b', null, `${p ? p.name : id}님 후기`),
          fb.changes.map((c) => el('p', null, `${c.label}: ${c.from} → ${c.to}`, el('small', null, ` · ${c.why}`))),
          el('button', { type: 'button', class: 'link', onclick: () => undoFeedback(id) }, '되돌리기'));
      })));
  }

  function changeMyPhoto(url) {
    const before = state.me.photo;
    if (url) state.me.photo = url; else delete state.me.photo;
    if (!save()) { if (before) state.me.photo = before; else delete state.me.photo; }
    else toast(url ? '프로필 사진을 바꿨어요.' : '프로필 사진을 지웠어요.');
    render();
  }

  // ---------- 채팅 ----------
  const timeText = (at) => {
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function renderChatList() {
    // 내가 답할 차례인 대화를 위로 올린다
    const turnRank = { mine: 0, new: 1, theirs: 2 };
    const rows = state.matches.map(profileById).filter(Boolean)
      .map((p) => ({ p, turn: window.Dates.turnOf(state.chats[p.id]) }))
      .sort((a, b) => turnRank[a.turn] - turnRank[b.turn]);
    const aiLabel = window.LLM.label(state.ai);
    return [
      el('header', { class: 'page-head' }, el('h1', null, '채팅'),
        el('p', { class: 'sub' }, aiLabel
          ? `AI 대화 켜짐 (${aiLabel}) · 회원의 프로필대로 답해요.`
          : '기본 대화 모드 · 내 정보 → AI 대화 설정에서 Claude나 로컬 AI(Ollama)를 켜면 진짜 대화처럼 바뀌어요.')),
      rows.length
        ? el('ul', { class: 'chat-list' }, rows.map(({ p, turn }) => {
          const last = [...(state.chats[p.id] || [])].reverse().find((m) => m.from !== 'system');
          return el('li', null, el('button', { class: 'chat-row', onclick: () => openChat(p.id) },
            photo(p, 'sm'),
            el('span', { class: 'cr-main' }, el('b', null, p.name, turn === 'mine' ? el('em', { class: 'turn' }, '내 차례') : null),
              el('small', null, last ? `${last.from === 'me' ? '나: ' : ''}${last.text}` : '')),
            el('span', { class: 'cr-time' }, last ? timeText(last.at) : '')));
        }))
        : el('section', { class: 'card empty-chat' },
          el('div', { class: 'empty-icon' }, '💬'),
          el('h2', null, '아직 매칭된 분이 없어요'),
          el('p', null, `추천에서 마음에 드는 분에게 관심을 보내 보세요. ${window.Rules.MATCH_RULE.rule}`),
          el('button', { class: 'btn primary', onclick: () => go({ tab: 'home' }) }, '추천 보러 가기')),
    ];
  }

  async function sendMessage(p) {
    const text = state.chatDraft.trim();
    if (!text || state.typing) return;
    // 연락처·돈·욕설 등이 들어 있으면 먼저 안내하고, 같은 문장을 한 번 더 보내면 그대로 보낸다
    if (state.chatWarn !== text && window.Safety.check(text).length) { state.chatWarn = text; render(); return; }
    const log = state.chats[p.id];
    log.push({ from: 'me', text, at: Date.now() });
    Object.assign(state, { chatDraft: '', chatWarn: null, starters: null, typing: true });
    save();
    render();
    const started = Date.now();
    const res = await window.Chat.reply({ ai: state.ai, profile: p, me: state.me, history: log });
    const wait = 600 + Math.min(text.length * 15, 900) - (Date.now() - started); // 상대가 입력하는 듯한 짧은 간격
    if (wait > 0) await sleep(wait);
    if (res.error) log.push({ from: 'system', text: `AI 연결 실패: ${res.error} 이번 답은 기본 대화로 보냈어요.`, at: Date.now() });
    const msg = { from: 'them', text: res.text, at: Date.now() };
    log.push(msg);
    state.typing = false;
    save();
    if (state.screen === 'main') render();
    // 받은 메시지 안전 검사. AI 판단은 시간이 걸려서 답장을 먼저 보여 준 뒤 경고를 덧붙인다.
    const hits = await window.Safety.review(msg.text, res.error ? null : state.ai);
    if (!hits.length) return;
    msg.safety = hits.map(({ label, theirs, byAi }) => ({ label, text: theirs, byAi: Boolean(byAi) }));
    save();
    if (state.screen === 'main') render();
  }

  // 대화 시작 추천: 내가 아직 한마디도 안 했을 때만 보인다. 누르면 입력칸에 들어가고, 고쳐서 보낼 수 있다.
  function startersBox(p, log) {
    if (state.typing || log.some((m) => m.from === 'me')) return null;
    if (!state.starters || state.starters.id !== p.id) state.starters = { id: p.id, list: window.Starters.suggest(state.me, p), loading: false, byAi: false };
    const st = state.starters;
    return el('div', { class: 'starters' },
      el('p', { class: 'st-head' }, st.byAi ? '💡 AI가 두 분 프로필을 읽고 고른 첫 마디' : '💡 이렇게 말을 걸어 보세요'),
      el('div', { class: 'st-list' }, st.list.map((t) => el('button', { type: 'button', class: 'st-chip',
        onclick: () => { state.chatDraft = t; state.chatWarn = null; render(); } }, t))),
      window.LLM.ready(state.ai) && !st.byAi
        ? el('button', { type: 'button', class: 'link', disabled: st.loading, onclick: () => aiStarters(p) }, st.loading ? 'AI가 프로필을 읽는 중…' : 'AI로 맞춤 추천 받기 ›')
        : null);
  }
  async function aiStarters(p) {
    const st = state.starters;
    st.loading = true;
    render();
    try {
      Object.assign(st, { list: await window.Starters.aiSuggest(state.ai, state.me, p), byAi: true });
    } catch (e) { toast(e.message); }
    st.loading = false;
    if (state.starters === st && state.screen === 'main') render();
  }

  // ---------- 데이트 제안 ----------
  function dateIdeasBox(p) {
    return el('div', { class: `date-ideas ${fresh(`dates:${state.dateIdeasAt}`) ? 'reveal' : ''}` },
      el('p', { class: 'st-head' }, `📅 ${p.name}님과 이런 데이트 어때요?`),
      window.Dates.ideas(state.me, p).map((d) => el('div', { class: 'date-idea' },
        el('div', null, el('b', null, d.title), el('p', null, d.plan), el('small', null, d.why)),
        el('button', { type: 'button', class: 'btn ghost sm', onclick: () => { Object.assign(state, { chatDraft: d.message, chatWarn: null, dateIdeas: false }); render(); } }, '제안하기'))),
      el('details', { class: 'date-safety' }, el('summary', null, '첫 만남 안전 수칙'),
        el('ul', null, window.Dates.SAFETY_TIPS.map((t) => el('li', null, t)))));
  }

  // ---------- 만남 후기 ----------
  // 내가 메시지를 3번 넘게 보낸 대화에서 묻는다. 데모의 상대는 가상 회원이라, 만났다고 가정하고 눌러 볼 수 있다.
  const MET_ASK_AFTER = 3;
  function recordMet(p, verdict, reason) {
    const scored = window.Matcher.scoreProfile(state.me, state.prefs, p);
    const before = state.prefs.weights || {};
    const learned = window.Feedback.learn(before, scored, verdict, reason);
    const prev = Object.fromEntries(learned.changes.map((c) => [c.key, typeof before[c.key] === 'number' ? before[c.key] : null]));
    state.prefs.weights = learned.weights;
    state.dateFeedback[p.id] = { verdict, reason: reason || null, changes: learned.changes, before: prev, at: Date.now() };
    state.notMetFor = null;
    state.chats[p.id].push({ from: 'system', at: Date.now(), text: learned.changes.length
      ? `📝 후기를 추천에 반영했어요: ${learned.changes.map((c) => `${c.label} ${c.from}→${c.to}`).join(', ')}. 상대에게는 알리지 않고, 내 정보에서 되돌릴 수 있어요.`
      : '📝 후기를 남겨 주셔서 고마워요. 이번 후기로 바뀐 중요도는 없어요.' });
    save();
    render();
  }
  function metCard(p, log) {
    const mine = log.filter((m) => m.from === 'me').length;
    const fb = state.dateFeedback[p.id];
    if (state.typing || mine < MET_ASK_AFTER) return null;
    if (fb && !(fb.verdict === 'later' && mine >= fb.askAt)) return null;
    const later = () => { state.dateFeedback[p.id] = { verdict: 'later', askAt: mine + 5 }; save(); render(); };
    const never = () => { state.dateFeedback[p.id] = { verdict: 'never' }; save(); render(); };
    return el('div', { class: 'met-card' },
      el('p', { class: 'st-head' }, `🤝 ${p.name}님과 실제로 만나 보셨나요?`),
      el('p', { class: 'hint' }, '답은 상대에게 알리지 않고, 다음 추천을 다듬는 데만 써요. (데모에서는 만났다고 가정하고 눌러 보세요)'),
      state.notMetFor === p.id
        ? [el('p', { class: 'cs-title' }, '어떤 점이 아쉬웠어요?'),
          el('div', { class: 'chips sm' }, window.Feedback.REASONS.map((r) =>
            el('button', { type: 'button', class: 'chip', onclick: () => recordMet(p, 'not', r.key) }, r.label)))]
        : el('div', { class: 'met-actions' },
          el('button', { type: 'button', class: 'btn primary sm', onclick: () => recordMet(p, 'again') }, '또 보고 싶어요'),
          el('button', { type: 'button', class: 'btn ghost sm', onclick: () => { state.notMetFor = p.id; render(); } }, '만났는데 아니었어요'),
          el('button', { type: 'button', class: 'link', onclick: later }, '아직이에요'),
          el('button', { type: 'button', class: 'link muted-link', onclick: never }, '묻지 않기')));
  }

  function safetyNote(cls, title, lines, foot) {
    return el('div', { class: `safety-note ${cls}`, role: 'alert' }, el('b', null, title), lines.map((t) => el('p', null, t)), foot ? el('small', null, foot) : null);
  }

  function renderChat() {
    const p = profileById(state.chatId);
    if (!p || !isMatched(p.id)) { state.chatId = null; return renderMain(); }
    const log = state.chats[p.id] || [];
    const aiLabel = window.LLM.label(state.ai);
    const input = el('textarea', { rows: 1, placeholder: `${p.name}님에게 메시지 보내기`, maxlength: 500, 'aria-label': '메시지',
      oninput: (e) => { state.chatDraft = e.target.value; } });
    input.value = state.chatDraft;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(p); } // 한글 조합 중 Enter는 무시
    });
    const warn = state.chatWarn ? window.Safety.check(state.chatWarn) : [];
    // 방에 처음 들어올 때는 화면 등장 효과만 쓰고, 그 뒤에 생긴 메시지만 하나씩 올라오게 한다
    const shownBefore = seenMsgs[p.id] === undefined ? log.length : seenMsgs[p.id];
    seenMsgs[p.id] = log.length;
    return el('div', { class: 'screen chat-room' },
      el('header', { class: 'bar chat-head' },
        el('button', { class: 'icon-btn', 'aria-label': '채팅 목록으로', onclick: () => go({ chatId: null, chatDraft: '' }) }, '‹'),
        el('button', { class: 'chat-who', onclick: () => go({ chatId: null, tab: 'home', detailId: p.id }) },
          photo(p, 'xs'),
          el('span', null, el('b', null, p.name), el('small', null, aiLabel ? `AI 캐릭터 · ${aiLabel}` : 'AI 캐릭터 · 기본 대화'))),
        el('button', { class: `date-btn ${state.dateIdeas ? 'on' : ''}`, 'aria-pressed': String(state.dateIdeas), onclick: () => { state.dateIdeas = !state.dateIdeas; state.dateIdeasAt = Date.now(); render(); } }, '📅 데이트 제안')),
      el('div', { class: 'messages', id: 'messages', 'aria-live': 'polite' },
        el('p', { class: 'msg-system' }, `${p.name}님은 이 앱의 가상 회원(AI 캐릭터)이에요. 개인정보나 돈 얘기는 하지 마세요.`),
        log.flatMap((m, i) => (m.from === 'system'
          ? [el('p', { class: `msg-system ${i >= shownBefore ? 'pop' : ''}` }, m.text)]
          : [el('div', { class: `msg ${m.from} ${i >= shownBefore ? 'pop' : ''}` },
            m.from === 'them' ? photo(p, 'xs') : null,
            el('p', { class: 'bubble' }, m.quote ? el('span', { class: 'bubble-quote' }, `${m.quote.label} · “${m.quote.text.length > 40 ? `${m.quote.text.slice(0, 40)}…` : m.quote.text}”`) : null, m.text),
            el('time', null, timeText(m.at))),
          m.safety ? safetyNote('theirs', `⚠ ${m.safety.map((h) => h.label).join(' · ')}${m.safety.some((h) => h.byAi) ? ' (AI 판단)' : ''}`,
            m.safety.map((h) => h.text)) : null])),
        state.typing ? el('div', { class: 'msg them' }, photo(p, 'xs'),
          el('p', { class: 'bubble typing', 'aria-label': `${p.name}님이 입력 중` }, el('i'), el('i'), el('i'))) : null,
        startersBox(p, log),
        metCard(p, log)),
      state.dateIdeas ? dateIdeasBox(p) : null,
      warn.length ? safetyNote('mine', '⚠ 보내기 전에 확인해 주세요', warn.map((h) => h.mine), '그래도 보내려면 보내기를 한 번 더 누르세요.') : null,
      el('form', { class: 'composer', onsubmit: (e) => { e.preventDefault(); sendMessage(p); } },
        input,
        el('button', { class: 'send', type: 'submit', 'aria-label': '보내기', disabled: state.typing }, '↑')));
  }

  function matchOverlay() {
    const p = profileById(state.matchModal.id);
    const close = () => { state.matchModal = null; render(); };
    // 처음 뜰 때만 연출한다 (다시 그려질 때는 조용히 그대로 보여 준다)
    const celebrate = fresh(`match:${p.id}`);
    const total = state.matchModal.total;
    return el('div', { class: `overlay match-overlay ${celebrate ? 'celebrate' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': '매칭 성공' },
      el('div', { class: 'rays', 'aria-hidden': 'true' }),
      el('canvas', { class: 'confetti', 'aria-hidden': 'true' }),
      el('div', { class: 'match-card' },
        celebrate ? el('div', { class: 'burst', 'aria-hidden': 'true' }, Array.from({ length: 16 }, (_, i) =>
          el('i', { style: `--a:${Math.round((i * 360) / 16)}deg;--d:${(i % 4) * 60}ms;--r:${100 + (i % 3) * 30}px` }, '♥'))) : null,
        el('p', { class: 'match-kicker' }, '인연노트가 이어 드린 인연'),
        el('p', { class: 'match-title', 'aria-label': '매칭 성공!' }, [...'매칭 성공!'].map((ch, i) =>
          el('span', { 'aria-hidden': 'true', style: `--i:${i}` }, ch === ' ' ? ' ' : ch))),
        el('div', { class: 'match-photos' }, photo(state.me, 'md'),
          el('span', { class: 'match-heart' }, '♥', el('i', { class: 'wave' }), el('i', { class: 'wave w2' })), photo(p, 'md')),
        typeof total === 'number' ? el('p', { class: 'match-score' }, '궁합 ', el('b', null, total), '점') : null,
        el('p', { class: 'match-line' }, `${p.name}님도 ${state.me.name}님에게 관심을 보였어요.`),
        el('small', null, state.matchModal.reason),
        el('button', { class: 'btn primary', onclick: () => openChat(p.id) }, '💬 대화 시작하기'),
        el('button', { class: 'link', onclick: close }, '나중에 할게요')));
  }

  // Ollama에 깔린 대화용 모델 목록. 주소가 바뀔 때만 다시 묻는다.
  const ollamaProbe = { url: null, models: [], error: '', loading: false };
  function probeOllama(url) {
    Object.assign(ollamaProbe, { url, models: [], error: '', loading: true });
    window.LLM.listOllamaModels(url).then((models) => {
      if (ollamaProbe.url !== url) return;
      Object.assign(ollamaProbe, { models, loading: false,
        error: models.length ? '' : "대화용 모델이 없어요. 'ollama pull llama3.1:8b'처럼 모델을 받아 주세요." });
      // 저장된 모델이 없거나 지워졌으면 한국어를 가장 잘하는 모델을 쓴다
      if (models.length && state.ai && state.ai.ollamaUrl === url && !models.includes(state.ai.ollamaModel)) {
        state.ai = { ...state.ai, ollamaModel: window.LLM.preferredModel(models) };
        save();
      }
      if (state.screen === 'main') render();
    }, (e) => {
      if (ollamaProbe.url !== url) return;
      Object.assign(ollamaProbe, { loading: false, error: e.message });
      if (state.screen === 'main') render();
    });
  }

  // 인연노트 AI 서버 상태. 주소나 키가 바뀔 때만 다시 묻는다.
  const serverProbe = { key: null, status: null, error: '', loading: false };
  function probeServer(url, key) {
    const probeKey = `${url}|${key}`;
    Object.assign(serverProbe, { key: probeKey, status: null, error: '', loading: true });
    window.LLM.serverHealth(url, key).then((status) => {
      if (serverProbe.key !== probeKey) return;
      Object.assign(serverProbe, { status, loading: false });
      if (state.screen === 'main') render();
    }, (e) => {
      if (serverProbe.key !== probeKey) return;
      Object.assign(serverProbe, { loading: false, error: e.message });
      if (state.screen === 'main') render();
    });
  }

  function aiSettings() {
    const ai = state.ai;
    const setAi = (patch, msg) => {
      state.ai = { ...state.ai, ...patch };
      if (save() && msg) toast(msg);
      render();
    };
    const providers = [['off', '끄기'], ['claude', 'Claude'], ['ollama', '로컬 AI (Ollama)'], ['server', 'AI 서버']];
    const providerRow = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'AI 종류' }, providers.map(([v, l]) =>
      el('button', { type: 'button', role: 'radio', 'aria-checked': String(ai.provider === v), class: ai.provider === v ? 'on' : '',
        onclick: () => setAi({ provider: v }) }, l)));

    let panel = null;
    if (ai.provider === 'claude') {
      const key = { value: '' };
      const saveKey = () => {
        const v = key.value.trim();
        if (!v.startsWith('sk-ant-')) { toast('Claude API 키는 sk-ant- 로 시작해요.'); return; }
        setAi({ apiKey: v }, 'AI 대화를 켰어요. 이제 Claude가 답해요.');
      };
      panel = [
        ai.apiKey
          ? el('div', { class: 'key-row' }, el('code', null, `${ai.apiKey.slice(0, 7)}…${ai.apiKey.slice(-4)}`),
            el('button', { class: 'link muted-link', onclick: () => setAi({ apiKey: '' }, 'API 키를 지웠어요.') }, '키 삭제'))
          : el('form', { class: 'key-row', onsubmit: (e) => { e.preventDefault(); saveKey(); } },
            el('input', { type: 'password', placeholder: 'sk-ant-…', autocomplete: 'off', 'aria-label': 'Claude API 키', oninput: (e) => { key.value = e.target.value; } }),
            el('button', { class: 'btn primary sm', type: 'submit' }, '저장')),
        el('p', { class: 'hint' }, '키는 이 브라우저의 내 계정에 저장되고, 대화할 때 Anthropic API로만 보내져요. 사용 요금은 키 주인에게 청구돼요. 공용 PC에서는 넣지 마세요.'),
      ];
    } else if (ai.provider === 'ollama') {
      if (ollamaProbe.url !== ai.ollamaUrl && !ollamaProbe.loading) probeOllama(ai.ollamaUrl);
      const url = { value: ai.ollamaUrl };
      const saveUrl = () => {
        const v = window.LLM.normalize({ ollamaUrl: url.value }).ollamaUrl;
        if (!/^https?:\/\//.test(v)) { toast('주소는 http:// 또는 https:// 로 시작해야 해요.'); return; }
        ollamaProbe.url = null; // 같은 주소여도 다시 확인한다
        setAi({ ollamaUrl: v });
      };
      const models = ollamaProbe.models;
      const modelSelect = el('select', { 'aria-label': '로컬 모델', onchange: (e) => setAi({ ollamaModel: e.target.value }, `${e.target.value} 모델로 바꿨어요.`) },
        models.map((m) => el('option', { value: m }, window.LLM.isRecommended(m) ? `${m} (한국어 추천)` : m)));
      modelSelect.value = ai.ollamaModel;
      panel = [
        el('form', { class: 'key-row', onsubmit: (e) => { e.preventDefault(); saveUrl(); } },
          el('input', { type: 'url', value: ai.ollamaUrl, placeholder: window.LLM.OLLAMA_URL, 'aria-label': 'Ollama 주소', oninput: (e) => { url.value = e.target.value; } }),
          el('button', { class: 'btn ghost sm', type: 'submit', disabled: ollamaProbe.loading }, ollamaProbe.loading ? '확인 중…' : '연결 확인')),
        models.length ? field('모델', modelSelect) : null,
        ollamaProbe.error ? el('p', { class: 'error' }, ollamaProbe.error) : null,
        el('p', { class: 'hint' }, 'Ollama가 켜진 이 PC에서만 동작하고, 대화 내용은 이 PC 밖으로 나가지 않아요. ',
          'localhost에서 연 페이지는 바로 되고, GitHub Pages 같은 사이트에서 쓰려면 Ollama를 켜기 전에 환경변수 OLLAMA_ORIGINS에 사이트 주소를 넣어 주세요. ',
          'index.html을 파일로 직접 열면 연결이 막혀요.'),
      ];
    } else if (ai.provider === 'server') {
      const probeKey = `${ai.serverUrl}|${ai.serverKey}`;
      if (ai.serverUrl && serverProbe.key !== probeKey && !serverProbe.loading) probeServer(ai.serverUrl, ai.serverKey);
      const form = { url: ai.serverUrl, key: ai.serverKey };
      const saveServer = () => {
        const v = window.LLM.normalize({ serverUrl: form.url }).serverUrl;
        if (!/^https?:\/\//.test(v)) { toast('주소는 http:// 또는 https:// 로 시작해야 해요.'); return; }
        serverProbe.key = null; // 같은 주소여도 다시 확인한다
        setAi({ serverUrl: v, serverKey: form.key.trim() });
      };
      const st = serverProbe.status;
      const OLLAMA_STATE = { ok: '정상', 'model-missing': '모델 없음', down: '꺼져 있음' };
      panel = [
        el('form', { class: 'server-form', onsubmit: (e) => { e.preventDefault(); saveServer(); } },
          el('input', { type: 'url', value: ai.serverUrl, placeholder: 'https://… 또는 http://localhost:8787', 'aria-label': 'AI 서버 주소', oninput: (e) => { form.url = e.target.value; } }),
          el('div', { class: 'key-row' },
            el('input', { type: 'password', value: ai.serverKey, placeholder: '접근 키 (서버에 정했을 때만)', autocomplete: 'off', 'aria-label': 'AI 서버 접근 키', oninput: (e) => { form.key = e.target.value; } }),
            el('button', { class: 'btn ghost sm', type: 'submit', disabled: serverProbe.loading }, serverProbe.loading ? '확인 중…' : '연결 확인'))),
        st ? el('p', { class: st.ok ? 'hint' : 'error' }, `서버 연결됨 · 모델 ${st.model} · Ollama ${OLLAMA_STATE[st.ollama] || st.ollama}`) : null,
        serverProbe.error ? el('p', { class: 'error' }, serverProbe.error) : null,
        el('p', { class: 'hint' }, '인연노트 AI 서버(server/ai-server.mjs)를 거쳐 서버 주인의 Ollama로 답해요. 키나 요금 없이 누구나 쓸 수 있고, ',
          '대화 내용은 이 서버를 운영하는 사람의 PC로 보내져요.'),
      ];
    }

    const ready = window.LLM.ready(ai);
    return el('section', { class: 'card' },
      el('h2', null, 'AI 대화 설정'),
      providerRow,
      el('p', { class: 'ai-state' }, el('span', { class: `dot-state ${ready ? 'on' : ''}` }),
        ready ? `켜짐 (${window.LLM.label(ai)}) · AI가 캐릭터 답장, 첫 마디 추천, 받은 메시지 안전 검사를 맡아요.`
          : '꺼짐 · 캐릭터는 프로필 기반 기본 대화로 답하고, 안전 검사와 첫 마디 추천은 규칙으로만 해요.'),
      panel);
  }

  function renderMain() {
    if (state.chatId) return renderChat();
    ensureIntroEmbedding();
    const result = compute();
    if (state.detailId) return renderDetail(result);
    const views = { report: () => renderReport(result), me: renderMe, chat: renderChatList };
    const body = (views[state.tab] || (() => renderHome(result)))();
    const tab = (key, icon, label, badge) => el('button', { class: state.tab === key ? 'on' : '', 'aria-current': state.tab === key ? 'page' : null,
      onclick: () => go({ tab: key }) }, el('span', { class: 'tab-icon', 'aria-hidden': 'true' }, icon, badge ? el('em', { class: 'badge-dot' }, badge) : null), label);
    return el('div', { class: 'screen main' },
      el('main', { class: 'content' }, body),
      el('nav', { class: 'tabbar' }, tab('home', '♥', '추천'), tab('chat', '💬', '채팅', state.matches.length || null),
        tab('report', '≡', '리포트'), tab('me', '◉', '내 정보')));
  }

  function render() {
    const app = document.getElementById('app');
    const screens = { signup: renderSignup, login: renderLogin, analyzing: renderAnalyzing, main: renderMain };
    const view = (screens[state.screen] || renderWelcome)();
    const viewKey = [state.screen, state.tab, state.detailId, state.chatId, state.step].join('|');
    const entering = viewKey !== lastView;
    lastView = viewKey;
    if (entering) view.classList.add('enter');
    // 매칭 성공 팝업은 탭 화면뿐 아니라 프로필 상세에서 관심을 보냈을 때도 띄운다
    app.replaceChildren(view, ...(state.screen === 'main' && state.matchModal ? [matchOverlay()] : []));
    if (entering && !calm()) countUp(view);
    const party = app.querySelector('.match-overlay.celebrate');
    if (party && !party.dataset.started && !calm()) {
      party.dataset.started = '1';
      launchConfetti(party.querySelector('.confetti'));
      countUp(party, '.match-score b', 1000, 1100);
      try { if (navigator.vibrate) navigator.vibrate([40, 60, 140]); } catch (e) { /* 진동이 없는 기기 */ }
    }
    // 채팅방: 맨 아래 메시지가 보이게 하고 입력칸에 커서를 둔다
    if (state.screen === 'main' && state.chatId && document.getElementById('messages')) {
      window.scrollTo(0, document.body.scrollHeight);
      const box = document.querySelector('.composer textarea');
      if (box && !state.typing) box.focus({ preventScroll: true });
    }
  }

  load();
  render();
})();
