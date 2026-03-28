import { RSI } from "technicalindicators";

/**
 * 15분봉 전용 지표 추출기 (Hedge V-Catch 용 RSI 계산)
 */
export function getIndicatorsHedge(ohlcv15M) {
  if (!ohlcv15M || ohlcv15M.length < 30) return null;

  const closes = ohlcv15M.map(c => Number(c[4]));
  
  // 마감된 캔들 인덱스 (length - 2)까지만 사용하여 RSI 왜곡 방지
  const completedIdx = closes.length - 2;
  const closesToCalculate = closes.slice(0, completedIdx + 1);

  // RSI(14) 계산
  const rsiResult = RSI.calculate({
    values: closesToCalculate,
    period: 14
  });

  const latestRSI = rsiResult.length > 0 ? rsiResult[rsiResult.length - 1] : 50;
  
  const currentPrice = closes[closes.length - 1]; // 실시간 감시용 현재가

  return {
    rsi: latestRSI,
    currentPrice
  };
}
