// 점수표와 거르기 규칙. 점수에 쓰는 숫자는 모두 이 파일에만 둔다.
// 화면(app.js)과 테스트가 같은 값을 읽기 때문에, 여기만 고치면 전부 바뀐다.
(function (root) {
  const REGION_GROUP = {
    서울: '수도권', 경기: '수도권', 인천: '수도권',
    대전: '충청권',
    부산: '영남권', 대구: '영남권',
    광주: '호남권',
  };

  const OPTIONS = {
    genders: ['여성', '남성'],
    orientations: ['이성애자', '동성애자', '양성애자'],
    marital: ['미혼', '돌싱(자녀 없음)', '돌싱(자녀 있음)'],
    regions: Object.keys(REGION_GROUP),
    religions: ['무교', '기독교', '천주교', '불교'],
    drinking: ['안 마심', '가끔', '자주'],
    marriage: ['1~2년 내', '3~5년 내', '생각 없음'],
    styles: ['귀여운', '단정한', '시크한', '스포티한', '지적인'],
    interests: ['등산', '요리', '영화', '독서', '게임', '여행', '카페', '운동', '음악', '사진', '반려동물', '전시회'],
    // 관심사별 세부 취향 (고르지 않아도 됨)
    interestDetails: {
      등산: ['근교 산', '명산 종주', '둘레길', '클라이밍'],
      요리: ['한식', '양식', '일식', '베이킹', '비건'],
      영화: ['로맨스', '액션', '스릴러·공포', 'SF·판타지', '코미디', '애니메이션', '다큐'],
      독서: ['소설', '에세이', '자기계발', '인문·역사', '과학'],
      게임: ['RPG', 'FPS·슈팅', '전략', '퍼즐·캐주얼', '콘솔', '보드게임'],
      여행: ['국내', '해외', '캠핑', '호캉스', '배낭여행'],
      카페: ['디저트 맛집', '조용한 작업 카페', '뷰 맛집', '핸드드립'],
      운동: ['헬스', '러닝', '수영', '요가·필라테스', '테니스', '클라이밍'],
      음악: ['발라드', 'K-POP', '힙합', '인디·밴드', '재즈', '클래식'],
      사진: ['필름 카메라', '풍경', '인물', '스마트폰'],
      반려동물: ['강아지', '고양이', '그 외 동물'],
      전시회: ['미술', '사진전', '팝업스토어', '박물관'],
    },
  };

  // 표시 순서 = 배열 순서. max의 합은 100.
  const SCORE_RULES = [
    {
      key: 'interests', label: '관심사', max: 35, perItem: 10, perCategoryOnly: 6,
      rule: '겹치는 관심사 1개당 10점 (최대 35점). 둘 다 세부 취향(장르 등)을 골랐는데 하나도 안 겹치면 6점',
      why: '최우선 항목. 공통 관심사가 있어야 대화와 데이트가 생긴다. 같은 영화라도 장르가 다르면 함께 즐기기 어려워 조금 덜 준다.',
    },
    {
      // 유사도 = 자기소개 임베딩에서 평균 벡터를 뺀 코사인 (js/intro-embed.js). 구간은 가상 회원 190쌍의 분포로 정했다:
      // 0.18 이상은 상위 약 3%, 0.10 이상은 상위 약 10%, 0.03 이상은 상위 약 20%.
      key: 'intro', label: '자기소개', max: 10, steps: [[0.18, 10, '아주 비슷해요'], [0.10, 6, '꽤 비슷해요'], [0.03, 3, '조금 비슷해요']],
      rule: '자기소개의 뜻이 아주 비슷하면 10점, 꽤 비슷하면 6점, 조금 비슷하면 3점 (AI 문장 임베딩으로 비교)',
      why: '같은 단어를 고르지 않아도 좋아하는 하루, 데이트 분위기가 닮은 사람을 찾는다. 짧은 글로 판단하므로 비중은 작게 뒀다.',
    },
    {
      key: 'marriage', label: '결혼관', max: 15, byGap: [15, 7, 0],
      rule: '같으면 15점, 한 단계 차이 7점, 정반대 0점',
      why: '관계의 방향이 맞는지를 본다. 장기적으로 중요하지만 첫 만남의 재미보다는 뒤에 둔다.',
    },
    {
      key: 'looks', label: '외모', max: 5, style: 3, height: 2,
      rule: '선호 스타일이면 3점 + 키가 희망 범위 안이면 2점',
      why: '첫인상은 중요하지만 사진만으로는 판단하기 어려워 비중을 낮췄다. 본인이 고른 스타일보다 직접 쓴 자기소개가 더 많은 걸 알려 준다.',
    },
    {
      key: 'region', label: '거리', max: 10, same: 10, sameGroup: 5,
      rule: '같은 지역 10점, 같은 권역 5점',
      why: '자주 만날 수 있어야 관계가 이어진다.',
    },
    {
      key: 'age', label: '나이 차', max: 10, steps: [[2, 10], [4, 6], [6, 3]],
      rule: '2살 이내 10점, 4살 이내 6점, 6살 이내 3점',
      why: '나이가 비슷하면 겪는 일과 문화가 비슷해 공감대가 생기기 쉽다.',
    },
    {
      key: 'religion', label: '종교', max: 10, same: 10,
      rule: '같으면 10점',
      why: '종교가 같으면 생활 방식과 가치관이 겹칠 가능성이 크다.',
    },
    {
      key: 'lifestyle', label: '생활습관', max: 5, smoking: 3, drinking: 2,
      rule: '흡연 여부 같으면 3점 + 음주 빈도 같으면 2점',
      why: '데이트에서 바로 드러나지만 맞춰 갈 수 있는 부분이라 작게 줬다.',
    },
  ];

  // 적용 순서 = 배열 순서. always: 끌 수 없는 조건.
  const FILTER_RULES = [
    { key: 'self', label: '나 자신', always: true, why: '나를 나에게 추천하지 않는다.' },
    {
      key: 'orientation', label: '서로 관심 있는 성별이 아님', always: true,
      why: '성적 지향을 존중해, 내가 상대의 성별에 관심이 있고 상대도 내 성별에 관심이 있을 때만 추천한다.',
    },
    { key: 'age', label: '희망 나이 범위 밖', toggle: '희망 나이 범위 밖이면 제외', defaultOn: true },
    { key: 'height', label: '희망 키 범위 밖', toggle: '희망 키 범위 밖이면 제외', defaultOn: false },
    { key: 'smoking', label: '흡연자', toggle: '흡연자 제외', defaultOn: true },
    { key: 'religion', label: '종교가 다름', toggle: '나와 종교가 다르면 제외', defaultOn: false },
    { key: 'region', label: '다른 권역', toggle: '나와 다른 권역이면 제외', defaultOn: false },
    { key: 'marriage', label: '결혼관이 정반대', toggle: '결혼관이 정반대면 제외 (1~2년 내 ↔ 생각 없음)', defaultOn: true },
    { key: 'divorced', label: '돌싱', toggle: '돌싱(이혼 경험)이면 제외', defaultOn: false },
    { key: 'kids', label: '자녀가 있음', toggle: '자녀가 있으면 제외', defaultOn: false },
  ];

  // 사용자가 고르는 항목별 중요도. 위 점수표의 만점에 곱한 뒤, 합이 100점이 되도록 비례로 다시 나눈다.
  const WEIGHT_LEVELS = [
    { value: 0, label: '안 봄' },
    { value: 0.5, label: '조금' },
    { value: 1, label: '보통' },
    { value: 2, label: '중요' },
    { value: 3, label: '매우 중요' },
  ];

  // 자기소개 항목: 비교할 수 없을 때(내가 소개를 안 썼거나 AI 모델을 아직 못 불러옴)는 이 항목을 빼고
  // 나머지 항목으로 100점을 다시 나눈다. 근거로 보여 줄 가장 비슷한 문장 쌍의 최소 유사도.
  const INTRO_RULE = { sentenceMin: 0.15 };

  const TIE_BREAK ='총점 → 겹친 관심사 개수 → 나이 차가 적은 순 → 이름순';

  // 관심을 보냈을 때 상대가 수락하는 규칙. 가상 회원은 직접 답할 수 없어서 같은 궁합 점수를 상대의 마음으로 본다.
  // 질문 카드나 자기소개에 한마디를 남기면 기준을 noteBonus만큼 낮춘다. 그냥 누른 관심보다 진심이 전해지기 때문이다.
  const MATCH_RULE = {
    threshold: 50,
    noteBonus: 5,
    rule: '내가 관심을 보낸 분과 궁합 점수가 50점 이상이면 상대도 수락해 매칭돼요. 한마디를 남기면 45점부터 매칭돼요.',
  };

  const Rules = { REGION_GROUP, OPTIONS, SCORE_RULES, FILTER_RULES, WEIGHT_LEVELS, INTRO_RULE, TIE_BREAK, MATCH_RULE };
  root.Rules = Rules;
  if (typeof module === 'object' && module.exports) module.exports = Rules;
})(typeof window !== 'undefined' ? window : globalThis);
