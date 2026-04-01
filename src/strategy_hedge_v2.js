import { getNetFeeRate } from "./strategy.js";
import { getSymbolParams, profitPercent } from "./symbol_config.js";

// 계산: 포지션 사이즈
export function calculateHedgePositionSize(
  usdtBalance,
  currentPrice,
  proportion,
) {
  // [수정] 90% 안전 버퍼 적용: 수수료 및 진입 시 슬리피지를 고려해 가용 잔고의 90%만 사용 (51008 에러 방지)
  const safetyBuffer = 0.9;
  const safeBalance = usdtBalance * safetyBuffer;

  // 양방향 각각 총 비중의 절반씩. proportion이 0.20 이라면 롱 10%, 숏 10%
  const oneSideMarginSize = safeBalance * (proportion / 2);
  const positionValue = oneSideMarginSize * 10; // 10배 레버리지
  return positionValue / currentPrice;
}

/**
 * 3번 봇 전용: 실시간 피라미딩 익절 + 시간/지표 기반 Loser 구출 전략
 */
export function checkHedgeExitLogic(hedgeTrade, indicators, symbol) {
  if (!hedgeTrade) return { action: "NONE" };

  const { rsi, currentPrice } = indicators;
  const netFeeRate = getNetFeeRate();
  const p = getSymbolParams(symbol);

  // [추가] 최소 익절 수익률 제한 (2%): 수수료를 제외하고 내 주머니에 남는 게 있을 때만 매도
  const MIN_PROFIT_LIMIT = 0.02;

  // 초기 익절 비중 (profitPercent()가 50이면 0.5)
  const initialProfitRate = profitPercent() / 100;

  // 마진 및 수량 설정
  const initialMarginPerSide =
    hedgeTrade.usdtBefore * (hedgeTrade.proportion / 2);
  const totalMargin = initialMarginPerSide * 2;
  const currentQtyRate = hedgeTrade.currentQtyRate || 1.0;

  // 현재 포지션에 투입된 실제 마진 (익절 후 남은 비중 반영)
  const currentMarginPerSide = initialMarginPerSide * currentQtyRate;

  // 실시간 PnL 계산
  const longRawPnL = (currentPrice / hedgeTrade.longEntry - 1) * 10;
  const shortRawPnL =
    ((hedgeTrade.shortEntry - currentPrice) / hedgeTrade.shortEntry) * 10;

  // [수정] 순수익 계산 시 현재 남은 마진(currentMarginPerSide)을 기준으로 계산하도록 정교화
  const longNetUSDT = hedgeTrade.sideOpened.long
    ? currentMarginPerSide * longRawPnL - currentMarginPerSide * 10 * netFeeRate
    : 0;
  const shortNetUSDT = hedgeTrade.sideOpened.short
    ? currentMarginPerSide * shortRawPnL -
      currentMarginPerSide * 10 * netFeeRate
    : 0;

  const realizedProfit = hedgeTrade.realizedProfit || 0;
  const totalNetUSDT =
    (hedgeTrade.winnerPnL || 0) + longNetUSDT + shortNetUSDT + realizedProfit;

  // RSI 터치 기록 업데이트
  if (rsi >= 70) hedgeTrade.rsiTouched = "overbought";
  if (rsi <= 30) hedgeTrade.rsiTouched = "oversold";

  // --------------------------------------------------------------------------
  // Phase 1: Winner 관리 (피라미딩 익절)
  // --------------------------------------------------------------------------
  if (!hedgeTrade.winnerClosed) {
    const isLongWinner = longNetUSDT > shortNetUSDT;
    const side = isLongWinner ? "long" : "short";
    const winnerNetUSDT = isLongWinner ? longNetUSDT : shortNetUSDT;

    // [추가] 현재 Winner 포지션의 순수익률(PnL %) 계산
    const currentWinnerPnlRate = winnerNetUSDT / currentMarginPerSide;

    // A. 초기 익절 (RSI 70/30 도달 시)
    if (!hedgeTrade.partialWinnerClosed) {
      // [수정] RSI 조건 뿐만 아니라 수익률이 2% 이상(MIN_PROFIT_LIMIT)일 때만 실행
      const isRsiTriggered =
        (isLongWinner && rsi >= 70) || (!isLongWinner && rsi <= 30);

      if (isRsiTriggered && currentWinnerPnlRate >= MIN_PROFIT_LIMIT) {
        return {
          action: "CLOSE_PARTIAL_WINNER",
          side,
          qtyRate: initialProfitRate,
          profitUSDT: winnerNetUSDT * initialProfitRate,
          rsi,
          rsiTouched: hedgeTrade.rsiTouched,
          reason: `🌋 [Initial] 2% 이상 수익(${(currentWinnerPnlRate * 100).toFixed(1)}%) 확인 후 익절`,
        };
      }
    }
    // B. 피라미딩 추격 매도 (10%씩)
    else if (currentQtyRate > 0.05 && !hedgeTrade.pyramidComplete) {
      const timeSinceLastExit =
        (Date.now() - (hedgeTrade.lastPartialExitTime || 0)) / 1000;
      const isStillInZone = isLongWinner ? rsi >= 70 : rsi <= 30;

      const lastRsi = hedgeTrade.lastRsi || (isLongWinner ? 70 : 30);
      const isImproving = isLongWinner
        ? rsi > lastRsi + 0.2
        : rsi < lastRsi - 0.2;

      // [수정] 피라미딩 시에도 수익률이 최소 기준(2%)을 유지하고 있는지 체크하면 더 안전함
      if (
        timeSinceLastExit >= 40 &&
        isStillInZone &&
        isImproving &&
        currentWinnerPnlRate >= MIN_PROFIT_LIMIT
      ) {
        return {
          action: "CLOSE_PARTIAL_WINNER",
          side,
          qtyRate: 0.1,
          profitUSDT: winnerNetUSDT * 0.1,
          rsi,
          rsiTouched: hedgeTrade.rsiTouched,
          reason: `📈 [Pyramid] 수익 유지 중(${(currentWinnerPnlRate * 100).toFixed(1)}%) 추가 익절`,
        };
      }
    }

    // C. V-Catch 최종 전량 종료
    const vCatchLong =
      hedgeTrade.rsiTouched === "overbought" && rsi < 70 && isLongWinner;
    const vCatchShort =
      hedgeTrade.rsiTouched === "oversold" && rsi > 30 && !isLongWinner;

    if (vCatchLong || vCatchShort) {
      return {
        action: "CLOSE_WINNER",
        side,
        profitUSDT: winnerNetUSDT,
        rsi,
        rsiTouched: hedgeTrade.rsiTouched,
        reason: "🎯 [V-Catch] 추세 꺾임 감지, 전량 익절",
      };
    }
  }

  // --------------------------------------------------------------------------
  // Phase 2: Loser 관리 및 보호 로직 (기존 유지)
  // --------------------------------------------------------------------------
  if (hedgeTrade.winnerClosed) {
    const openSide = hedgeTrade.sideOpened.long ? "long" : "short";
    const durationMin = (Date.now() - hedgeTrade.winnerClosedTime) / 60000;
    const isInReversionZone =
      (openSide === "long" && rsi <= 35) || (openSide === "short" && rsi >= 65);

    if (totalNetUSDT <= -totalMargin * p.hedgeStopLossTotal) {
      if (isInReversionZone && durationMin < 14) {
        return {
          action: "HOLD",
          longNetUSDT,
          shortNetUSDT,
          rsi,
          rsiTouched: hedgeTrade.rsiTouched,
          reason: `🛡️ [Safe Zone] 유예 시간 내 반등 대기 (${durationMin.toFixed(1)}분)`,
        };
      }
      return {
        action: "PROTECTION_CLOSE",
        reason: "🚨 [Loss Cut] 유예 시간 종료 또는 반등 실패.",
        totalNetUSDT,
        rsi,
        rsiTouched: hedgeTrade.rsiTouched,
      };
    }
    const isNetProfitPositive = totalNetUSDT >= totalMargin * 0.005;
    // 1. 합산 수익 5% 달성
    if (totalNetUSDT >= totalMargin * 0.05) {
      return {
        action: "CLOSE_LOSER",
        side: openSide,
        pnlUSDT: openSide === "long" ? longNetUSDT : shortNetUSDT, // 현재 Loser의 순수 손익만 전달
        totalNetUSDT, // 로깅용으로 합산 수익도 같이 넘겨주면 좋음
        rsi,
        reason: "💰 합산 수익 5% 달성",
      };
    }

    // 2. 15분 경과 & 2% 수익
    if (durationMin >= 15 && totalNetUSDT >= totalMargin * 0.02) {
      return {
        action: "CLOSE_LOSER",
        side: openSide,
        pnlUSDT: openSide === "long" ? longNetUSDT : shortNetUSDT,
        totalNetUSDT,
        rsi,
        reason: "⏱️ 15분 경과 & 2% 수익",
      };
    }

    // 3. 1시간 경과 & 1% 수익
    if (durationMin >= 60 && totalNetUSDT >= totalMargin * 0.01) {
      return {
        action: "CLOSE_LOSER",
        side: openSide,
        pnlUSDT: openSide === "long" ? longNetUSDT : shortNetUSDT,
        totalNetUSDT,
        rsi,
        reason: "⏳ 1시간 경과 & 1% 수익",
      };
    }

    // 4. [중요 수정] 지표 회복 탈출 (본절 또는 RSI 60/40)
    // 단순히 rsi만 보는 게 아니라, "합산 수익이 플러스(isNetProfitPositive)"일 때만 나가도록 제한
    if (
      (openSide === "long" &&
        (longNetUSDT >= 0 || (rsi >= 60 && isNetProfitPositive))) ||
      (openSide === "short" &&
        (shortNetUSDT >= 0 || (rsi <= 40 && isNetProfitPositive)))
    ) {
      return {
        action: "CLOSE_LOSER",
        side: openSide,
        pnlUSDT: openSide === "long" ? longNetUSDT : shortNetUSDT,
        totalNetUSDT,
        rsi,
        // 사유에 실제 수익 상태를 표기해두면 나중에 분석하기 좋습니다.
        reason: `🔄 지표 회복 탈출 (Net: ${totalNetUSDT.toFixed(4)})`,
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
