import { getNetFeeRate } from "./strategy.js";
import { getSymbolParams } from "./symbol_config.js";

// 계산: 포지션 사이즈
export function calculateHedgePositionSize(
  usdtBalance,
  currentPrice,
  proportion,
) {
  // 양방향 각각 총 비중의 절반씩. proportion이 0.20 이라면 롱 10%, 숏 10%
  const oneSideMarginSize = usdtBalance * (proportion / 2);
  const positionValue = oneSideMarginSize * 10; // 10배 레버리지
  return positionValue / currentPrice;
}

/**
 * Hedge V-Catch 포지션 관리 로직
 */
export function checkHedgeExitLogic(hedgeTrade, indicators, symbol) {
  if (!hedgeTrade) return { action: "NONE" };

  const { rsi, currentPrice } = indicators;
  const netFeeRate = getNetFeeRate(); // 65% 페이백 반영
  const p = getSymbolParams(symbol);

  const marginPerSide = hedgeTrade.usdtBefore * (hedgeTrade.proportion / 2);
  const totalMargin = marginPerSide * 2;

  let longRawPnL = 0;
  let shortRawPnL = 0;

  if (hedgeTrade.sideOpened.long) {
    longRawPnL = (currentPrice / hedgeTrade.longEntry - 1) * 10;
  }
  if (hedgeTrade.sideOpened.short) {
    shortRawPnL =
      ((hedgeTrade.shortEntry - currentPrice) / hedgeTrade.shortEntry) * 10;
  }

  const longNetUSDT = hedgeTrade.sideOpened.long
    ? marginPerSide * longRawPnL - marginPerSide * 10 * netFeeRate
    : 0;
  const shortNetUSDT = hedgeTrade.sideOpened.short
    ? marginPerSide * shortRawPnL - marginPerSide * 10 * netFeeRate
    : 0;

  // 익절 목표 -> USDT 환산 : marginPerSide * p.hedgeTakeProfit
  const TARGET_PROFIT_USDT = marginPerSide * p.hedgeTakeProfit;

  // ==============================================================================
  // 🛠️ [추가된 부분] 트레일링 스탑을 위한 각 방향별 최고 수익(Max PnL) 추적
  // 추세를 탈 때 봇이 본 가장 높은 수익금을 기억해 둡니다.
  if (hedgeTrade.maxLongPnL === undefined) hedgeTrade.maxLongPnL = 0;
  if (hedgeTrade.maxShortPnL === undefined) hedgeTrade.maxShortPnL = 0;

  if (longNetUSDT > hedgeTrade.maxLongPnL) hedgeTrade.maxLongPnL = longNetUSDT;
  if (shortNetUSDT > hedgeTrade.maxShortPnL)
    hedgeTrade.maxShortPnL = shortNetUSDT;
  // ==============================================================================

  // RSI 터치 감지 업데이트 (실시간 과매수/과매도 꼬리 기록)
  if (rsi >= 70) hedgeTrade.rsiTouched = "overbought";
  if (rsi <= 30) hedgeTrade.rsiTouched = "oversold";

  // 1. Phase 1: Winner 청산 체크 (둘 다 켜져 있을 때)
  if (!hedgeTrade.winnerClosed) {
    // RSI 꺾임(V-Catch)으로 인한 익절 조건 (이건 목표수익 도달 전에도 발동하는 기존 방어막이므로 유지)
    const hitRsiTpLong =
      hedgeTrade.rsiTouched === "overbought" && rsi < 70 && longNetUSDT > 0;
    const hitRsiTpShort =
      hedgeTrade.rsiTouched === "oversold" && rsi > 30 && shortNetUSDT > 0;

    // ==============================================================================
    // 🛠️ [추가된 부분] 롱(Long) 방향 트레일링 (끝까지 발라먹기 + 반절 지킴이)
    // 롱 수익이 한 번이라도 목표치를 돌파했다면 이제부터 즉시 안 팔고 각을 봅니다.
    if (hedgeTrade.maxLongPnL >= TARGET_PROFIT_USDT) {
      const MIN_PROFIT_LIMIT = TARGET_PROFIT_USDT * 0.5; // 방어선: 원래 목표수익의 50%

      // 1-1. 갑자기 빔 맞고 하락하면 최소 수익(50%)만 챙기고 탈출!
      if (longNetUSDT <= MIN_PROFIT_LIMIT) {
        return {
          action: "CLOSE_WINNER",
          side: "long",
          profitUSDT: longNetUSDT,
          reason: `🛡️ [Phase 1] 롱 목표 달성 후 하락. 50% 수익 보존 컷. 숏 구출 모드 돌입!`,
        };
      }
      // 1-2. RSI가 진짜 꼭대기(70 이상)를 찍으면 전량 익절!
      else if (rsi >= 70) {
        return {
          action: "CLOSE_WINNER",
          side: "long",
          profitUSDT: longNetUSDT,
          reason: `🌋 [Phase 1] 롱 추세 꼭대기! RSI 과매수(${rsi.toFixed(1)}) 익절. 숏 구출 모드 돌입!`,
        };
      }
    }
    // 목표치는 못 미쳤지만 V-catch 로직(미니 반등)에 걸렸을 때
    else if (hitRsiTpLong) {
      return {
        action: "CLOSE_WINNER",
        side: "long",
        profitUSDT: longNetUSDT,
        reason: `🎯 [Phase 1] 롱 익절 (15M RSI 과매수 이탈 V-Catch). 숏 구출 모드 돌입!`,
      };
    }

    // 🛠️ [추가된 부분] 숏(Short) 방향 트레일링 (끝까지 발라먹기 + 반절 지킴이)
    // 숏 수익이 한 번이라도 목표치를 돌파했다면 즉시 안 팔고 각을 봅니다.
    if (hedgeTrade.maxShortPnL >= TARGET_PROFIT_USDT) {
      const MIN_PROFIT_LIMIT = TARGET_PROFIT_USDT * 0.5;

      if (shortNetUSDT <= MIN_PROFIT_LIMIT) {
        return {
          action: "CLOSE_WINNER",
          side: "short",
          profitUSDT: shortNetUSDT,
          reason: `🛡️ [Phase 1] 숏 목표 달성 후 상승. 50% 수익 보존 컷. 롱 구출 모드 돌입!`,
        };
      } else if (rsi <= 30) {
        return {
          action: "CLOSE_WINNER",
          side: "short",
          profitUSDT: shortNetUSDT,
          reason: `🧊 [Phase 1] 숏 추세 바닥! RSI 과매도(${rsi.toFixed(1)}) 익절. 롱 구출 모드 돌입!`,
        };
      }
    } else if (hitRsiTpShort) {
      return {
        action: "CLOSE_WINNER",
        side: "short",
        profitUSDT: shortNetUSDT,
        reason: `🎯 [Phase 1] 숏 익절 (15M RSI 과매도 반등 V-Catch). 롱 구출 모드 돌입!`,
      };
    }
    // ==============================================================================
  }

  // 2. Phase 2: Loser 관리 및 구출 로직 (하나만 남았을 때)
  if (hedgeTrade.winnerClosed) {
    const openSide = hedgeTrade.sideOpened.long ? "long" : "short";

    if (openSide === "long") {
      // 롱이 남았음 (가격 폭락 후 숏이 익절됨 -> 반등을 기다리는 중)
      if (longNetUSDT >= 0) {
        return {
          action: "CLOSE_LOSER",
          side: "long",
          pnlUSDT: longNetUSDT,
          reason: `🔄 [Phase 2] 본절/수익권 회복 달성! 물려있던 롱 구출 성공.`,
        };
      }
      if (rsi >= 60) {
        return {
          action: "CLOSE_LOSER",
          side: "long",
          pnlUSDT: longNetUSDT,
          reason: `🔄 [Phase 2] RSI 반등 회복점(60경계) 도달. 반등세 약화로 롱 손절 마감.`,
        };
      }
    } else if (openSide === "short") {
      // 숏이 남았음 (가격 폭등 후 롱이 익절됨 -> 하락 반전을 기다리는 중)
      if (shortNetUSDT >= 0) {
        return {
          action: "CLOSE_LOSER",
          side: "short",
          pnlUSDT: shortNetUSDT,
          reason: `🔄 [Phase 2] 본절/수익권 회복 달성! 물려있던 숏 구출 성공.`,
        };
      }
      if (rsi <= 40) {
        return {
          action: "CLOSE_LOSER",
          side: "short",
          pnlUSDT: shortNetUSDT,
          reason: `🔄 [Phase 2] RSI 하락 회복점(40경계) 도달. 하락세 약화로 숏 손절 마감.`,
        };
      }
    }

    const securedProfit = hedgeTrade.winnerPnL || 0;
    const currentOpenPnL = openSide === "long" ? longNetUSDT : shortNetUSDT;
    const totalNetUSDT = securedProfit + currentOpenPnL;

    // (이전에 있던 '확보 수익 70% 훼손 방어선'은 양방향 헷지 구조의 수학적 모순으로 인해 삭제되었습니다.
    // 롱이 익절하는 순간 숏은 이미 100% 훼손 상태(본전)이므로 즉시 청산되는 오류 방지)

    // 보호 로직 2: 합산 손실 방어선 (전체 마진 기준)
    if (totalNetUSDT <= -totalMargin * p.hedgeStopLossTotal) {
      return {
        action: "PROTECTION_CLOSE",
        reason: "🚨 [Protection] 합산 손실 초과. 전량 컷오프.",
        totalNetUSDT,
      };
    }
  } else {
    // 3. 둘 다 열려있을 때의 보호 로직 (급격한 추세로 인한 방어선 도달)
    const totalNetUSDT = longNetUSDT + shortNetUSDT;
    if (totalNetUSDT <= -totalMargin * p.hedgeStopLossTotal) {
      return {
        action: "PROTECTION_CLOSE",
        reason: "🚨 [Protection] 양방향 보유 중 총 손실 한계 초과 컷오프.",
        totalNetUSDT,
      };
    }
  }

  return {
    action: "HOLD",
    longNetUSDT,
    shortNetUSDT,
    rsi,
    rsiTouched: hedgeTrade.rsiTouched,
  };
}
