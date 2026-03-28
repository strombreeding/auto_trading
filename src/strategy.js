/**
 * strategy.js
 * (하이브리드 엔진: 횡보장 Reclaim + 추세장 Breakout)
 */

import { getSymbolParams } from "./symbol_config.js";

export const FEE_CONFIG = {
  MAKER: 0.00007,
  TAKER: 0.00017,
  PAYBACK_RATE: 0.65,
  EXCHANGE_FIXED_CUT: 0.3,
};

// 동적 비중은 proportion.json 에서 설정

/**
 * 하이브리드 전략 진입 신호 확인 (ADX 기반 동적 모드 전환)
 */
export function checkHybridStrategy(indicators, state, symbol) {
  if (!indicators) return { shouldEnter: false, reason: "데이터 부족" };
  const {
    isSqueeze,
    adx,
    support1H,
    resistance1H,
    currentPrice5M,
    currentLow5M,
    currentHigh5M,
    prevClose5M,
    prevLow5M,
    prevHigh5M,
    currentTimestamp5M,
    prevTimestamp5M,
  } = indicators;
  const p = getSymbolParams(symbol);

  // ==== 동적 모드 판별 ====
  const mode = adx < 25 ? "RECLAIM" : "BREAKOUT";
  const now = Date.now();
  const THIRTY_MINUTES = 30 * 60 * 1000;

  // 상태 관리 초기화 (지지 저항선 변경 시)
  if (state.lastSupport1H !== support1H) {
    state.lastSupport1H = support1H;
    state.supportTouches = [];
    state.supportDipTimestamp = null;
  }
  if (state.lastResistance1H !== resistance1H) {
    state.lastResistance1H = resistance1H;
    state.resistanceTouches = [];
    state.resistancePumpTimestamp = null;
  }

  // ==== [RECLAIM 모드] 횡보장 전략 ====
  if (mode === "RECLAIM") {
    let longSignal = false;
    let longReason = "";

    // 1. Long 터치 카운트
    if (currentPrice5M <= support1H * (1 + p.mainTouchBuffer)) {
      if (
        state.supportTouches.length === 0 ||
        now - state.supportTouches[state.supportTouches.length - 1] >
          5 * 60 * 1000
      ) {
        state.supportTouches.push(now);
      }
    }
    state.supportTouches = state.supportTouches.filter(
      (t) => now - t <= 2 * 60 * 60 * 1000,
    );

    // 2. Long Fakeout
    const DIP_THRESHOLD = support1H * (1 - p.mainFakeoutBuffer);
    if (currentLow5M <= DIP_THRESHOLD) {
      state.supportDipTimestamp = currentTimestamp5M;
    } else if (prevLow5M <= DIP_THRESHOLD) {
      if (
        !state.supportDipTimestamp ||
        state.supportDipTimestamp < prevTimestamp5M
      )
        state.supportDipTimestamp = prevTimestamp5M;
    }

    // 3. Long Reclaim (6캔들 = 30분 이내 회복)
    if (
      state.supportTouches.length <= 3 &&
      state.supportDipTimestamp &&
      prevClose5M > support1H
    ) {
      const timeSinceDip = currentTimestamp5M - state.supportDipTimestamp;
      if (timeSinceDip <= THIRTY_MINUTES && timeSinceDip >= 0) {
        longSignal = true;
        longReason = "🚀 [Long] 0.1% 이상 이탈 후 6캔들 내 회복 (Reclaim)";
        state.supportDipTimestamp = null;
      } else {
        state.supportDipTimestamp = null;
      }
    }

    let shortSignal = false;
    let shortReason = "";

    // 1. Short 터치 카운트
    if (currentPrice5M >= resistance1H * (1 - p.mainTouchBuffer)) {
      if (
        state.resistanceTouches.length === 0 ||
        now - state.resistanceTouches[state.resistanceTouches.length - 1] >
          5 * 60 * 1000
      ) {
        state.resistanceTouches.push(now);
      }
    }
    state.resistanceTouches = state.resistanceTouches.filter(
      (t) => now - t <= 2 * 60 * 60 * 1000,
    );

    // 2. Short Fakeout
    const PUMP_THRESHOLD = resistance1H * (1 + p.mainFakeoutBuffer);
    if (currentHigh5M >= PUMP_THRESHOLD) {
      state.resistancePumpTimestamp = currentTimestamp5M;
    } else if (prevHigh5M >= PUMP_THRESHOLD) {
      if (
        !state.resistancePumpTimestamp ||
        state.resistancePumpTimestamp < prevTimestamp5M
      )
        state.resistancePumpTimestamp = prevTimestamp5M;
    }

    // 3. Short Reclaim (6캔들 = 30분 이내 하락)
    if (
      state.resistanceTouches.length <= 3 &&
      state.resistancePumpTimestamp &&
      prevClose5M < resistance1H
    ) {
      const timeSincePump = currentTimestamp5M - state.resistancePumpTimestamp;
      if (timeSincePump <= THIRTY_MINUTES && timeSincePump >= 0) {
        shortSignal = true;
        shortReason = "🔥 [Short] 0.1% 이상 돌파 후 6캔들 내 하락 (Reclaim)";
        state.resistancePumpTimestamp = null;
      } else {
        state.resistancePumpTimestamp = null;
      }
    }

    if (longSignal)
      return { shouldEnter: true, mode, side: "buy", reason: longReason };
    if (shortSignal)
      return { shouldEnter: true, mode, side: "sell", reason: shortReason };

    return {
      shouldEnter: false,
      mode,
      reason: `타점 대기 (S: ${support1H}, R: ${resistance1H})`,
    };
  }

  // ==== [BREAKOUT 모드] 추세장 전략 ====
  else {
    const LONG_BREAKOUT_TARGET = resistance1H * (1 + p.mainBreakoutBuffer);
    const SHORT_BREAKOUT_TARGET = support1H * (1 - p.mainBreakoutBuffer);

    if (currentPrice5M >= LONG_BREAKOUT_TARGET) {
      return {
        shouldEnter: true,
        mode,
        side: "buy",
        reason: `🚀 [Long Breakout] 강한 추세 타고 저항선 0.3% 확실 상향 돌파!`,
      };
    }

    if (currentPrice5M <= SHORT_BREAKOUT_TARGET) {
      return {
        shouldEnter: true,
        mode,
        side: "sell",
        reason: `🔥 [Short Breakout] 강한 추세 타고 지지선 0.3% 확실 하향 이탈!`,
      };
    }

    return {
      shouldEnter: false,
      mode,
      reason: `돌파 대기 중 (저항 0.3% UP: ${LONG_BREAKOUT_TARGET.toFixed(2)} / 지지 0.3% DOWN: ${SHORT_BREAKOUT_TARGET.toFixed(2)})`,
    };
  }
}

export function getNetFeeRate() {
  const grossFeeRate = FEE_CONFIG.TAKER + FEE_CONFIG.MAKER;
  const commissionPoolArea = 1 - FEE_CONFIG.EXCHANGE_FIXED_CUT;
  const feePaybackRate =
    grossFeeRate * commissionPoolArea * FEE_CONFIG.PAYBACK_RATE;
  return grossFeeRate - feePaybackRate;
}

export function calculatePositionSize(usdtBalance, currentPrice, proportion) {
  const marginSize = usdtBalance * proportion;
  const positionValue = marginSize * 10;
  return positionValue / currentPrice;
}

/**
 * 롱/숏, 그리고 추세 모드 변화에 따른 타겟 및 손절 가격 계산
 */
export function getBracketParams(
  side,
  entryPrice,
  support1H,
  resistance1H,
  mode,
  symbol,
) {
  const p = getSymbolParams(symbol);
  const netFeeRate = getNetFeeRate();

  const NET_PROFIT_TARGET =
    mode === "BREAKOUT" ? p.mainTakeProfitBreakout : p.mainTakeProfitReclaim;

  let takeProfitPrice;
  let stopLossPrice;

  if (side === "buy") {
    takeProfitPrice = entryPrice * (1 + NET_PROFIT_TARGET + netFeeRate);
    stopLossPrice =
      mode === "BREAKOUT"
        ? entryPrice * (1 - p.mainStopLossBreakout)
        : support1H * (1 - p.mainStopLossBreakout);
  } else if (side === "sell") {
    takeProfitPrice = entryPrice * (1 - (NET_PROFIT_TARGET + netFeeRate));
    stopLossPrice =
      mode === "BREAKOUT"
        ? entryPrice * (1 + p.mainStopLossBreakout)
        : resistance1H * (1 + p.mainStopLossBreakout);
  }

  return {
    takeProfit: { triggerPrice: takeProfitPrice },
    stopLoss: { triggerPrice: stopLossPrice },
  };
}
