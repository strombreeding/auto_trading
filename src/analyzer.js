import { ADX } from "technicalindicators";

/**
 * 지표 데이터를 추출합니다. (고도화 버전 - 숏 포지션 대응)
 */
export function getIndicators(ohlcv1H, ohlcv15M, ohlcv5M) {
  if (!ohlcv1H || !ohlcv15M || !ohlcv5M) return null;

  // 1. 15분봉 지표 추출
  const closes15M = ohlcv15M.map((c) => Number(c[4]));
  const highs15M = ohlcv15M.map((c) => Number(c[2]));
  const lows15M = ohlcv15M.map((c) => Number(c[3]));

  // 볼린저 밴드(20) 폭 계산
  const ma20_15m = closes15M.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const squareDiffs15m = closes15M.slice(-20).map((v) => Math.pow(v - ma20_15m, 2));
  const stdDev15m = Math.sqrt(squareDiffs15m.reduce((a, b) => a + b, 0) / 20);
  const bandwidth15m = ma20_15m > 0 ? (stdDev15m * 4) / ma20_15m : 0;
  const isSqueeze = bandwidth15m < 0.015;

  // ADX(14) 계산 
  const adxResult = ADX.calculate({
    high: highs15M,
    low: lows15M,
    close: closes15M,
    period: 14,
  });
  const latestADX = adxResult.length > 0 ? adxResult[adxResult.length - 1].adx : 0;

  // 2. 1시간봉 프랙탈 지지/저항선 추출
  const lows1H = ohlcv1H.map((c) => Number(c[3]));
  const highs1H = ohlcv1H.map((c) => Number(c[2]));
  
  let support1H = null;
  let resistance1H = null;

  // 프랙탈 지지선 탐색
  for (let i = lows1H.length - 3; i >= 2; i--) {
    const currentLow = lows1H[i];
    if (
      currentLow < lows1H[i - 1] && currentLow < lows1H[i - 2] &&
      currentLow < lows1H[i + 1] && currentLow < lows1H[i + 2]
    ) {
      support1H = currentLow;
      break;
    }
  }
  if (!support1H) support1H = Math.min(...lows1H.slice(-30));

  // 프랙탈 저항선 탐색 (숏 포지션용)
  for (let i = highs1H.length - 3; i >= 2; i--) {
    const currentHigh = highs1H[i];
    if (
      currentHigh > highs1H[i - 1] && currentHigh > highs1H[i - 2] &&
      currentHigh > highs1H[i + 1] && currentHigh > highs1H[i + 2]
    ) {
      resistance1H = currentHigh;
      break;
    }
  }
  if (!resistance1H) resistance1H = Math.max(...highs1H.slice(-30));

  // 3. 5분봉 최신 데이터 추출
  const closes5M = ohlcv5M.map((c) => Number(c[4]));
  const lows5M = ohlcv5M.map((c) => Number(c[3]));
  const highs5M = ohlcv5M.map((c) => Number(c[2]));
  const timestamps5M = ohlcv5M.map((c) => Number(c[0]));
  
  const currentPrice5M = closes5M[closes5M.length - 1]; 
  const currentLow5M = lows5M[lows5M.length - 1];
  const currentHigh5M = highs5M[highs5M.length - 1];
  const currentTimestamp5M = timestamps5M[timestamps5M.length - 1];

  const prevClose5M = closes5M[closes5M.length - 2];
  const prevLow5M = lows5M[lows5M.length - 2];
  const prevHigh5M = highs5M[highs5M.length - 2];
  const prevTimestamp5M = timestamps5M[timestamps5M.length - 2];

  return {
    isSqueeze,
    bandwidth: bandwidth15m,
    adx: latestADX,
    support1H,
    resistance1H,
    currentPrice5M,
    currentLow5M,
    currentHigh5M,
    currentTimestamp5M,
    prevClose5M,
    prevLow5M,
    prevHigh5M,
    prevTimestamp5M,
  };
}
