import fs from "fs";
import path from "path";
import { okxHedge, setupHedgeExchange } from "./exchange_hedge_v2.js";
import { getIndicatorsHedge } from "./analyzer_hedge_v2.js";
import {
  checkHedgeExitLogic,
  calculateHedgePositionSize,
} from "./strategy_hedge_v2.js";
import { powerState, profitPercent } from "./symbol_config.js";

let symbol = "BTC/USDT:USDT";
try {
  const configPath = path.join(process.cwd(), "proportion.json");
  if (fs.existsSync(configPath)) {
    const configStr = fs.readFileSync(configPath, "utf8");
    const config = JSON.parse(configStr);
    if (config.bots?.hedge_v2?.symbol) symbol = config.bots.hedge_v2.symbol;
  }
} catch (e) {}

const isLive = process.argv.includes("--live");

const stateFilePath = path.join(
  process.cwd(),
  isLive ? "state_hedge_v2.json" : "state_hedge-dry_v2.json",
);
const historyFilePath = path.join(
  process.cwd(),
  isLive ? "history_hedge_v2.json" : "history_hedge-dry_v2.json",
);

let appState = null;

function loadAppState() {
  if (fs.existsSync(stateFilePath)) {
    try {
      appState = JSON.parse(fs.readFileSync(stateFilePath, "utf8"));
      console.log(JSON.parse(fs.readFileSync(stateFilePath, "utf8")));
      if (!isLive && !appState.currentUSDT) appState.currentUSDT = 100;
    } catch (e) {
      appState = {
        currentUSDT: isLive ? 0 : 100,
        hedgeTrade: null,
        cooldownUntil: 0,
      };
    }
  } else {
    appState = {
      currentUSDT: isLive ? 0 : 100,
      hedgeTrade: null,
      cooldownUntil: 0,
    };
    saveAppState();
  }
}

function saveAppState() {
  fs.writeFileSync(stateFilePath, JSON.stringify(appState, null, 2));
}

function appendHistory(tradeData) {
  let history = [];
  if (fs.existsSync(historyFilePath)) {
    try {
      history = JSON.parse(fs.readFileSync(historyFilePath, "utf8"));
    } catch (e) {
      history = [];
    }
  }
  history.push(tradeData);
  fs.writeFileSync(historyFilePath, JSON.stringify(history, null, 2));
}

async function monitorLoop() {
  if (!powerState()) return console.log("파워가 꺼져있습니다. - hedge");

  try {
    // 1. 잔액 확인
    let usdtBalance = 0;
    let freeUSDT = 0;
    if (isLive) {
      const balance = await okxHedge.fetchBalance();
      usdtBalance = Number(balance.total.USDT || 0);
      freeUSDT = Number(balance.free.USDT || 0);
      appState.currentUSDT = usdtBalance;
    } else {
      usdtBalance = appState.currentUSDT || 100;
      freeUSDT = usdtBalance;
    }

    // 2. 비중 및 profitMode 로드
    let hedgeProportion = 0.2;
    try {
      const configPath = path.join(process.cwd(), "proportion.json");
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        hedgeProportion = config.bots.hedge_v2.proportion || 0.2;
        // strategy에서 사용할 수 있도록 appState에 profitMode 저장
        appState.profitMode = config.bots.hedge_v2.profitMode || 30;
      }
    } catch (e) {
      console.error("⚠️ proportion 로드 에러", e.message);
    }

    saveAppState();

    // 3. 쿨다운 확인
    if (appState.cooldownUntil && Date.now() < appState.cooldownUntil) {
      const remain = Math.floor((appState.cooldownUntil - Date.now()) / 1000);
      console.log(`⏳ [HEDGE] 쿨다운 대기 중... (${remain}초)`);
      return;
    }

    // 4. 데이터 및 지표
    const ohlcv15M = await okxHedge.fetchOHLCV(symbol, "15m", undefined, 200);
    if (!ohlcv15M || ohlcv15M.length < 30) return;
    const indicators = getIndicatorsHedge(ohlcv15M);
    if (!indicators) return;

    // --------------------------------------------------------------------------
    // [관리 로직] 포지션이 있을 때
    // --------------------------------------------------------------------------
    if (appState.hedgeTrade) {
      const exitResult = checkHedgeExitLogic(
        appState.hedgeTrade,
        indicators,
        symbol,
      );

      // A. 전체 종료 (Rule 2: 수익 5% 돌파 시)
      if (exitResult.action === "CLOSE_ALL") {
        console.log(`🚀 [CLOSE_ALL] 수익 5% 돌파! 모든 포지션 종료 시도...`);
        if (isLive) {
          await Promise.all([
            okxHedge.createOrder(
              symbol,
              "market",
              "sell",
              appState.hedgeTrade.longAmount,
              undefined,
              { posSide: "long" },
            ),
            okxHedge.createOrder(
              symbol,
              "market",
              "buy",
              appState.hedgeTrade.shortAmount,
              undefined,
              { posSide: "short" },
            ),
          ]).catch(console.error);
        }

        const totalNetUSDT = exitResult.totalNetUSDT;
        appendHistory({
          time: new Date().toLocaleString(),
          reason: exitResult.reason,
          totalPnlUSDT: totalNetUSDT,
        });
        appState.hedgeTrade = null;
        saveAppState();
        return;
      }

      // B. 부분 익절 (Initial & Pyramid)
      if (exitResult.action === "CLOSE_PARTIAL_WINNER") {
        const sideToClose = exitResult.side;
        const currentSideAmount =
          sideToClose === "long"
            ? appState.hedgeTrade.longAmount
            : appState.hedgeTrade.shortAmount;
        let exitQty = Number(
          okxHedge.amountToPrecision(
            symbol,
            currentSideAmount * exitResult.qtyRate,
          ),
        );

        if (isLive) {
          const order = await okxHedge.createOrder(
            symbol,
            "market",
            sideToClose === "long" ? "sell" : "buy",
            exitQty,
            undefined,
            { posSide: sideToClose },
          );
          const filledQty = Number(order.filled || exitQty);
          if (sideToClose === "long")
            appState.hedgeTrade.longAmount -= filledQty;
          else appState.hedgeTrade.shortAmount -= filledQty;
        }

        appState.hedgeTrade.partialWinnerClosed = true;
        appState.hedgeTrade.realizedProfit =
          (appState.hedgeTrade.realizedProfit || 0) + exitResult.profitUSDT;
        appState.hedgeTrade.lastPartialExitTime = Date.now();
        appState.hedgeTrade.lastRsi = indicators.rsi;
        // 다음 피라미딩을 위해 현재 PnL 기록 (중요!)
        appState.hedgeTrade.lastWinnerPnlRate = exitResult.currentWinnerPnlRate;

        console.log(
          `✨ [PARTIAL] ${sideToClose.toUpperCase()} ${exitResult.qtyRate * 100}% 익절 | 사유: ${exitResult.reason}`,
        );
        saveAppState();
      } else if (exitResult.action === "CLOSE_WINNER") {
        const finalQty =
          exitResult.side === "long"
            ? appState.hedgeTrade.longAmount
            : appState.hedgeTrade.shortAmount;
        if (isLive) {
          await okxHedge.createOrder(
            symbol,
            "market",
            exitResult.side === "long" ? "sell" : "buy",
            finalQty,
            undefined,
            { posSide: exitResult.side },
          );
        }
        appState.hedgeTrade.sideOpened[exitResult.side] = false;
        if (exitResult.side === "long") appState.hedgeTrade.longAmount = 0;
        else appState.hedgeTrade.shortAmount = 0;
        appState.hedgeTrade.winnerClosed = exitResult.side;
        appState.hedgeTrade.winnerPnL = exitResult.profitUSDT;
        appState.hedgeTrade.winnerClosedTime = Date.now();
        console.log(
          `🎯 [WINNER CLOSED] ${exitResult.side.toUpperCase()} 전량 익절 완료`,
        );
        saveAppState();
      } else if (
        exitResult.action === "CLOSE_LOSER" ||
        exitResult.action === "PROTECTION_CLOSE"
      ) {
        // Loser 종료 로직... (기존 코드와 동일하되 수량 정확히 체크)
        if (isLive) {
          if (appState.hedgeTrade.longAmount > 0)
            await okxHedge.createOrder(
              symbol,
              "market",
              "sell",
              appState.hedgeTrade.longAmount,
              undefined,
              { posSide: "long" },
            );
          if (appState.hedgeTrade.shortAmount > 0)
            await okxHedge.createOrder(
              symbol,
              "market",
              "buy",
              appState.hedgeTrade.shortAmount,
              undefined,
              { posSide: "short" },
            );
        }
        const totalNetUSDT =
          exitResult.action === "PROTECTION_CLOSE"
            ? exitResult.totalNetUSDT
            : (appState.hedgeTrade.winnerPnL || 0) +
              (appState.hedgeTrade.realizedProfit || 0) +
              exitResult.pnlUSDT;
        console.log(
          `\n============== [HEDGE 종료: ${exitResult.reason}] ==============`,
        );
        console.log(`최종 수익: ${totalNetUSDT.toFixed(4)} USDT`);
        appState.hedgeTrade = null;
        saveAppState();
      } else {
        // --------------------------------------------------------------------------
        // [로그 복구] HOLD 상태일 때 실시간 모니터링 로그 출력
        // --------------------------------------------------------------------------
        const openSides = [];
        if (appState.hedgeTrade.longAmount > 0)
          openSides.push(`Long:${exitResult.longNetUSDT.toFixed(2)}`);
        if (appState.hedgeTrade.shortAmount > 0)
          openSides.push(`Short:${exitResult.shortNetUSDT.toFixed(2)}`);

        process.stdout.write(
          `\r🧪 [MONITOR] ${openSides.join(" | ")} | RSI: ${indicators.rsi.toFixed(1)} | P: ${appState.profitMode}%    `,
        );
      }
      return;
    }

    // --------------------------------------------------------------------------
    // [진입 로직] 포지션이 없을 때
    // --------------------------------------------------------------------------
    let rawAmount = calculateHedgePositionSize(
      usdtBalance,
      indicators.currentPrice,
      hedgeProportion,
    );
    await okxHedge.loadMarkets();
    let amount = Number(okxHedge.amountToPrecision(symbol, rawAmount));

    // 잔고 안전 버퍼
    if (isLive && (amount * indicators.currentPrice) / 10 > freeUSDT * 0.9) {
      amount = Number(
        okxHedge.amountToPrecision(
          symbol,
          (freeUSDT * 0.85 * 10) / indicators.currentPrice,
        ),
      );
    }

    if (amount < (okxHedge.markets[symbol]?.limits?.amount?.min || 0.01))
      return;

    console.log(`🧨 [ENTRY] 신규 양방향 진입 시도... (수량: ${amount})`);
    const [longOrder, shortOrder] = await Promise.all([
      okxHedge.createOrder(symbol, "market", "buy", amount, undefined, {
        posSide: "long",
      }),
      okxHedge.createOrder(symbol, "market", "sell", amount, undefined, {
        posSide: "short",
      }),
    ]);

    appState.hedgeTrade = {
      entryTime: Date.now(),
      proportion: hedgeProportion,
      longAmount: Number(longOrder.filled || amount),
      shortAmount: Number(shortOrder.filled || amount),
      usdtBefore: usdtBalance,
      sideOpened: { long: true, short: true },
      longEntry: Number(longOrder.average || indicators.currentPrice),
      shortEntry: Number(shortOrder.average || indicators.currentPrice),
      winnerPnL: 0,
      realizedProfit: 0,
      currentQtyRate: 1.0,
    };
    saveAppState();
    console.log("✅ [ENTRY] 진입 완료!");
  } catch (error) {
    console.error("❌ Hedge 루프 에러:", error);
  }
}

async function startHedgeBot() {
  console.log(
    `🤖 Hedge V-Catch 봇 셋업 중... [모드: ${isLive ? "LIVE 🔥" : "DRY RUN 🧪"}]`,
  );
  await setupHedgeExchange(symbol);

  loadAppState();
  console.log("📄 state_hedge.json 기록을 불러왔습니다.");

  console.log("🔄 Hedge 봇 시장 감시 시작 (15초마다)...");
  monitorLoop();
  setInterval(monitorLoop, 5000);
}

startHedgeBot();
