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
    job: '', edu: '대졸', intro: '',
  };
  const DEFAULT_PREFS = {
    ageMin: 24, ageMax: 31, heightMin: 155, heightMax: 175, styles: ['귀여운', '단정한'],
    filters: Object.fromEntries(FILTER_RULES.filter((f) => !f.always).map((f) => [f.key, f.defaultOn])),
  };

  const state = {
    account: null,     // 로그인한 이메일
    me: null, prefs: null, likes: [],
    matches: [], chats: {}, apiKey: '', // 매칭된 회원 id, 회원별 대화, 캐릭터 대화용 Claude API 키
    chatId: null, chatDraft: '', typing: false, matchModal: null,
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
    const me = { orientation: '이성애자', orientationPublic: true, marital: '미혼', interestDetails: {}, ...data.me };
    const prefs = { ...data.prefs, filters: { ...DEFAULT_PREFS.filters, ...data.prefs.filters } };
    Object.assign(state, { account: email, me, prefs, likes: data.likes || [],
      matches: data.matches || [], chats: data.chats || {}, apiKey: data.apiKey || '' });
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
      matches: state.matches, chats: state.chats, apiKey: state.apiKey };
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
    go({ account: null, me: null, prefs: null, likes: [], matches: [], chats: {}, apiKey: '', chatId: null, chatDraft: '', matchModal: null,
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
  function toggleLike(p) {
    if (isMatched(p.id)) { openChat(p.id); return; }
    if (isLiked(p.id)) {
      state.likes = state.likes.filter((x) => x !== p.id);
      save();
      toast(`${p.name}님에게 보낸 관심을 취소했어요`);
      render();
      return;
    }
    state.likes = [...state.likes, p.id];
    const scored = compute().ranked.find((r) => r.profile.id === p.id);
    const result = scored ? window.Matcher.matchResult(scored) : { matched: false, reason: '' };
    if (result.matched) {
      state.matches = [...state.matches, p.id];
      state.chats[p.id] = [
        { from: 'system', text: `💕 매칭 성공! ${result.reason}`, at: Date.now() },
        { from: 'them', text: window.Chat.greeting(p, state.me), at: Date.now() },
      ];
      state.matchModal = { id: p.id, reason: result.reason };
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

  function openChat(id) { go({ screen: 'main', tab: 'chat', detailId: null, chatId: id, matchModal: null, chatDraft: '' }); }

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
      Object.assign(state, { account: email, me, prefs, likes: [], matches: [], chats: {}, apiKey: '' });
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
      return [head, el('section', { class: 'card empty' },
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

    return [head, hero, list];
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
      el('section', { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', null, '내 프로필'), el('button', { class: 'link', onclick: () => startSignup('basic', 'me') }, '수정')),
        el('dl', { class: 'info' }, row('성별', me.gender), row('성적 지향', `${me.orientation}${me.orientationPublic ? '' : ' (비공개)'}`), row('종교', me.religion), row('흡연', me.smoker ? '흡연' : '비흡연'),
          row('음주', me.drinking), row('결혼 계획', me.marriage), row('결혼 경험', me.marital), row('스타일', me.style))),
      el('section', { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', null, '자기소개'), el('button', { class: 'link', onclick: () => startSignup('intro', 'me') }, me.intro ? '수정' : '쓰기')),
        me.intro ? el('p', { class: 'me-intro' }, me.intro) : null,
        introStatus('me')),
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
          el('button', { class: 'liked-item', onclick: () => go({ tab: 'home', detailId: p.id }) }, photo(p, 'sm'), el('span', null, p.name))))
          : el('p', { class: 'hint' }, '마음에 드는 분에게 관심을 보내 보세요.')),
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
    const rows = state.matches.map(profileById).filter(Boolean);
    return [
      el('header', { class: 'page-head' }, el('h1', null, '채팅'),
        el('p', { class: 'sub' }, state.apiKey
          ? 'AI 대화 켜짐 · Claude가 회원의 프로필대로 답해요.'
          : '기본 대화 모드 · 내 정보에서 Claude API 키를 넣으면 진짜 대화처럼 바뀌어요.')),
      rows.length
        ? el('ul', { class: 'chat-list' }, rows.map((p) => {
          const last = [...(state.chats[p.id] || [])].reverse().find((m) => m.from !== 'system');
          return el('li', null, el('button', { class: 'chat-row', onclick: () => openChat(p.id) },
            photo(p, 'sm'),
            el('span', { class: 'cr-main' }, el('b', null, p.name),
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
    const log = state.chats[p.id];
    log.push({ from: 'me', text, at: Date.now() });
    state.chatDraft = '';
    state.typing = true;
    save();
    render();
    const started = Date.now();
    const res = await window.Chat.reply({ apiKey: state.apiKey, profile: p, me: state.me, history: log });
    const wait = 600 + Math.min(text.length * 15, 900) - (Date.now() - started); // 상대가 입력하는 듯한 짧은 간격
    if (wait > 0) await sleep(wait);
    if (res.error) log.push({ from: 'system', text: `AI 연결 실패: ${res.error} 이번 답은 기본 대화로 보냈어요.`, at: Date.now() });
    log.push({ from: 'them', text: res.text, at: Date.now() });
    state.typing = false;
    save();
    if (state.screen === 'main') render();
  }

  function renderChat() {
    const p = profileById(state.chatId);
    if (!p || !isMatched(p.id)) { state.chatId = null; return renderMain(); }
    const log = state.chats[p.id] || [];
    const input = el('textarea', { rows: 1, placeholder: `${p.name}님에게 메시지 보내기`, maxlength: 500, 'aria-label': '메시지',
      oninput: (e) => { state.chatDraft = e.target.value; } });
    input.value = state.chatDraft;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(p); } // 한글 조합 중 Enter는 무시
    });
    return el('div', { class: 'screen chat-room' },
      el('header', { class: 'bar chat-head' },
        el('button', { class: 'icon-btn', 'aria-label': '채팅 목록으로', onclick: () => go({ chatId: null, chatDraft: '' }) }, '‹'),
        el('button', { class: 'chat-who', onclick: () => go({ chatId: null, tab: 'home', detailId: p.id }) },
          photo(p, 'xs'),
          el('span', null, el('b', null, p.name), el('small', null, state.apiKey ? 'AI 캐릭터 · Claude 대화' : 'AI 캐릭터 · 기본 대화')))),
      el('div', { class: 'messages', id: 'messages', 'aria-live': 'polite' },
        el('p', { class: 'msg-system' }, `${p.name}님은 이 앱의 가상 회원(AI 캐릭터)이에요. 개인정보나 돈 얘기는 하지 마세요.`),
        log.map((m) => (m.from === 'system'
          ? el('p', { class: 'msg-system' }, m.text)
          : el('div', { class: `msg ${m.from}` },
            m.from === 'them' ? photo(p, 'xs') : null,
            el('p', { class: 'bubble' }, m.text),
            el('time', null, timeText(m.at))))),
        state.typing ? el('div', { class: 'msg them' }, photo(p, 'xs'),
          el('p', { class: 'bubble typing', 'aria-label': `${p.name}님이 입력 중` }, el('i'), el('i'), el('i'))) : null),
      el('form', { class: 'composer', onsubmit: (e) => { e.preventDefault(); sendMessage(p); } },
        input,
        el('button', { class: 'send', type: 'submit', 'aria-label': '보내기', disabled: state.typing }, '↑')));
  }

  function matchOverlay() {
    const p = profileById(state.matchModal.id);
    const close = () => { state.matchModal = null; render(); };
    return el('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': '매칭 성공' },
      el('div', { class: 'match-card' },
        el('p', { class: 'match-title' }, '매칭 성공!'),
        el('div', { class: 'match-photos' }, photo(state.me, 'md'), el('span', { class: 'match-heart' }, '♥'), photo(p, 'md')),
        el('p', null, `${p.name}님도 ${state.me.name}님에게 관심을 보였어요.`),
        el('small', null, state.matchModal.reason),
        el('button', { class: 'btn primary', onclick: () => openChat(p.id) }, '💬 대화 시작하기'),
        el('button', { class: 'link', onclick: close }, '나중에 할게요')));
  }

  function aiSettings() {
    const key = { value: '' };
    const masked = state.apiKey ? `${state.apiKey.slice(0, 7)}…${state.apiKey.slice(-4)}` : '';
    const saveKey = () => {
      const v = key.value.trim();
      if (!v.startsWith('sk-ant-')) { toast('Claude API 키는 sk-ant- 로 시작해요.'); return; }
      state.apiKey = v;
      if (save()) toast('AI 대화를 켰어요. 이제 캐릭터가 Claude로 답해요.');
      render();
    };
    return el('section', { class: 'card' },
      el('h2', null, 'AI 대화 설정'),
      el('p', { class: 'ai-state' }, el('span', { class: `dot-state ${state.apiKey ? 'on' : ''}` }),
        state.apiKey ? `켜짐 · 캐릭터 답장을 Claude(${window.Chat.MODEL})가 만들어요.` : '꺼짐 · 지금은 프로필 기반 기본 대화로 답해요.'),
      state.apiKey
        ? el('div', { class: 'key-row' }, el('code', null, masked),
          el('button', { class: 'link muted-link', onclick: () => { state.apiKey = ''; save(); toast('API 키를 지웠어요.'); render(); } }, '키 삭제'))
        : el('form', { class: 'key-row', onsubmit: (e) => { e.preventDefault(); saveKey(); } },
          el('input', { type: 'password', placeholder: 'sk-ant-…', autocomplete: 'off', 'aria-label': 'Claude API 키', oninput: (e) => { key.value = e.target.value; } }),
          el('button', { class: 'btn primary sm', type: 'submit' }, '저장')),
      el('p', { class: 'hint' }, '키는 이 브라우저의 내 계정에 저장되고, 대화할 때 Anthropic API로만 보내져요. 사용 요금은 키 주인에게 청구돼요. 공용 PC에서는 넣지 마세요.'));
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
        tab('report', '≡', '리포트'), tab('me', '◉', '내 정보')),
      state.matchModal ? matchOverlay() : null);
  }

  function render() {
    const app = document.getElementById('app');
    const screens = { signup: renderSignup, login: renderLogin, analyzing: renderAnalyzing, main: renderMain };
    const view = (screens[state.screen] || renderWelcome)();
    app.replaceChildren(view);
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
