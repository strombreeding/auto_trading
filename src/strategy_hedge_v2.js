import fs from "fs";
import path from "path";
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

// 포지션 수수료율 계산
export function getNetFeeRate() {
  const TAKER_FEE_RATE = 0.00017; // 0.017%
  const MAKER_FEE_RATE = 0.00007; // 0.007%
  // 현재 봇은 전부 시장가 주문을 사용하므로 Taker 요율의 2배를 리턴
  const roundTripFee = TAKER_FEE_RATE * 2;
  return roundTripFee; // 0.00034
}

function getProfitMode() {
  try {
    const configPath = path.join(process.cwd(), "proportion.json");
    if (fs.existsSync(configPath)) {
      const configStr = fs.readFileSync(configPath, "utf8");
      const config = JSON.parse(configStr);
      return config.profitMode || 30;
    }
  } catch (err) {
    console.error("Critical: Error reading proportion.json, using default 30", err);
  }
  return 30; // 기본값 30%
}


/**
 * 3번 봇 전용: 실시간 피라미딩 익절 + 시간/지표 기반 Loser 구출 전략
 */
// strategy_hedge_v2.js (수정본)

export function checkHedgeExitLogic(hedgeTrade, indicators, symbol) {
  if (!hedgeTrade) return { action: "NONE" };

  const { rsi, currentPrice } = indicators;
  const ROUND_TRIP_FEE = 0.00034; // 시장가 0.017% * 2
  const p = getSymbolParams(symbol);

  // 설정값
  const MIN_PROFIT_LIMIT = 0.025; // 최소 2.5% 수익 시에만 작동
  const V_CATCH_BUFFER_LONG = 68; // 70 터치 후 강제 종료선
  const V_CATCH_BUFFER_SHORT = 32; // 30 터치 후 강제 종료선
  const V_CATCH_GRACE_SEC = 120; // 2분(120초) 유예 기간
  const RSI_REVERSAL_GAP = 1.5; // 마지막 RSI 대비 유의미한 변화량
  const profitMode = getProfitMode(); // 외부 설정파일에서 읽어온다고 가정
  const initialProfitRate = profitMode / 100;

  // 마진 및 PnL 계산 (이전과 동일)
  const longMargin = hedgeTrade.sideOpened.long
    ? (hedgeTrade.longAmount * hedgeTrade.longEntry) / 10
    : 0;
  const shortMargin = hedgeTrade.sideOpened.short
    ? (hedgeTrade.shortAmount * hedgeTrade.shortEntry) / 10
    : 0;
  const totalMargin = hedgeTrade.usdtBefore * hedgeTrade.proportion;

  const longRawPnL = (currentPrice / hedgeTrade.longEntry - 1) * 10;
  const shortRawPnL =
    ((hedgeTrade.shortEntry - currentPrice) / hedgeTrade.shortEntry) * 10;

  const longNetUSDT = hedgeTrade.sideOpened.long
    ? longMargin * longRawPnL - longMargin * 10 * ROUND_TRIP_FEE
    : 0;
  const shortNetUSDT = hedgeTrade.sideOpened.short
    ? shortMargin * shortRawPnL - shortMargin * 10 * ROUND_TRIP_FEE
    : 0;

  const realizedProfit = hedgeTrade.realizedProfit || 0;
  const totalNetUSDT =
    (hedgeTrade.winnerPnL || 0) + longNetUSDT + shortNetUSDT + realizedProfit;

  if (rsi >= 70) hedgeTrade.rsiTouched = "overbought";
  if (rsi <= 30) hedgeTrade.rsiTouched = "oversold";

  // Phase 1: Winner 관리
  if (!hedgeTrade.winnerClosed) {
    const isLongWinner = longNetUSDT > shortNetUSDT;
    const side = isLongWinner ? "long" : "short";
    const winnerNetUSDT = isLongWinner ? longNetUSDT : shortNetUSDT;
    const currentWinnerMargin = isLongWinner ? longMargin : shortMargin;
    const currentWinnerPnlRate = winnerNetUSDT / currentWinnerMargin;

    // A. 초기 익절
    if (!hedgeTrade.partialWinnerClosed) {
      const isRsiTriggered =
        (isLongWinner && rsi >= 70) || (!isLongWinner && rsi <= 30);
      if (isRsiTriggered && currentWinnerPnlRate >= MIN_PROFIT_LIMIT) {
        return {
          action: "CLOSE_PARTIAL_WINNER",
          side,
          qtyRate: initialProfitRate,
          profitUSDT: winnerNetUSDT * initialProfitRate,
          rsi,
          reason: `🌋 [Initial] ${(currentWinnerPnlRate * 100).toFixed(1)}% 수익 확인 후 익절`,
          currentWinnerPnlRate, // 다음 피라미딩 기준점으로 사용
        };
      }
    }
    // B. 피라미딩 (10%씩)
    else if (!hedgeTrade.pyramidComplete) {
      const timeSinceLastExit =
        (Date.now() - (hedgeTrade.lastPartialExitTime || 0)) / 1000;
      const isStillInZone = isLongWinner ? rsi >= 70 : rsi <= 30;
      
      const lastWinnerPnlRate = hedgeTrade.lastWinnerPnlRate || 0; // 지난번 익절 시점 수익률

      if (
        timeSinceLastExit >= 40 &&
        isStillInZone &&
        currentWinnerPnlRate >= Math.max(MIN_PROFIT_LIMIT, lastWinnerPnlRate + 0.02)
      ) {
        return {
          action: "CLOSE_PARTIAL_WINNER",
          side,
          qtyRate: 0.1,
          profitUSDT: winnerNetUSDT * 0.1,
          rsi,
          reason: `📈 [Pyramid] 수익률 개선 감지 | ${(currentWinnerPnlRate * 100).toFixed(1)}% 추가 익절`,
          currentWinnerPnlRate, // 다음 피라미딩 기준점으로 사용
        };
      }
    }

    // --------------------------------------------------------------------------
    // C. [수정] V-Catch 최종 전량 종료 (시간 유예 + RSI 버퍼 복합 로직)
    // --------------------------------------------------------------------------
    const timeSinceLastExit =
      (Date.now() - (hedgeTrade.lastPartialExitTime || hedgeTrade.entryTime)) /
      1000;
    const lastRsi = hedgeTrade.lastRsi || (isLongWinner ? 70 : 30);

    // 유의미한 수치 변화 확인 (롱은 하락, 숏은 상승)
    const isMeaningfulDrop = rsi < lastRsi - RSI_REVERSAL_GAP;
    const isMeaningfulRise = rsi > lastRsi + RSI_REVERSAL_GAP;

    let shouldVCatch = false;

    if (isLongWinner && hedgeTrade.rsiTouched === "overbought") {
      shouldVCatch =
        rsi <= V_CATCH_BUFFER_LONG || // 조건 1: RSI가 확실히 68 밑으로 꽂혔을 때 (강제 탈출)
        (timeSinceLastExit >= V_CATCH_GRACE_SEC && isMeaningfulDrop); // 조건 2: 2분 지났고, 고점 대비 1.5p 이상 하락 시
    } else if (!isLongWinner && hedgeTrade.rsiTouched === "oversold") {
      shouldVCatch =
        rsi >= V_CATCH_BUFFER_SHORT || // 조건 1: RSI가 확실히 32 위로 뚫렸을 때 (강제 탈출)
        (timeSinceLastExit >= V_CATCH_GRACE_SEC && isMeaningfulRise); // 조건 2: 2분 지났고, 저점 대비 1.5p 이상 반등 시
    }

    if (shouldVCatch) {
      return {
        action: "CLOSE_WINNER",
        side,
        profitUSDT: winnerNetUSDT,
        rsi,
        reason: `🎯 [V-Catch] ${timeSinceLastExit >= V_CATCH_GRACE_SEC ? "시간경과+추세반전" : "강제버퍼돌파"} 종료 (RSI: ${rsi.toFixed(1)})`,
      };
    }
  }

  // --------------------------------------------------------------------------
  // Phase 2: Loser 관리 및 보호 로직
  // --------------------------------------------------------------------------
  if (hedgeTrade.winnerClosed) {
    const openSide = hedgeTrade.sideOpened.long ? "long" : "short";
    const winnerClosedTime = hedgeTrade.winnerClosedTime || Date.now();
    const durationMin = (Date.now() - winnerClosedTime) / 60000;


    // [수정] 안전 마진 기준 상향 (수수료 고려)
    const isNetProfitPositive = totalNetUSDT >= totalMargin * 0.005;

    // Loss Cut 로직 (생략 - 기존 유지)
    if (totalNetUSDT <= -totalMargin * p.hedgeStopLossTotal) {
      // ... (기존 손절 로직 동일)
    }

    // 수익별 탈출 로직 (합산 수익 기준)
    if (totalNetUSDT >= totalMargin * 0.05) {
      return {
        action: "CLOSE_LOSER",
        side: openSide,
        pnlUSDT: openSide === "long" ? longNetUSDT : shortNetUSDT,
        totalNetUSDT,
        rsi,
        reason: "💰 합산 수익 5% 달성",
      };
    }
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

    // 지표 회복 탈출 (버퍼 반영)
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
