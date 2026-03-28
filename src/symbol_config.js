/**
 * 심볼별 변동성 대응 파라미터 관리 파일
 * BTC/USDT 기본값과 변동성이 큰 알트코인(SOL/USDT 등)의 로직 버퍼, 익절/손절 수치를 다르게 줍니다.
 */
export function getSymbolParams(symbol) {
  const isSolana = symbol.toUpperCase().startsWith("SOL");

  if (isSolana) {
    return {
      // Main 5M Bot
      mainTouchBuffer: 0.003,        // 0.3% (BTC 0.2%)
      mainFakeoutBuffer: 0.002,      // 0.2% (BTC 0.1%)
      mainBreakoutBuffer: 0.004,     // 0.4% (BTC 0.3%)
      mainTakeProfitBreakout: 0.02,  // 2.0% (BTC 1.5%)
      mainTakeProfitReclaim: 0.008,  // 0.8% (BTC 0.5%)
      mainStopLossBreakout: 0.015,   // 1.5% (BTC 0.7%)

      // Sentry 15M Bot
      sentryBreakoutBuffer: 0.004,   // 0.4% (BTC 0.2%)
      sentryTakeProfit: 0.009,       // 0.9% (BTC 0.6%)
      sentryStopLoss: 0.018,         // 1.8% (BTC 1.0%)

      // Hedge V-Catch Bot
      hedgeTakeProfit: 0.009,        // 0.9% (BTC 0.6%) => margin * 0.09
      hedgeStopLossTotal: 0.045,     // 전체 합산 손실 방어선 -4.5% (BTC -3.0%)
      hedgeProfitProtect: 0.3        // 확보 수익 70% 훼손 방어용 잔류선 (30%)
    };
  }

  // 기본값 (BTC/USDT 기준)
  return {
    // Main 5M Bot
    mainTouchBuffer: 0.002,      
    mainFakeoutBuffer: 0.001,    
    mainBreakoutBuffer: 0.003,   
    mainTakeProfitBreakout: 0.015, 
    mainTakeProfitReclaim: 0.005,
    mainStopLossBreakout: 0.007, 

    // Sentry 15M Bot
    sentryBreakoutBuffer: 0.002, 
    sentryTakeProfit: 0.006,     
    sentryStopLoss: 0.01,        

    // Hedge V-Catch Bot
    hedgeTakeProfit: 0.006,      
    hedgeStopLossTotal: 0.03,    
    hedgeProfitProtect: 0.3      
  };
}
