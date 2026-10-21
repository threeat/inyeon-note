// 받침에 맞는 조사: josa('한식', '을/를') → '한식을', josa('거리', '을/를') → '거리를', josa('서울', '이라/라') → '서울이라'
// 영어·숫자로 끝나면 받침 없는 쪽을 쓴다. '으로/로'는 ㄹ 받침이면 '로'.
(function (root) {
  function josa(word, pair) {
    const w = String(word || '');
    const code = w.charCodeAt(w.length - 1) - 0xac00;
    const jong = code >= 0 && code <= 11171 ? code % 28 : 0;
    const [withBatchim, without] = pair.split('/');
    if (pair === '으로/로') return w + (jong && jong !== 8 ? '으로' : '로');
    return w + (jong ? withBatchim : without);
  }
  const Hangul = { josa };
  root.Hangul = Hangul;
  if (typeof module === 'object' && module.exports) module.exports = Hangul;
})(typeof window !== 'undefined' ? window : globalThis);
