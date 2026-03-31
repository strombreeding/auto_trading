import { getNetFeeRate } from "./strategy.js";
import { getSymbolParams, profitPercent } from "./symbol_config.js";

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
 * Hedge V-Catch 포지션 관리 로직 (실시간 RSI 및 피라미딩 익절)
 */
export function checkHedgeExitLogic(hedgeTrade, indicators, symbol) {
  if (!hedgeTrade) return { action: "NONE" };

  const { rsi, currentPrice } = indicators;
  const netFeeRate = getNetFeeRate();
  const p = getSymbolParams(symbol);

  // 1. 초기 익절 비중 설정 (profitPercent()가 50이면 0.5)
  const initialProfitRate = profitPercent() / 100;

  const initialMarginPerSide =
    hedgeTrade.usdtBefore * (hedgeTrade.proportion / 2);
  const totalMargin = initialMarginPerSide * 2;
  const currentQtyRate = hedgeTrade.currentQtyRate || 1.0;

  // 실시간 PnL 계산
  const longRawPnL = (currentPrice / hedgeTrade.longEntry - 1) * 10;
  const shortRawPnL =
    ((hedgeTrade.shortEntry - currentPrice) / hedgeTrade.shortEntry) * 10;

  const longNetUSDT = hedgeTrade.sideOpened.long
    ? initialMarginPerSide * currentQtyRate * longRawPnL -
      initialMarginPerSide * 10 * netFeeRate
    : 0;
  const shortNetUSDT = hedgeTrade.sideOpened.short
    ? initialMarginPerSide * currentQtyRate * shortRawPnL -
      initialMarginPerSide * 10 * netFeeRate
    : 0;

  const realizedProfit = hedgeTrade.realizedProfit || 0;
  // [핵심] 모든 실현 수익과 미실현 수익의 총합
  const totalNetUSDT =
    (hedgeTrade.winnerPnL || 0) + longNetUSDT + shortNetUSDT + realizedProfit;

  if (rsi >= 70) hedgeTrade.rsiTouched = "overbought";
  if (rsi <= 30) hedgeTrade.rsiTouched = "oversold";

  // --------------------------------------------------------------------------
  // Phase 1: Winner 관리 (피라미딩 익절)
  // --------------------------------------------------------------------------
  if (!hedgeTrade.winnerClosed) {
    const isLongWinner = longNetUSDT > shortNetUSDT;
    const side = isLongWinner ? "long" : "short";
    const winnerNetUSDT = isLongWinner ? longNetUSDT : shortNetUSDT;

    // A. 초기 익절 (예: 50% 매도)
    if (!hedgeTrade.partialWinnerClosed) {
      if ((isLongWinner && rsi >= 70) || (!isLongWinner && rsi <= 30)) {
        return {
          action: "CLOSE_PARTIAL_WINNER",
          side,
          qtyRate: initialProfitRate,
          profitUSDT: winnerNetUSDT * initialProfitRate,
          reason: `🌋 [Initial] ${profitPercent()}% 익절 완료`,
        };
      }
    }
    // B. 피라미딩 추격 매도 (10%씩 최대 5번)
    else if (currentQtyRate > 0.05) {
      // 남은 수량이 있을 때까지
      const timeSinceLastExit =
        (Date.now() - (hedgeTrade.lastPartialExitTime || 0)) / 1000;
      // RSI가 계속 극점에 머물거나 더 유리해지는지 확인
      const isStillInZone = isLongWinner ? rsi >= 70 : rsi <= 30;

      if (timeSinceLastExit >= 40 && isStillInZone) {
        // 40초 간격 트래킹
        return {
          action: "CLOSE_PARTIAL_WINNER",
          side,
          qtyRate: 0.1, // 10% 추가 익절
          profitUSDT: winnerNetUSDT * 0.1,
          reason: `📈 [Pyramid] 10% 추가 익절 (남은비중: ${(currentQtyRate * 100).toFixed(0)}%)`,
        };
      }
    }

    // C. [전량 익절] RSI가 극점(70/30)을 이탈하여 꺾이는 순간 (V-Catch)
    const vCatchLong =
      hedgeTrade.rsiTouched === "overbought" && rsi < 70 && isLongWinner;
    const vCatchShort =
      hedgeTrade.rsiTouched === "oversold" && rsi > 30 && !isLongWinner;

    if (vCatchLong || vCatchShort) {
      return {
        action: "CLOSE_WINNER",
        side,
        profitUSDT: winnerNetUSDT + realizedProfit,
        reason: "🎯 [V-Catch] 추세 꺾임 감지, Winner 전량 종료",
      };
    }
  }

  // --------------------------------------------------------------------------
  // 2. Phase 2: Loser 관리 및 보호 로직 (하나만 남았을 때)
  // --------------------------------------------------------------------------
  if (hedgeTrade.winnerClosed) {
    const openSide = hedgeTrade.sideOpened.long ? "long" : "short";
    const durationMin = (Date.now() - hedgeTrade.winnerClosedTime) / 60000;
    const isInReversionZone =
      (openSide === "long" && rsi <= 35) || (openSide === "short" && rsi >= 65);

    // [핵심] 합산 손실 보호 로직 (14분 반등 유예 필터)
    if (totalNetUSDT <= -totalMargin * p.hedgeStopLossTotal) {
      // 🛡️ [Safe Zone] RSI가 극점이고 유예 시간 내라면 손절하지 않고 대기
      if (isInReversionZone && durationMin < 14) {
        return {
          action: "HOLD",
          longNetUSDT,
          shortNetUSDT,
          rsi,
          rsiTouched: hedgeTrade.rsiTouched,
          reason: `🛡️ [Safe Zone] 유예 시간 내 급락. 반등 대기 (${durationMin.toFixed(1)}분 경과)`,
        };
      }

      // 유예 시간 종료 또는 반등 실패 시 최종 컷오프
      return {
        action: "PROTECTION_CLOSE",
        reason: "🚨 [Loss Cut] 합산 손실 한도 초과 및 유예 시간 종료.",
        totalNetUSDT,
        rsi,
        rsiTouched: hedgeTrade.rsiTouched,
      };
    }

    // [수익 구출 로직]
    if (totalNetUSDT >= totalMargin * 0.05) {
      return {
        action: "CLOSE_LOSER",
        side: openSide,
        pnlUSDT: openSide === "long" ? longNetUSDT : shortNetUSDT,
        totalNetUSDT,
        rsi,
        rsiTouched: hedgeTrade.rsiTouched,
        reason: "💰 합산 수익 5% 달성!",
      };
    }
    if (durationMin >= 15 && totalNetUSDT >= totalMargin * 0.02) {
      return {
        action: "CLOSE_LOSER",
        side: openSide,
        pnlUSDT: openSide === "long" ? longNetUSDT : shortNetUSDT,
        totalNetUSDT,
        rsi,
        rsiTouched: hedgeTrade.rsiTouched,
        reason: "⏱️ 15분 경과 & 2% 수익 탈출",
      };
    }
    if (durationMin >= 60 && totalNetUSDT >= totalMargin * 0.01) {
      return {
        action: "CLOSE_LOSER",
        side: openSide,
        pnlUSDT: openSide === "long" ? longNetUSDT : shortNetUSDT,
        totalNetUSDT,
        rsi,
        rsiTouched: hedgeTrade.rsiTouched,
        reason: "⏳ 1시간 경과 & 1% 수익 탈출",
      };
    }

    // 본절 또는 지표 회복 시 탈출
    if (
      (openSide === "long" && (longNetUSDT >= 0 || rsi >= 60)) ||
      (openSide === "short" && (shortNetUSDT >= 0 || rsi <= 40))
    ) {
      return {
        action: "CLOSE_LOSER",
        side: openSide,
        pnlUSDT: openSide === "long" ? longNetUSDT : shortNetUSDT,
        totalNetUSDT,
        rsi,
        rsiTouched: hedgeTrade.rsiTouched,
        reason: "🔄 본절/지표 회복 탈출",
      };
    }
  } else {
    // 3. 양방향 보유 중 급격한 추세로 인한 방어선 도달
    if (totalNetUSDT <= -totalMargin * p.hedgeStopLossTotal) {
      return {
        action: "PROTECTION_CLOSE",
        reason: "🚨 [Protection] 양방향 보유 중 총 손실 한계 초과.",
        totalNetUSDT,
        rsi,
        rsiTouched: hedgeTrade.rsiTouched,
      };
    }
  }

  // 기본 상태 유지 (HOLD)
  return {
    action: "HOLD",
    longNetUSDT,
    shortNetUSDT,
    rsi,
    rsiTouched: hedgeTrade.rsiTouched, // [보완] index 로그에서 Touch 상태를 보여주기 위해 필수
  };
}
