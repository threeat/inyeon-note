// 핵심 로직: 거르기 → 점수 → 순위 → 1위 이유.
// DOM을 건드리지 않는 순수 함수만 둔다. 숫자는 모두 rules.js에서 읽는다.
(function (root) {
  const Rules = root.Rules || (typeof require === 'function' ? require('./rules.js') : null);
  const { REGION_GROUP, OPTIONS, SCORE_RULES, FILTER_RULES } = Rules;
  const RULE = Object.fromEntries(SCORE_RULES.map((r) => [r.key, r]));

  const groupOf = (region) => REGION_GROUP[region] || region;
  const marriageGap = (a, b) => Math.abs(OPTIONS.marriage.indexOf(a) - OPTIONS.marriage.indexOf(b));
  const sharedInterests = (me, p) => p.interests.filter((i) => me.interests.includes(i));
  const detailsOf = (person, category) => (person.interestDetails && person.interestDetails[category]) || [];
  const ageGap = (me, p) => Math.abs(me.age - p.age);
  const inRange = (v, min, max) => v >= min && v <= max;
  const smokeText = (s) => (s ? '흡연' : '비흡연');

  // 성적 지향으로 "관심 있는 성별"을 정한다.
  function interestedIn(person) {
    if (person.orientation === '양성애자') return OPTIONS.genders.slice();
    if (person.orientation === '동성애자') return [person.gender];
    return OPTIONS.genders.filter((g) => g !== person.gender); // 이성애자(기본값)
  }

  // ---------- 1. 거르기 ----------
  // 각 검사는 통과하면 null, 걸리면 "왜 걸렸는지" 문자열을 돌려준다.
  const FILTER_TESTS = {
    self: (me, prefs, p) => (p.id === me.id ? '내 프로필' : null),
    // 양방향 확인: 나 → 상대, 상대 → 나. 상대가 지향을 비공개로 했으면 이유에 지향을 적지 않는다.
    orientation: (me, prefs, p) => {
      if (!interestedIn(me).includes(p.gender)) return `${p.gender} (나의 관심 성별: ${interestedIn(me).join('·')})`;
      if (!interestedIn(p).includes(me.gender)) {
        return p.orientationPublic === false
          ? `${p.gender} (상대의 관심 성별이 아님)`
          : `${p.gender}·${p.orientation} (상대의 관심 성별: ${interestedIn(p).join('·')})`;
      }
      return null;
    },
    age: (me, prefs, p) =>
      inRange(p.age, prefs.ageMin, prefs.ageMax) ? null : `${p.age}세 (희망 ${prefs.ageMin}~${prefs.ageMax}세)`,
    height: (me, prefs, p) =>
      inRange(p.height, prefs.heightMin, prefs.heightMax) ? null : `${p.height}cm (희망 ${prefs.heightMin}~${prefs.heightMax}cm)`,
    smoking: (me, prefs, p) => (p.smoker ? '흡연' : null),
    religion: (me, prefs, p) => (p.religion !== me.religion ? `${p.religion} (나: ${me.religion})` : null),
    region: (me, prefs, p) =>
      groupOf(p.region) !== groupOf(me.region) ? `${p.region}·${groupOf(p.region)} (나: ${me.region}·${groupOf(me.region)})` : null,
    marriage: (me, prefs, p) =>
      marriageGap(me.marriage, p.marriage) === 2 ? `'${p.marriage}' ↔ 나 '${me.marriage}'` : null,
    divorced: (me, prefs, p) => (p.marital && p.marital !== '미혼' ? p.marital : null),
    kids: (me, prefs, p) => (p.marital === '돌싱(자녀 있음)' ? '자녀 있음' : null),
  };

  function applyFilters(me, prefs, pool) {
    let remaining = pool.slice();
    const steps = FILTER_RULES.map((rule) => {
      const active = rule.always || Boolean(prefs.filters[rule.key]);
      const removed = [];
      if (active) {
        remaining = remaining.filter((p) => {
          const why = FILTER_TESTS[rule.key](me, prefs, p);
          if (why) removed.push({ profile: p, why });
          return !why;
        });
      }
      return { key: rule.key, label: rule.label, always: Boolean(rule.always), active, removed };
    });
    return { passed: remaining, steps };
  }

  // ---------- 2. 점수 ----------
  const SCORERS = {
    // 같은 관심사마다: 세부 취향이 겹치거나 한쪽이 안 골랐으면 perItem, 둘 다 골랐는데 안 겹치면 perCategoryOnly
    interests(me, prefs, p, r) {
      const shared = sharedInterests(me, p);
      let points = 0;
      const parts = shared.map((c) => {
        const mine = detailsOf(me, c);
        const theirs = detailsOf(p, c);
        if (!mine.length || !theirs.length) { points += r.perItem; return c; }
        const both = mine.filter((d) => theirs.includes(d));
        if (both.length) { points += r.perItem; return `${c}[${both.join('·')}]`; }
        points += r.perCategoryOnly;
        return `${c}[취향 다름: ${theirs.join('·')}]`;
      });
      const detail = shared.length ? `공통 관심사 ${shared.length}개: ${parts.join(', ')}` : '겹치는 관심사 없음';
      return { points: Math.min(points, r.max), detail };
    },
    marriage(me, prefs, p, r) {
      const gap = marriageGap(me.marriage, p.marriage);
      const detail = gap === 0 ? `둘 다 '${p.marriage}'`
        : `'${p.marriage}' vs 나 '${me.marriage}' (${gap === 1 ? '한 단계 차이' : '정반대'})`;
      return { points: r.byGap[gap], detail };
    },
    looks(me, prefs, p, r) {
      const styleOk = prefs.styles.includes(p.style);
      const heightOk = inRange(p.height, prefs.heightMin, prefs.heightMax);
      const points = (styleOk ? r.style : 0) + (heightOk ? r.height : 0);
      const detail = `스타일 '${p.style}' ${styleOk ? '선호 ✓' : '선호 아님'}, ` +
        `키 ${p.height}cm ${heightOk ? '희망 범위 안 ✓' : '희망 범위 밖'}`;
      return { points, detail };
    },
    region(me, prefs, p, r) {
      if (p.region === me.region) return { points: r.same, detail: `둘 다 ${p.region}` };
      if (groupOf(p.region) === groupOf(me.region))
        return { points: r.sameGroup, detail: `${p.region} vs 나 ${me.region} (같은 ${groupOf(p.region)})` };
      return { points: 0, detail: `${p.region}(${groupOf(p.region)}) vs 나 ${me.region}(${groupOf(me.region)})` };
    },
    age(me, prefs, p, r) {
      const gap = ageGap(me, p);
      const hit = r.steps.find(([limit]) => gap <= limit);
      return { points: hit ? hit[1] : 0, detail: `${p.age}세, 나와 ${gap === 0 ? '동갑' : `${gap}살 차`}` };
    },
    religion(me, prefs, p, r) {
      return p.religion === me.religion
        ? { points: r.same, detail: `둘 다 ${p.religion}` }
        : { points: 0, detail: `${p.religion} vs 나 ${me.religion}` };
    },
    lifestyle(me, prefs, p, r) {
      const smokeOk = p.smoker === me.smoker;
      const drinkOk = p.drinking === me.drinking;
      const points = (smokeOk ? r.smoking : 0) + (drinkOk ? r.drinking : 0);
      const detail = `흡연 ${smokeOk ? `같음(${smokeText(p.smoker)})` : `다름(${smokeText(p.smoker)})`}, ` +
        `음주 ${drinkOk ? `같음(${p.drinking})` : `다름(${p.drinking} vs ${me.drinking})`}`;
      return { points, detail };
    },
  };

  // ---------- 가중치: 사용자가 고른 중요도로 각 항목의 만점을 다시 나눈다 (합계는 항상 100) ----------
  const weightOf = (weights, key) => {
    const v = weights && weights[key];
    return typeof v === 'number' && v >= 0 ? v : 1; // 정하지 않았으면 '보통'
  };
  function effectiveMax(weights) {
    let raw = SCORE_RULES.map((r) => r.max * weightOf(weights, r.key));
    let sum = raw.reduce((a, b) => a + b, 0);
    if (sum === 0) { raw = SCORE_RULES.map((r) => r.max); sum = 100; } // 전부 '안 봄'이면 기본 점수표로
    const exact = raw.map((x) => (x / sum) * 100);
    const maxes = exact.map(Math.floor);
    // 반올림 오차는 소수점이 큰 항목부터 1점씩 채워 합계를 정확히 100으로 맞춘다
    let left = 100 - maxes.reduce((a, b) => a + b, 0);
    exact.map((x, i) => [x - maxes[i], i]).sort((a, b) => b[0] - a[0]).forEach(([frac, i]) => {
      if (left > 0 && frac > 0) { maxes[i] += 1; left -= 1; }
    });
    return Object.fromEntries(SCORE_RULES.map((r, i) => [r.key, maxes[i]]));
  }

  function scoreProfile(me, prefs, p) {
    const maxes = effectiveMax(prefs.weights);
    const items = SCORE_RULES.map((r) => {
      const base = SCORERS[r.key](me, prefs, p, r); // 기본 점수표 기준 점수
      const max = maxes[r.key];
      return { key: r.key, label: r.label, max, weight: weightOf(prefs.weights, r.key),
        points: Math.round((base.points / r.max) * max), detail: base.detail };
    });
    return {
      profile: p,
      items,
      total: items.reduce((sum, it) => sum + it.points, 0),
      sharedCount: sharedInterests(me, p).length,
      ageGap: ageGap(me, p),
    };
  }

  // ---------- 3. 순위 (동점 규칙 포함) ----------
  // 어떤 규칙으로 순서가 갈렸는지도 함께 돌려준다.
  function compare(a, b) {
    if (a.total !== b.total) return { diff: b.total - a.total, by: 'total' };
    if (a.sharedCount !== b.sharedCount) return { diff: b.sharedCount - a.sharedCount, by: 'interests' };
    if (a.ageGap !== b.ageGap) return { diff: a.ageGap - b.ageGap, by: 'age' };
    return { diff: a.profile.name.localeCompare(b.profile.name, 'ko'), by: 'name' };
  }

  const rank = (scored) => scored.slice().sort((a, b) => compare(a, b).diff);

  // ---------- 4. 1위의 이유 ----------
  function explainWinner(ranked) {
    if (!ranked.length) return null;
    const w = ranked[0];
    const name = w.profile.name;
    const lines = [];
    const headline = `${name}님이 ${w.total}점(100점 만점)으로 1위입니다.`;

    if (ranked.length === 1) {
      lines.push(`거르기 조건을 모두 통과한 사람이 ${name}님 한 명뿐입니다.`);
    } else {
      const s = ranked[1];
      const sName = s.profile.name;
      const gap = w.total - s.total;
      const { by } = compare(w, s);

      if (gap > 0) {
        lines.push(`2위 ${sName}님(${s.total}점)보다 ${gap}점 높습니다.`);
      } else if (by === 'interests') {
        lines.push(`2위 ${sName}님과 ${w.total}점 동점이지만, 동점일 때는 최우선 항목인 관심사를 먼저 봅니다. ` +
          `겹친 관심사가 ${w.sharedCount}개로 ${sName}님(${s.sharedCount}개)보다 많아 1위입니다.`);
      } else if (by === 'age') {
        lines.push(`2위 ${sName}님과 총점도, 겹친 관심사 개수(${w.sharedCount}개)도 같습니다. ` +
          `그다음 규칙인 나이 차에서 ${w.ageGap}살 차로 ${sName}님(${s.ageGap}살 차)보다 가까워 1위입니다.`);
      } else {
        lines.push(`2위 ${sName}님과 총점, 관심사 개수, 나이 차가 모두 같아 이름순으로 1위가 됐습니다.`);
      }

      // 항목별로 2위와 비교
      const sItem = Object.fromEntries(s.items.map((it) => [it.key, it]));
      const ahead = [];
      const behind = [];
      w.items.forEach((it) => {
        const d = it.points - sItem[it.key].points;
        if (d > 0) ahead.push({ it, other: sItem[it.key], d });
        if (d < 0) behind.push({ it, other: sItem[it.key], d });
      });
      ahead.sort((a, b) => b.d - a.d);
      ahead.forEach(({ it, other, d }) => {
        lines.push(`${it.label}에서 +${d}점: ${it.detail} → ${it.points}점. 2위는 ${other.detail} → ${other.points}점.`);
      });
      if (behind.length) {
        const list = behind.map(({ it, d }) => `${it.label} ${d}점`).join(', ');
        lines.push(`반대로 ${list}로 2위에게 졌지만, 위 항목에서 더 크게 앞서서 1위를 지켰습니다.`);
      }
    }

    const top = w.items.slice().sort((a, b) => b.points - a.points)[0];
    lines.push(`점수가 가장 많이 나온 항목은 ${top.label}(${top.points}/${top.max}점)입니다: ${top.detail}.`);
    const full = w.items.filter((it) => it.max > 0 && it.points === it.max).map((it) => it.label);
    if (full.length) lines.push(`만점 항목: ${full.join(', ')}.`);
    const custom = w.items.filter((it) => it.weight !== 1);
    if (custom.length) {
      const level = (v) => (Rules.WEIGHT_LEVELS.find((l) => l.value === v) || { label: `×${v}` }).label;
      lines.push(`내가 정한 중요도가 반영됐어요: ${custom.map((it) => `${it.label} '${level(it.weight)}'(만점 ${it.max}점)`).join(', ')}.`);
    }

    return { headline, lines };
  }

  // ---------- 0명일 때 안내 ----------
  function emptyNotice(steps) {
    // 사용자가 끄거나 넓힐 수 있는 조건을 먼저 짚는다. 성별처럼 항상 적용되는 조건은 그다음.
    const blockers = steps.filter((s) => s.key !== 'self' && s.removed.length)
      .sort((a, b) => (a.always - b.always) || (b.removed.length - a.removed.length));
    if (!blockers.length) return '조건을 통과한 사람이 0명입니다. 후보 프로필이 없습니다.';
    const top = blockers[0];
    const hint = top.always
      ? '서로 관심 있는 성별의 회원이 아직 없어요. 내 성별과 성적 지향 설정이 맞는지 확인해 보세요.'
      : '이 조건을 끄거나 범위를 넓혀 보세요.';
    return `조건에 맞는 사람이 0명이라 추천할 상대가 없습니다. ` +
      `가장 많은 사람을 걸러낸 조건은 '${top.label}'(${top.removed.length}명)입니다. ${hint}`;
  }

  // ---------- 전체 흐름 ----------
  function recommend(me, prefs, profiles) {
    const pool = [me, ...profiles]; // 나도 후보 목록에 넣고, 거르기 0단계에서 확실히 뺀다.
    const { passed, steps } = applyFilters(me, prefs, pool);
    const ranked = rank(passed.map((p) => scoreProfile(me, prefs, p)));
    return {
      poolSize: pool.length,
      steps,
      ranked,
      explanation: explainWinner(ranked),
      notice: ranked.length ? null : emptyNotice(steps),
    };
  }

  // ---------- 매칭: 관심을 보냈을 때 상대가 수락하는지 ----------
  function matchResult(scored) {
    const { threshold } = Rules.MATCH_RULE;
    const matched = scored.total >= threshold;
    return {
      matched,
      reason: matched
        ? `궁합 ${scored.total}점 ≥ ${threshold}점이라 ${scored.profile.name}님도 수락했어요.`
        : `궁합 ${scored.total}점 < ${threshold}점이라 ${scored.profile.name}님이 아직 답하지 않았어요.`,
    };
  }

  const Matcher = { recommend, applyFilters, scoreProfile, rank, explainWinner, interestedIn, matchResult, effectiveMax };
  root.Matcher = Matcher;
  if (typeof module === 'object' && module.exports) module.exports = Matcher;
})(typeof window !== 'undefined' ? window : globalThis);
