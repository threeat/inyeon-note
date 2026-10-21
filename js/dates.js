// 매칭 뒤 대화를 만남으로 잇는 도구.
// - 데이트 제안: 공통 관심사·세부 취향과 사는 곳으로 코스를 짠다. 실제 가게 이름은 지어내지 않는다.
// - 내 차례: 마지막 메시지를 누가 보냈는지로 답장할 차례를 알려 준다.
(function (root) {
  const Rules = root.Rules || (typeof require === 'function' ? require('./rules.js') : null);
  const { josa } = root.Hangul || (typeof require === 'function' ? require('./hangul.js') : null);
  const groupOf = (r) => Rules.REGION_GROUP[r] || r;
  const detailsOf = (person, c) => (person.interestDetails && person.interestDetails[c]) || [];

  // 관심사(·세부 취향)별 코스. 더 구체적인 세부 취향 코스가 있으면 그것을 쓴다.
  const COURSES = {
    등산: { _: '오전에 가벼운 산행 → 내려와서 따뜻한 밥 한 끼', '근교 산': '아침 일찍 근교 산 한 바퀴 → 산 아래 국밥이나 칼국수', 둘레길: '둘레길 천천히 걷기 → 근처 카페에서 쉬기', '명산 종주': '당일치기 명산 코스 → 하산 후 뒤풀이 식사' },
    요리: { _: '시장에서 장 보기 → 원데이 쿠킹 클래스', 베이킹: '베이킹 원데이 클래스 → 만든 빵 들고 공원 피크닉', 한식: '잘하는 한식집 한 곳씩 추천해서 가 보기', 일식: '오마카세나 초밥집 → 근처 산책', 양식: '파스타 맛집 → 와인 대신 디저트 카페' },
    영화: { _: '보고 싶던 영화 한 편 → 근처에서 감상 나누며 저녁', 애니메이션: '애니메이션 극장판 → 굿즈숍 구경', '스릴러·공포': '공포 영화 → 밝은 카페에서 마음 진정하기', 로맨스: '로맨스 영화 → 야경 산책' },
    카페: { _: '서로 좋아하는 카페 한 곳씩 들르는 카페 투어', '디저트 맛집': '디저트 맛집 두 곳 투어', 핸드드립: '핸드드립 카페에서 원두 골라 보기', '뷰 맛집': '노을 시간에 맞춰 뷰 좋은 카페' },
    전시회: { _: '전시 한 곳 → 카페에서 느낀 점 이야기하기', 미술: '미술관 관람 → 기념품숍 → 근처 카페', 사진전: '사진전 관람 → 골목 산책하며 사진 찍기' },
    음악: { _: '작은 공연장 라이브 → 근처에서 늦은 저녁', 재즈: '재즈 바 라이브 (술은 선택)', '인디·밴드': '인디 밴드 공연 → 공연 이야기하며 야식' },
    운동: { _: '같이 몸 풀 수 있는 가벼운 운동 → 건강한 한 끼', 러닝: '강변 아침 러닝 → 브런치', 테니스: '테니스 레슨 체험 → 시원한 음료', 클라이밍: '실내 클라이밍 체험 → 저녁 식사' },
    여행: { _: '당일치기 근교 나들이', 캠핑: '당일 캠핑장 피크닉', 국내: '기차 타고 당일치기 소도시 여행' },
    게임: { _: '보드게임 카페', 보드게임: '보드게임 카페에서 새 게임 배우기', 콘솔: '게임 카페에서 협동 게임' },
    독서: { _: '서점 데이트 → 서로 책 한 권씩 골라 주기' },
    사진: { _: '골목 산책하며 서로 사진 찍어 주기', '필름 카메라': '필름 카메라 들고 골목 출사 → 현상소 들르기' },
    반려동물: { _: '반려동물 동반 카페나 공원 산책' },
  };

  // 어디서 만날지: 사는 곳이 같으면 동네, 같은 권역이면 중간, 멀면 첫 만남은 짧게
  function placeLine(me, p) {
    if (me.region === p.region) return `둘 다 ${josa(p.region, '이라/라')} 가까운 데로 잡으면 좋겠어요.`;
    if (groupOf(me.region) === groupOf(p.region)) return `${josa(me.region, '과/와')} ${p.region} 사이 오가기 편한 곳으로 잡아 봐요.`;
    return `${josa(me.region, '과/와')} ${josa(p.region, '이/가')} 멀어서, 처음엔 한 분 동네에서 짧게 만나도 좋아요.`;
  }

  // 데이트 제안 최대 3개: [{ title, plan, why, message }]
  function ideas(me, p) {
    const shared = p.interests.filter((c) => me.interests.includes(c));
    const place = placeLine(me, p);
    const first = (plan) => plan.split(' → ')[0];
    const out = [];
    shared.forEach((c) => {
      const course = COURSES[c];
      if (!course) return;
      const same = detailsOf(p, c).find((d) => detailsOf(me, c).includes(d) && course[d]);
      const key = same || detailsOf(p, c).find((d) => course[d]) || '_';
      const plan = course[key];
      out.push({
        title: key === '_' ? c : `${c} · ${key}`,
        plan,
        why: same ? `${c} 중에서도 ${josa(same, '을/를')} 둘 다 좋아해요.` : key === '_' ? `둘 다 ${josa(c, '을/를')} 좋아해요.` : `${p.name}님이 ${josa(key, '을/를')} 좋아해요.`,
        message: `${p.name}님, ${same ? `우리 둘 다 ${same} 좋아하니까` : `${key === '_' ? c : key} 좋아하시니까`} '${first(plan)}' 같이 해 볼래요? ${place}`,
      });
    });
    if (!out.length) {
      const theirs = p.interests.find((c) => COURSES[c]);
      if (theirs) {
        const plan = COURSES[theirs]._;
        out.push({ title: `${theirs} (상대 관심사)`, plan, why: `${p.name}님이 좋아하는 ${josa(theirs, '을/를')} 같이 해 봐요.`,
          message: `${p.name}님, ${theirs} 좋아하신다고 해서요. '${first(plan)}' 같이 해 볼래요? ${place}` });
      }
      out.push({ title: '가벼운 첫 만남', plan: '낮 시간 카페에서 1시간 → 마음이 맞으면 산책', why: '처음엔 짧고 밝은 시간이 서로 편해요.',
        message: `${p.name}님, 낮에 커피 한잔 어때요? ${place}` });
    }
    return out.slice(0, 3);
  }

  // 대화 상태: 'mine'(내 차례) | 'theirs'(상대 차례) | 'new'(아직 아무도 말 안 함)
  function turnOf(log) {
    const last = [...(log || [])].reverse().find((m) => m.from === 'me' || m.from === 'them');
    if (!last) return 'new';
    return last.from === 'them' ? 'mine' : 'theirs';
  }

  // 처음 만날 때 안전 수칙 (데이트 제안과 함께 보여 준다)
  const SAFETY_TIPS = ['첫 만남은 낮에, 사람이 많은 곳에서', '오가는 길은 각자 해결하고 집 주소는 알려 주지 않기', '친구에게 만나는 장소와 시간 알려 두기', '만나기 전에 돈을 빌려 달라는 말은 무조건 거절'];

  const Dates = { ideas, turnOf, SAFETY_TIPS, COURSES };
  root.Dates = Dates;
  if (typeof module === 'object' && module.exports) module.exports = Dates;
})(typeof window !== 'undefined' ? window : globalThis);
