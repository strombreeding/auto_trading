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
  const netFeeRate = getNetFeeRate();
  const p = getSymbolParams(symbol);

  // [중요] 초기 진입 시점의 한쪽 증거금 (10 USDT 등)
  const initialMarginPerSide =
    hedgeTrade.usdtBefore * (hedgeTrade.proportion / 2);

  // 현재 남아있는 수량에 비례한 실시간 마진 계산
  // (처음엔 100% 수량이다가, 50% 익절 후에는 절반만 남음)
  const currentMarginPerSide =
    initialMarginPerSide * (hedgeTrade.partialWinnerClosed ? 0.5 : 1.0);

  let longRawPnL = 0;
  let shortRawPnL = 0;

  if (hedgeTrade.sideOpened.long) {
    longRawPnL = (currentPrice / hedgeTrade.longEntry - 1) * 10;
  }
  if (hedgeTrade.sideOpened.short) {
    shortRawPnL =
      ((hedgeTrade.shortEntry - currentPrice) / hedgeTrade.shortEntry) * 10;
  }

  // 현재 보유 중인 수량에 대한 미실현 수익 (수수료는 진입 시점에 이미 전액 계산되었다고 가정하거나, 매도 시점 계산)
  const longNetUSDT = hedgeTrade.sideOpened.long
    ? currentMarginPerSide * longRawPnL - currentMarginPerSide * 10 * netFeeRate
    : 0;
  const shortNetUSDT = hedgeTrade.sideOpened.short
    ? currentMarginPerSide * shortRawPnL -
      currentMarginPerSide * 10 * netFeeRate
    : 0;

  // 총 합산 수익 = (미실현 수익) + (이미 50% 팔아서 챙긴 실현 수익)
  const realizedProfit = hedgeTrade.realizedProfit || 0;

  // 목표 수익 및 손절 기준은 "전체 투입 원금" 기준이므로 initialMarginPerSide 사용
  const TARGET_PROFIT_USDT = initialMarginPerSide * p.hedgeTakeProfit;
  const totalMargin = initialMarginPerSide * 2;

  // RSI 기록 업데이트
  if (rsi >= 70) hedgeTrade.rsiTouched = "overbought";
  if (rsi <= 30) hedgeTrade.rsiTouched = "oversold";

  // 1. Phase 1: Winner 관리 (둘 다 열려있을 때)
  if (!hedgeTrade.winnerClosed) {
    const hitRsiTpLong =
      hedgeTrade.rsiTouched === "overbought" && rsi < 70 && longNetUSDT > 0;
    const hitRsiTpShort =
      hedgeTrade.rsiTouched === "oversold" && rsi > 30 && shortNetUSDT > 0;

    // 1-1. 롱(Long) 승리 시
    if (longNetUSDT + realizedProfit >= TARGET_PROFIT_USDT) {
      // RSI 70 이상이고 아직 50% 매도를 안 했다면? -> 50% 매도 실행
      if (rsi >= 70 && !hedgeTrade.partialWinnerClosed) {
        return {
          action: "CLOSE_PARTIAL_WINNER",
          side: "long",
          profitUSDT: longNetUSDT * 0.5, // 이번에 확정 지을 수익
          reason: `🔥 [Partial Exit] 롱 RSI ${rsi.toFixed(1)} 도달! 50% 선제 익절.`,
        };
      }
    }

    // V-Catch 발생 시 (남은 포지션 전량 종료)
    if (hitRsiTpLong) {
      return {
        action: "CLOSE_WINNER",
        side: "long",
        profitUSDT: longNetUSDT + realizedProfit,
        reason: `🎯 [Phase 1] 롱 전량 종료 (V-Catch).`,
      };
    }

    // 1-2. 숏(Short) 승리 시 (위와 동일 로직)
    if (shortNetUSDT + realizedProfit >= TARGET_PROFIT_USDT) {
      if (rsi <= 30 && !hedgeTrade.partialWinnerClosed) {
        return {
          action: "CLOSE_PARTIAL_WINNER",
          side: "short",
          profitUSDT: shortNetUSDT * 0.5,
          reason: `❄️ [Partial Exit] 숏 RSI ${rsi.toFixed(1)} 도달! 50% 선제 익절.`,
        };
      }
    }

    if (hitRsiTpShort) {
      return {
        action: "CLOSE_WINNER",
        side: "short",
        profitUSDT: shortNetUSDT + realizedProfit,
        reason: `🎯 [Phase 1] 숏 전량 종료 (V-Catch).`,
      };
    }
  }

  // 2. Phase 2: Loser 관리 및 구출 로직 (하나만 남았을 때)
  if (hedgeTrade.winnerClosed) {
    const openSide = hedgeTrade.sideOpened.long ? "long" : "short";
    const securedProfit = hedgeTrade.winnerPnL || 0;
    const currentOpenPnL = hedgeTrade.sideOpened.long
      ? longNetUSDT
      : shortNetUSDT;
    const totalNetUSDT =
      (hedgeTrade.winnerPnL || 0) + currentOpenPnL + realizedProfit;

    // 🛠️ [수정] Winner 종료 후 경과 시간 계산 (분 단위)
    const durationMin = hedgeTrade.winnerClosedTime
      ? (Date.now() - hedgeTrade.winnerClosedTime) / 60000
      : 0;

    // 🛠️ [신규] 반등 유력 구간(Safe Zone) 여부 판단
    // 롱 Loser인데 RSI가 35 이하이거나, 숏 Loser인데 RSI가 65 이상인 경우
    const isInReversionZone =
      (openSide === "long" && rsi <= 35) || (openSide === "short" && rsi >= 65);

    // 🛠️ [신규] 동적 수익 목표 설정 (2% ~ 4%)
    const MIN_QUICK_EXIT = totalMargin * 0.02; // 2% 수익
    const MAX_QUICK_EXIT = totalMargin * 0.04; // 4% 수익 (이 이상은 즉시 종료)

    // 🚀 [신규] 2~4% 사이의 '빠른 탈출' 로직
    if (totalNetUSDT >= MIN_QUICK_EXIT) {
      if (totalNetUSDT >= MAX_QUICK_EXIT) {
        return {
          action: "CLOSE_LOSER",
          side: openSide,
          pnlUSDT: currentOpenPnL,
          reason: `🎯 [Quick Exit] 합산 수익 4% 돌파! 시간 절약을 위해 즉시 익절.`,
        };
      }

      if (openSide === "long" && (rsi >= 55 || durationMin >= 15)) {
        return {
          action: "CLOSE_LOSER",
          side: openSide,
          pnlUSDT: currentOpenPnL,
          reason: `💰 [Quick Exit] 2% 이상 수익 중 RSI(${rsi.toFixed(1)}) 저항 또는 15분 경과로 탈출.`,
        };
      }
      if (openSide === "short" && (rsi <= 45 || durationMin >= 15)) {
        return {
          action: "CLOSE_LOSER",
          side: openSide,
          pnlUSDT: currentOpenPnL,
          reason: `💰 [Quick Exit] 2% 이상 수익 중 RSI(${rsi.toFixed(1)}) 지지 또는 15분 경과로 탈출.`,
        };
      }
    }

    // ⏳ [신규] Time Decay (자본 회수) 로직
    if (durationMin >= 30 && totalNetUSDT >= totalMargin * 0.01) {
      return {
        action: "CLOSE_LOSER",
        side: openSide,
        pnlUSDT: currentOpenPnL,
        reason: `⌛ [Time Decay] 30분 경과. 1% 합산 수익권에서 다음 판을 위해 탈출.`,
      };
    }

    // 기존 개별 본절 및 RSI 60/40 탈출 (유지)
    if (openSide === "long") {
      if (longNetUSDT >= 0)
        return {
          action: "CLOSE_LOSER",
          side: "long",
          pnlUSDT: longNetUSDT,
          reason: "🔄 본절 회복.",
        };
      if (rsi >= 60)
        return {
          action: "CLOSE_LOSER",
          side: "long",
          pnlUSDT: longNetUSDT,
          reason: "🔄 RSI 반등 지점 도달.",
        };
    } else {
      if (shortNetUSDT >= 0)
        return {
          action: "CLOSE_LOSER",
          side: "short",
          pnlUSDT: shortNetUSDT,
          reason: "🔄 본절 회복.",
        };
      if (rsi <= 40)
        return {
          action: "CLOSE_LOSER",
          side: "short",
          pnlUSDT: shortNetUSDT,
          reason: "🔄 RSI 하락 지점 도달.",
        };
    }

    // 🛠️ [수정] 보호 로직 (14분 유예 반영)
    if (totalNetUSDT <= -totalMargin * p.hedgeStopLossTotal) {
      // 🔥 [신규 추가] 14분 반등 유예 필터 (꼬리 방어 핵심)
      // RSI가 여전히 극점 구간에 있고, Winner 종료 후 14분 이내라면 손절을 나가지 않고 버팁니다.
      if (isInReversionZone && durationMin < 14) {
        return {
          action: "HOLD",
          rsi,
          longNetUSDT,
          shortNetUSDT,
          reason: `🛡️ [Safe Zone] 지표 신뢰 구간 및 유예 시간 내 급락. 반등 대기 (경과: ${durationMin.toFixed(1)}분)`,
        };
      }

      // 유예 시간이 지났거나 RSI가 이미 중립으로 올라왔음에도 손실이 크다면 최종 컷오프
      return {
        action: "PROTECTION_CLOSE",
        reason: "🚨 합산 손실 초과. (유예 시간 종료 또는 반등 실패)",
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
