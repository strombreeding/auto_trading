import { FEE_CONFIG, getNetFeeRate } from "./strategy.js";
import { getSymbolParams } from "./symbol_config.js";

// 진입 비중은 proportion.json 에서 관리

/**
 * 15분봉 Sentry 전략
 */
export function checkSentryStrategy(indicators, symbol) {
  if (!indicators) return { shouldEnter: false, reason: "지표 로딩 중..." };

  const { bbUpper, bbLower, bbMid, adx, support15M, resistance15M, completedClose, completedLow, completedHigh, currentPrice } = indicators;
  const p = getSymbolParams(symbol);

  // ADX 기준으로 모드 구분 (추세 vs 역추세 판단 보조)
  const mode = adx >= 25 ? "TREND" : "REVERSION";

  let longSignal = false;
  let shortSignal = false;
  let strategyReason = "";

  // 1. 역추세 매매 (Reversion) - 볼린저 밴드
  // 롱: BB 하단선 터치 또는 이탈 후 종가는 밴드 내부에서 마감
  if (completedLow <= bbLower && completedClose > bbLower) {
    longSignal = true;
    strategyReason = `🚀 [Long/역추세] BB하단 터치 후 복귀 (ADX: ${adx.toFixed(2)})`;
  }
  
  // 숏: BB 상단선 터치 또는 돌파 후 종가는 밴드 내부에서 마감
  if (completedHigh >= bbUpper && completedClose < bbUpper) {
    shortSignal = true;
    strategyReason = `🔥 [Short/역추세] BB상단 터치 후 복귀 (ADX: ${adx.toFixed(2)})`;
  }

  // 2. 추세 매매 (Trend) - ADX 25 이상 & 프랙탈 돌파
  if (adx >= 25 && !longSignal && !shortSignal) {
    const longBreakoutTarget = resistance15M * (1 + p.sentryBreakoutBuffer); 
    const shortBreakoutTarget = support15M * (1 - p.sentryBreakoutBuffer);

    // 실시간 가격 기준(또는 종가 기준)으로 돌파 확인. (현재 진행중인 가격으로 체결 판정)
    if (currentPrice >= longBreakoutTarget) {
      longSignal = true;
      strategyReason = `🚀 [Long/추세] ADX>=25 & 프랙탈 저항선 0.2% 돌파!`;
    } else if (currentPrice <= shortBreakoutTarget) {
      shortSignal = true;
      strategyReason = `🔥 [Short/추세] ADX>=25 & 프랙탈 지지선 0.2% 이탈!`;
    }
  }

  if (longSignal) return { shouldEnter: true, mode, side: "buy", reason: strategyReason };
  if (shortSignal) return { shouldEnter: true, mode, side: "sell", reason: strategyReason };

  return { shouldEnter: false, mode, reason: `타점 대기 (ADX: ${adx.toFixed(2)}, S: ${support15M?.toFixed(2)}, R: ${resistance15M?.toFixed(2)})` };
}

export function calculateSentryPositionSize(usdtBalance, currentPrice, proportion) {
  const marginSize = usdtBalance * proportion; 
  const positionValue = marginSize * 10; // 레버리지 10배
  return positionValue / currentPrice;
}

/**
 * 롱/숏, 그리고 추세 모드 변화에 따른 타겟 및 손절 가격 계산
 */
export function getSentryBracketParams(side, entryPrice, mode, bbMid, symbol) {
  const p = getSymbolParams(symbol);
  const netFeeRate = getNetFeeRate(); // 65% 페이백 반영 수수료율
  
  const NET_PROFIT_TARGET = p.sentryTakeProfit;  
  
  let takeProfitPrice;
  let stopLossPrice;

  if (side === "buy") {
    if (mode === "TREND") {
      takeProfitPrice = entryPrice * (1 + NET_PROFIT_TARGET + netFeeRate);
    } else {
      // Reversion 모드: BB 중단선(bbMid) 익절. 단, 진입가보다 높아야 의미가 있음.
      takeProfitPrice = Math.max(bbMid, entryPrice * 1.001); 
    }
    // 손절(SL)
    stopLossPrice = entryPrice * (1 - p.sentryStopLoss);
  } else if (side === "sell") {
    if (mode === "TREND") {
      takeProfitPrice = entryPrice * (1 - (NET_PROFIT_TARGET + netFeeRate));
    } else {
      // Reversion 모드: BB 중단선(bbMid) 익절.
      takeProfitPrice = Math.min(bbMid, entryPrice * 0.999);
    }
    // 손절(SL)
    stopLossPrice = entryPrice * (1 + p.sentryStopLoss);
  }

  return {
    takeProfit: { triggerPrice: takeProfitPrice },
    stopLoss: { triggerPrice: stopLossPrice },
  };
}
