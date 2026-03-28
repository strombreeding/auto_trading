import { ADX } from "technicalindicators";

/**
 * 15분봉 전용 지표 추출기 (Sentry 15M)
 */
export function getIndicators15M(ohlcv15M) {
  if (!ohlcv15M || ohlcv15M.length < 30) return null;

  // 종가, 고가, 저가 (현재 진행 중인 캔들 포함)
  const closes = ohlcv15M.map((c) => Number(c[4]));
  const highs = ohlcv15M.map((c) => Number(c[2]));
  const lows = ohlcv15M.map((c) => Number(c[3]));
  const timestamps = ohlcv15M.map((c) => Number(c[0]));

  // 방금 마감된 캔들 (completed) 기준 계산
  // CCXT의 OHLCV 데이터에서 마지막 원소[length-1]는 현재 진행 중인 캔들이므로
  // 완전히 마감된 캔들은 [length-2] 입니다.
  const completedIdx = closes.length - 2;

  // 볼린저 밴드 (20, 2) 계산 (마감된 캔들 기준 최근 20개)
  const closesLast20 = closes.slice(completedIdx - 19, completedIdx + 1);
  const ma20 = closesLast20.reduce((a, b) => a + b, 0) / 20;
  const squareDiffs = closesLast20.map((v) => Math.pow(v - ma20, 2));
  const stdDev = Math.sqrt(squareDiffs.reduce((a, b) => a + b, 0) / 20);
  
  const bbUpper = ma20 + (stdDev * 2);
  const bbLower = ma20 - (stdDev * 2);
  const bbMid = ma20;

  // ADX (14) 계산 (마감된 캔들까지)
  const adxResult = ADX.calculate({
    high: highs.slice(0, completedIdx + 1),
    low: lows.slice(0, completedIdx + 1),
    close: closes.slice(0, completedIdx + 1),
    period: 14,
  });
  const latestADX = adxResult.length > 0 ? adxResult[adxResult.length - 1].adx : 0;

  // 15M 프랙탈 지지/저항선 탐색 (최근 5개 캔들 패턴)
  let support15M = null;
  let resistance15M = null;

  // 최근 마감된 캔들부터 거꾸로 탐색 (i는 중앙 캔들)
  // i-2, i-1, i, i+1, i+2를 비교하므로 i는 completedIdx - 2 부터 시작
  for (let i = completedIdx - 2; i >= 2; i--) {
    const currentLow = lows[i];
    if (
      currentLow < lows[i - 1] && currentLow < lows[i - 2] &&
      currentLow < lows[i + 1] && currentLow < lows[i + 2]
    ) {
      support15M = currentLow;
      break;
    }
  }
  if (!support15M) support15M = Math.min(...lows.slice(-30, completedIdx + 1));

  for (let i = completedIdx - 2; i >= 2; i--) {
    const currentHigh = highs[i];
    if (
      currentHigh > highs[i - 1] && currentHigh > highs[i - 2] &&
      currentHigh > highs[i + 1] && currentHigh > highs[i + 2]
    ) {
      resistance15M = currentHigh;
      break;
    }
  }
  if (!resistance15M) resistance15M = Math.max(...highs.slice(-30, completedIdx + 1));

  // 방금 마감된 캔들의 OHLC (트리거용)
  const completedClose = closes[completedIdx];
  const completedLow = lows[completedIdx];
  const completedHigh = highs[completedIdx];
  const completedTimestamp = timestamps[completedIdx];

  // 현재 진행 중인 캔들의 종가 (실시간 모니터링용)
  const currentPrice = closes[closes.length - 1];

  return {
    bbUpper,
    bbMid,
    bbLower,
    adx: latestADX,
    support15M,
    resistance15M,
    completedClose,
    completedLow,
    completedHigh,
    completedTimestamp,
    currentPrice,
  };
}
