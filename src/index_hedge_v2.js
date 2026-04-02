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
    // 1. 잔액 확인 및 가용 잔고 확보
    let usdtBalance = 0;
    let freeUSDT = 0;
    if (isLive) {
      const balance = await okxHedge.fetchBalance();
      usdtBalance = Number(balance.total.USDT || 0);
      freeUSDT = Number(balance.free.USDT || 0); // 실제 주문 가능한 금액
      appState.currentUSDT = usdtBalance;
    } else {
      usdtBalance = appState.currentUSDT || 100;
      freeUSDT = usdtBalance;
    }

    // 비중 설정 로드 (기존과 동일)
    let hedgeProportion = 0.2;
    try {
      const configPath = path.join(process.cwd(), "proportion.json");
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        hedgeProportion = config.bots.hedge_v2.proportion || 0.2;
      }
    } catch (e) {
      console.error("⚠️ proportion 로드 에러", e.message);
    }

    saveAppState();

    // 쿨다운 확인 (기존과 동일)
    if (appState.cooldownUntil && Date.now() < appState.cooldownUntil) return;

    // 데이터 가져오기 및 지표 계산 (기존과 동일)
    const ohlcv15M = await okxHedge.fetchOHLCV(symbol, "15m", undefined, 200);
    if (!ohlcv15M || ohlcv15M.length < 30) return;
    const indicators = getIndicatorsHedge(ohlcv15M);
    if (!indicators) return;

    // --------------------------------------------------------------------------
    // [Phase 1 & 2] 포지션 관리 로직
    // --------------------------------------------------------------------------
    if (appState.hedgeTrade) {
      const exitResult = checkHedgeExitLogic(
        appState.hedgeTrade,
        indicators,
        symbol,
      );

      // A. 부분 익절 (Winner Partial Close)
      if (exitResult.action === "CLOSE_PARTIAL_WINNER") {
        const sideToClose = exitResult.side;
        // [수정] 공용 amount가 아닌 해당 방향의 개별 수량 사용
        const currentSideAmount =
          sideToClose === "long"
            ? appState.hedgeTrade.longAmount
            : appState.hedgeTrade.shortAmount;
        let exitQty = currentSideAmount * exitResult.qtyRate;
        exitQty = Number(okxHedge.amountToPrecision(symbol, exitQty));

        if (isLive) {
          const orderSide = sideToClose === "long" ? "sell" : "buy";
          const order = await okxHedge.createOrder(
            symbol,
            "market",
            orderSide,
            exitQty,
            undefined,
            {
              posSide: sideToClose,
              marginMode: "isolated",
            },
          );

          // [수정] 실제 체결된 수량만큼만 차감 (찌꺼기 방지)
          const filledQty = Number(order.filled || exitQty);
          if (sideToClose === "long")
            appState.hedgeTrade.longAmount -= filledQty;
          else appState.hedgeTrade.shortAmount -= filledQty;
        }

        appState.hedgeTrade.currentQtyRate =
          (appState.hedgeTrade.currentQtyRate || 1.0) - exitResult.qtyRate;
        appState.hedgeTrade.partialWinnerClosed = true;
        appState.hedgeTrade.realizedProfit =
          (appState.hedgeTrade.realizedProfit || 0) + exitResult.profitUSDT;
        appState.hedgeTrade.lastPartialExitTime = Date.now();
        appState.hedgeTrade.lastRsi = indicators.rsi;

        if (appState.hedgeTrade.currentQtyRate <= 0.2)
          appState.hedgeTrade.pyramidComplete = true;

        console.log(
          `\n✨ [PARTIAL EXIT] ${sideToClose.toUpperCase()} 익절완료 | 남은수량: ${sideToClose === "long" ? appState.hedgeTrade.longAmount : appState.hedgeTrade.shortAmount}`,
        );
        saveAppState();

        // B. Winner 전량 종료
      } else if (exitResult.action === "CLOSE_WINNER") {
        const sideToClose = exitResult.side;
        const finalQty =
          sideToClose === "long"
            ? appState.hedgeTrade.longAmount
            : appState.hedgeTrade.shortAmount;

        if (isLive) {
          const orderSide = sideToClose === "long" ? "sell" : "buy";
          await okxHedge
            .createOrder(symbol, "market", orderSide, finalQty, undefined, {
              posSide: sideToClose,
              marginMode: "isolated",
            })
            .catch(console.error);
        }

        appState.hedgeTrade.sideOpened[sideToClose] = false;
        if (sideToClose === "long") appState.hedgeTrade.longAmount = 0;
        else appState.hedgeTrade.shortAmount = 0;

        appState.hedgeTrade.winnerClosed = sideToClose;
        appState.hedgeTrade.winnerPnL = exitResult.profitUSDT;
        appState.hedgeTrade.winnerClosedTime = Date.now();

        console.log(`\n============== [HEDGE WINNER 익절 종료] ==============`);
        saveAppState();

        // C. Loser 종료 또는 보호 로직 작동
      } else if (
        exitResult.action === "CLOSE_LOSER" ||
        exitResult.action === "PROTECTION_CLOSE"
      ) {
        if (isLive) {
          // [수정] 남아있는 모든 개별 수량을 정확히 0으로 만듦
          if (
            appState.hedgeTrade.sideOpened.long &&
            appState.hedgeTrade.longAmount > 0
          ) {
            await okxHedge
              .createOrder(
                symbol,
                "market",
                "sell",
                appState.hedgeTrade.longAmount,
                undefined,
                { posSide: "long", marginMode: "isolated" },
              )
              .catch(console.error);
          }
          if (
            appState.hedgeTrade.sideOpened.short &&
            appState.hedgeTrade.shortAmount > 0
          ) {
            await okxHedge
              .createOrder(
                symbol,
                "market",
                "buy",
                appState.hedgeTrade.shortAmount,
                undefined,
                { posSide: "short", marginMode: "isolated" },
              )
              .catch(console.error);
          }
        }

        // 최종 수익 계산 (Winner수익 + 부분익절수익 + 마지막Loser손익)
        const totalNetUSDT =
          exitResult.action === "PROTECTION_CLOSE"
            ? exitResult.totalNetUSDT
            : (appState.hedgeTrade.winnerPnL || 0) +
              (appState.hedgeTrade.realizedProfit || 0) +
              exitResult.pnlUSDT;

        const durationMin = (
          (Date.now() - appState.hedgeTrade.entryTime) /
          60000
        ).toFixed(1);

        console.log(`\n============== [HEDGE 전체 정산 완료] ==============`);
        console.log(`최종 합산 Net PNL: ${totalNetUSDT.toFixed(4)} USDT`);

        appendHistory({
          time: new Date().toLocaleString(),
          mode: isLive ? "HEDGE_LIVE" : "HEDGE_DRY_RUN",
          durationMinutes: durationMin,
          reason: exitResult.reason,
          totalPnlUSDT: Number(totalNetUSDT.toFixed(4)),
        });

        appState.hedgeTrade = null;
        if (!isLive) appState.currentUSDT += Number(totalNetUSDT);
        saveAppState();

        if (exitResult.action === "PROTECTION_CLOSE") {
          appState.cooldownUntil = Date.now() + 5 * 60 * 1000;
          saveAppState();
        }
      } else {
        // HOLD 상태 로깅 (생략)
      }
      return;
    }

    // --------------------------------------------------------------------------
    // [Phase 0] 신규 진입 로직
    // --------------------------------------------------------------------------
    let rawAmount = calculateHedgePositionSize(
      usdtBalance,
      indicators.currentPrice,
      hedgeProportion,
    );
    await okxHedge.loadMarkets();
    let amount = Number(okxHedge.amountToPrecision(symbol, rawAmount));

    // [추가] 90% 안전 버퍼 적용 (51008 에러 방지)
    const requiredMargin = (amount * indicators.currentPrice) / 10;
    if (isLive && requiredMargin > freeUSDT * 0.9) {
      amount = Number(
        okxHedge.amountToPrecision(
          symbol,
          (freeUSDT * 0.85 * 10) / indicators.currentPrice,
        ),
      );
      console.log(`⚠️ 잔고 버퍼 적용으로 수량 조정: ${amount}`);
    }

    if (amount < (okxHedge.markets[symbol]?.limits?.amount?.min || 0.01))
      return;

    try {
      const [longOrder, shortOrder] = await Promise.all([
        okxHedge.createOrder(symbol, "market", "buy", amount, undefined, {
          posSide: "long",
          marginMode: "isolated",
        }),
        okxHedge.createOrder(symbol, "market", "sell", amount, undefined, {
          posSide: "short",
          marginMode: "isolated",
        }),
      ]);

      // [수정] 롱/숏 수량과 진입가를 각각 따로 저장하여 데이터 정합성 확보
      appState.hedgeTrade = {
        entryTime: Date.now(),
        proportion: hedgeProportion,
        longAmount: Number(longOrder.filled || amount),
        shortAmount: Number(shortOrder.filled || amount),
        usdtBefore: usdtBalance,
        sideOpened: { long: true, short: true },
        longEntry: Number(longOrder.average || indicators.currentPrice),
        shortEntry: Number(shortOrder.average || indicators.currentPrice),
        rsiTouched: null,
        winnerClosed: null,
        winnerPnL: 0,
        realizedProfit: 0,
        currentQtyRate: 1.0,
      };
      saveAppState();
      console.log("✅ [HEDGE LIVE] 롱/숏 개별 수량 기록 및 진입 완료!");
    } catch (err) {
      console.error("❌ [HEDGE LIVE] 진입 에러:", err.message);
    }
  } catch (error) {
    console.error("❌ Hedge 루프 에러:", error.message);
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
