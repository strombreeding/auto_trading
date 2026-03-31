import { RSI } from "technicalindicators";

export function getIndicatorsHedge(ohlcv15M) {
  if (!ohlcv15M || ohlcv15M.length < 30) return null;

  const closes = ohlcv15M.map((c) => Number(c[4]));

  // [수정] 실시간 RSI 반영을 위해 전체 데이터를 사용합니다.
  const rsiResult = RSI.calculate({
    values: closes,
    period: 14,
  });

  const latestRSI = rsiResult.length > 0 ? rsiResult[rsiResult.length - 1] : 50;
  const currentPrice = closes[closes.length - 1];
  return {
    rsi: latestRSI,
    currentPrice,
  };
}
