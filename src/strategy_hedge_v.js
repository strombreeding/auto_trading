import { getNetFeeRate } from "./strategy.js";
import { getSymbolParams } from "./symbol_config.js";
import fs from "fs";
import path from "path";

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

function getProfitMode() {
  const configPath = path.join(process.cwd(), "proportion.json");
  if (fs.existsSync(configPath)) {
    const configStr = fs.readFileSync(configPath, "utf8");
    const config = JSON.parse(configStr);
    return config.profitMode || 30;
  }
  return 50;
}

/**
 * Hedge V-Catch 포지션 관리 로직
 */
export function checkHedgeExitLogic(hedgeTrade, indicators, symbol) {
  if (!hedgeTrade) return { action: "NONE" };

  const { rsi, currentPrice } = indicators;
  const ROUND_TRIP_FEE = 0.00034; // 시장가 왕복 수수료 0.034%
  const p = getSymbolParams(symbol);

  // 1. [추가] profitMode 값 가져오기 (기본값 30%)
  const profitMode = getProfitMode(); // 외부 설정파일에서 읽어온다고 가정
  const initialProfitRate = profitMode / 100;

  // 2. 마진 및 PnL 계산
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

  // RSI 기록
  if (rsi >= 70) hedgeTrade.rsiTouched = "overbought";
  if (rsi <= 30) hedgeTrade.rsiTouched = "oversold";

  // --------------------------------------------------------------------------
  // Phase 1: Winner 관리 (피라미딩 익절 로직)
  // --------------------------------------------------------------------------
  if (!hedgeTrade.winnerClosed) {
    const isLongWinner = longNetUSDT > shortNetUSDT;
    const side = isLongWinner ? "long" : "short";
    const winnerNetUSDT = isLongWinner ? longNetUSDT : shortNetUSDT;
    const currentWinnerMargin = isLongWinner ? longMargin : shortMargin;
    const currentWinnerPnlRate = winnerNetUSDT / currentWinnerMargin;

    // A. [최초 익절] RSI 70/30 터치 시 profitMode 비율만큼 판매
    if (!hedgeTrade.partialWinnerClosed) {
      const isRsiTriggered =
        (isLongWinner && rsi >= 70) || (!isLongWinner && rsi <= 30);
      if (isRsiTriggered) {
        return {
          action: "CLOSE_PARTIAL_WINNER",
          side,
          qtyRate: initialProfitRate, // profitMode 비율 적용
          profitUSDT: winnerNetUSDT * initialProfitRate,
          rsi,
          reason: `🌋 [Initial] RSI ${rsi.toFixed(1)} 터치, ${profitMode}% 선제 익절`,
        };
      }
    }
    // B. [피라미딩] 15초 경과 + RSI 개선 + PnL 2% 이상 상승 시 10% 추가 익절
    else {
      const timeSinceLastExit =
        (Date.now() - (hedgeTrade.lastPartialExitTime || 0)) / 1000;
      const lastRsi = hedgeTrade.lastRsi || (isLongWinner ? 70 : 30);
      const lastPnlRate = hedgeTrade.lastWinnerPnlRate || 0;

      const isRsiImproving = isLongWinner ? rsi > lastRsi : rsi < lastRsi;
      const isPnlImproving = currentWinnerPnlRate >= lastPnlRate + 0.02; // 2% 이상 수익 상승

      if (timeSinceLastExit >= 15 && isRsiImproving && isPnlImproving) {
        return {
          action: "CLOSE_PARTIAL_WINNER",
          side,
          qtyRate: 0.1, // 남은 수량의 10%가 아니라 전체 대비 10% (index.js에서 처리)
          profitUSDT: winnerNetUSDT * 0.1,
          rsi,
          reason: `📈 [Pyramid] RSI 개선 및 수익 2% 상승 확인, 10% 추가 익절`,
        };
      }
    }

    // C. [전량 종료] RSI가 다시 70 미만(롱) / 30 초과(숏)로 내려올 때
    const vCatchLong =
      hedgeTrade.rsiTouched === "overbought" && rsi < 70 && isLongWinner;
    const vCatchShort =
      hedgeTrade.rsiTouched === "oversold" && rsi > 30 && !isLongWinner;

    if (vCatchLong || vCatchShort) {
      // Rule 2 반영: RSI가 꺾였을 때 합산 수익이 5% 이상이면 Loser까지 같이 종료하도록 action 설계
      if (totalNetUSDT >= totalMargin * 0.05) {
        return {
          action: "CLOSE_ALL", // Winner와 Loser 동시 종료
          reason: `🎯 [V-Catch] RSI 반전 및 합산 수익 5% 돌파, 전체 종료`,
          totalNetUSDT,
        };
      }

      return {
        action: "CLOSE_WINNER",
        side,
        profitUSDT: winnerNetUSDT,
        rsi,
        reason: `🎯 [V-Catch] RSI 추세 꺾임, Winner 전량 종료`,
      };
    }
  }

  // --------------------------------------------------------------------------
  // Phase 2: Loser 관리 (시간 기반 탈출 로직)
  // --------------------------------------------------------------------------
  if (hedgeTrade.winnerClosed) {
    const openSide = hedgeTrade.sideOpened.long ? "long" : "short";
    const durationMin = (Date.now() - hedgeTrade.winnerClosedTime) / 60000;
    const netProfitRate = totalNetUSDT / totalMargin;

    // Rule 3: 15분 경과 & 합산 수익 4% 이상
    if (durationMin >= 15 && netProfitRate >= 0.04) {
      return {
        action: "CLOSE_LOSER",
        side: openSide,
        pnlUSDT: openSide === "long" ? longNetUSDT : shortNetUSDT,
        reason: "⏱️ 15분 경과 & 수익 4% 탈출",
      };
    }

    // Rule 4: 30분 경과 & 합산 수익 3% 이상
    if (durationMin >= 30 && netProfitRate >= 0.03) {
      return {
        action: "CLOSE_LOSER",
        side: openSide,
        pnlUSDT: openSide === "long" ? longNetUSDT : shortNetUSDT,
        reason: "⏱️ 30분 경과 & 수익 3% 탈출",
      };
    }

    // Rule 5: 45분 경과 & 합산 수익 2% 이상
    if (durationMin >= 45 && netProfitRate >= 0.02) {
      return {
        action: "CLOSE_LOSER",
        side: openSide,
        pnlUSDT: openSide === "long" ? longNetUSDT : shortNetUSDT,
        reason: "⏱️ 45분 경과 & 수익 2% 탈출",
      };
    }

    // 기본 탈출 (본절 혹은 지표 회복)
    if (
      (openSide === "long" && (longNetUSDT >= 0 || rsi >= 60)) ||
      (openSide === "short" && (shortNetUSDT >= 0 || rsi <= 40))
    ) {
      return {
        action: "CLOSE_LOSER",
        side: openSide,
        pnlUSDT: openSide === "long" ? longNetUSDT : shortNetUSDT,
        reason: "🔄 지표 회복 및 본절 탈출",
      };
    }
  }

  return { action: "HOLD", longNetUSDT, shortNetUSDT, rsi };
}
