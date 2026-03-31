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
    let usdtBalance = 0;
    if (isLive) {
      const balance = await okxHedge.fetchBalance();
      usdtBalance = Number(balance.total.USDT || 0);
      appState.currentUSDT = usdtBalance;
    } else {
      usdtBalance = appState.currentUSDT || 100;
    }

    let hedgeProportion = 0.2;
    try {
      const configPath = path.join(process.cwd(), "proportion.json");
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        hedgeProportion = config.bots.hedge_v2.proportion || 0.2;
      }
    } catch (e) {
      console.error("⚠️ proportion JSON 로드 에러", e.message);
    }

    saveAppState();

    // 쿨다운(보호 모드 후 5분 대기) 확인
    if (appState.cooldownUntil && Date.now() < appState.cooldownUntil) {
      const remainSec = Math.floor(
        (appState.cooldownUntil - Date.now()) / 1000,
      );
      console.log(
        `⏳ [HEDGE] 보호 로직 쿨다운 대기 중... (${remainSec}초 남음)`,
      );
      return;
    }

    // 데이터 가져오기 (15분봉)
    const ohlcv15M = await okxHedge.fetchOHLCV(symbol, "15m", undefined, 200);
    if (!ohlcv15M || ohlcv15M.length < 30) {
      console.log("⚠️ Hedge 15M 데이터를 가져오지 못했습니다.");
      return;
    }

    const indicators = getIndicatorsHedge(ohlcv15M);
    if (!indicators) return;
    // 포지션이 열려있는지 확인 후 관리
    if (appState.hedgeTrade) {
      const exitResult = checkHedgeExitLogic(
        appState.hedgeTrade,
        indicators,
        symbol,
      );
      if (exitResult.action === "CLOSE_PARTIAL_WINNER") {
        const sideToClose = exitResult.side;
        const currentAmount = appState.hedgeTrade.amount;
        let exitQty = currentAmount * exitResult.qtyRate; // 계산된 비율만큼 매도
        exitQty = Number(okxHedge.amountToPrecision(symbol, exitQty)); // 거래소 규격에 맞게 반올림/내림
        if (isLive) {
          const orderSide = sideToClose === "long" ? "sell" : "buy";
          await okxHedge
            .createOrder(symbol, "market", orderSide, exitQty, undefined, {
              posSide: sideToClose,
              marginMode: "isolated",
            })
            .catch(console.error);
        }

        // 상태 업데이트
        appState.hedgeTrade.amount -= exitQty; // 남은 수량 갱신
        appState.hedgeTrade.currentQtyRate =
          (appState.hedgeTrade.currentQtyRate || 1.0) - exitResult.qtyRate;
        appState.hedgeTrade.partialWinnerClosed = true;
        appState.hedgeTrade.realizedProfit =
          (appState.hedgeTrade.realizedProfit || 0) + exitResult.profitUSDT;
        appState.hedgeTrade.lastPartialExitTime = Date.now();
        appState.hedgeTrade.lastRsi = indicators.rsi;

        // 10%씩 다 팔아서 남은 게 거의 없다면 피라미딩 종료 플래그
        if (appState.hedgeTrade.currentQtyRate <= 0.2) {
          appState.hedgeTrade.pyramidComplete = true;
        }

        console.log(
          `\n✨ [PARTIAL EXIT] ${sideToClose.toUpperCase()} ${exitResult.qtyRate * 100}% 익절`,
        );
        console.log(
          `사유: ${exitResult.reason} | 남은비중: ${(appState.hedgeTrade.currentQtyRate * 100).toFixed(0)}%`,
        );
        saveAppState();
      } else if (exitResult.action === "CLOSE_WINNER") {
        const sideToClose = exitResult.side; // long or short
        if (isLive) {
          const orderSide = sideToClose === "long" ? "sell" : "buy";

          await okxHedge
            .createOrder(
              symbol,
              "market",
              orderSide,
              appState.hedgeTrade.amount,
              undefined,
              { posSide: sideToClose, marginMode: "isolated" },
            )
            .catch(console.error);
        }
        appState.hedgeTrade.sideOpened[sideToClose] = false;
        appState.hedgeTrade.winnerClosed = sideToClose;
        appState.hedgeTrade.winnerPnL = exitResult.profitUSDT;

        // 🛠️ [추가] Winner가 팔린 시간을 기록하여 Phase 2 타이머 시작
        appState.hedgeTrade.winnerClosedTime = Date.now();

        console.log(`\n============== [HEDGE WINNER 익절] ==============`);
        console.log(
          `방향: ${sideToClose.toUpperCase()} | 사유: ${exitResult.reason}`,
        );
        console.log(
          `수익: ${exitResult.profitUSDT.toFixed(4)} USDT (수수료 제함)`,
        );
        console.log(`=================================================`);
        saveAppState();
      } else if (
        exitResult.action === "CLOSE_LOSER" ||
        exitResult.action === "PROTECTION_CLOSE"
      ) {
        // 남은 포지션 닫기
        if (isLive) {
          if (appState.hedgeTrade.sideOpened.long) {
            await okxHedge
              .createOrder(
                symbol,
                "market",
                "sell",
                appState.hedgeTrade.amount,
                undefined,
                { posSide: "long", marginMode: "isolated" },
              )
              .catch(console.error);
          }
          if (appState.hedgeTrade.sideOpened.short) {
            await okxHedge
              .createOrder(
                symbol,
                "market",
                "buy",
                appState.hedgeTrade.amount,
                undefined,
                { posSide: "short", marginMode: "isolated" },
              )
              .catch(console.error);
          }
        }

        const totalNetUSDT =
          exitResult.action === "PROTECTION_CLOSE"
            ? exitResult.totalNetUSDT
            : appState.hedgeTrade.winnerPnL + exitResult.pnlUSDT;

        const durationMin = (
          (Date.now() - appState.hedgeTrade.entryTime) /
          60000
        ).toFixed(1);

        console.log(`\n============== [HEDGE 전량 종료] ==============`);
        console.log(`사유: ${exitResult.reason}`);
        console.log(`최종 합산 Net PNL: ${totalNetUSDT.toFixed(4)} USDT`);
        console.log(`소요 시간: ${durationMin}분`);
        console.log(`===========================================\n`);

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

        // 손실 보호 발동 시 5분 매매 정지
        if (exitResult.action === "PROTECTION_CLOSE") {
          console.log(
            "⏳ 보호 로직 발동으로 인해 5분간 매매를 일시정지합니다.",
          );
          appState.cooldownUntil = Date.now() + 5 * 60 * 1000;
          saveAppState();
        }
      } else {
        // HOLD 상태 로깅
        let unRealizedRoe = "N/A";
        if (appState.hedgeTrade.winnerClosed) {
          const openSide = appState.hedgeTrade.sideOpened.long
            ? "long"
            : "short";
          const pnl =
            openSide === "long"
              ? exitResult.longNetUSDT
              : exitResult.shortNetUSDT;
          unRealizedRoe = `Loser(${openSide.toUpperCase()}) PNL: ${pnl.toFixed(4)} USDT`;
        } else {
          unRealizedRoe = `Long: ${exitResult.longNetUSDT.toFixed(4)} / Short: ${exitResult.shortNetUSDT.toFixed(4)} USDT`;
        }
        console.log(
          `🧪 [HEDGE] ${unRealizedRoe} | 15M RSI: ${exitResult.rsi.toFixed(1)} | Touch: ${exitResult.rsiTouched || "None"}`,
        );
      }
      return;
    }

    // 포지션이 없고 쿨다운도 끝났으면 새로 양방향 진입
    // 잔고 조건 필터링 해제
    console.log("이거 확인해", indicators);

    let rawAmount = calculateHedgePositionSize(
      usdtBalance,
      indicators.currentPrice,
      hedgeProportion,
    );
    await okxHedge.loadMarkets();
    let amount = Number(okxHedge.amountToPrecision(symbol, rawAmount));
    const minAmount = okxHedge.markets[symbol]?.limits?.amount?.min || 0.01;
    console.log(minAmount, "최소주분금액");
    if (amount < minAmount) {
      console.log(
        `⚠️ 계산된 진입 수량(${amount})이 OKX 최소 주문 수량(${minAmount})보다 작습니다! 비중이나 잔고를 늘려주세요.`,
      );
      return;
    }

    const baseCoin = symbol.split("/")[0];
    if (isLive) {
      console.log(
        `🧨 [HEDGE LIVE] 롱/숏 양방향 동시 진입 시장가 오픈 시도 (수량: 각각 ${amount} ${baseCoin})...`,
      );
      const nowSet = await okxHedge.fetchLeverage(symbol, {
        marginMode: "isolated",
      });
      console.log(nowSet, usdtBalance);
      // const bal = await okxHedge.fetchBalance();
      // console.log(bal.total);
      console.log(amount);
      try {
        await Promise.all([
          okxHedge.createOrder(symbol, "market", "buy", amount, undefined, {
            posSide: "long",
            marginMode: "isolated",
          }),
          okxHedge.createOrder(symbol, "market", "sell", amount, undefined, {
            posSide: "short",
            marginMode: "isolated",
          }),
        ]);
        console.log("✅ [HEDGE LIVE] 양방향 포지션 동시 오픈 완료!");
      } catch (err) {
        console.error("❌ [HEDGE LIVE] 진입 에러:", err.message);
        return;
      }
    } else {
      console.log(
        `🚀 [HEDGE DRY RUN] 가상 양방향 진입 기록 완료 (수량: 각각 ${amount} ${baseCoin}).`,
      );
    }

    appState.hedgeTrade = {
      entryTime: Date.now(),
      proportion: hedgeProportion,
      amount: amount,
      usdtBefore: usdtBalance,
      sideOpened: { long: true, short: true },
      longEntry: indicators.currentPrice,
      shortEntry: indicators.currentPrice,
      rsiTouched: null,
      winnerClosed: null,
      winnerPnL: 0,
    };
    saveAppState();
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
