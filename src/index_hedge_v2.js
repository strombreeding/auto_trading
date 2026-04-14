import fs from "fs";
import path from "path";
import { okxHedge, setupHedgeExchange } from "./exchange_hedge_v2.js";
import { getIndicatorsHedge } from "./analyzer_hedge_v2.js";
import {
  checkHedgeExitLogic,
  calculateHedgePositionSize,
} from "./strategy_hedge_v2.js";
import { powerState, profitPercent, getSymbolParams } from "./symbol_config.js";

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

/**
 * 거래소 포지션과 로컬 JSON 데이터 동기화
 * (SL 등으로 인한 강제 종료 감지용)
 */
async function syncPositionWithExchange(hedgeTrade) {
  if (!hedgeTrade) return;
  try {
    const positions = await okxHedge.fetchPositions(symbol);

    // 현재 열려있는 포지션 사이드 확인 (long, short)
    const activeSides = positions.map((p) => p.info.posSide); // OKX 기준 'long' or 'short'
    // 1. 롱 포지션이 사라졌는지 확인
    if (hedgeTrade.sideOpened.long && !activeSides.includes("long")) {
      console.log(
        "⚠️ [SYNC] 롱 포지션이 거래소에서 사라짐 (SL 혹은 수동종료 감지)",
      );
      hedgeTrade.sideOpened.long = false;
      hedgeTrade.longAmount = 0;
    }
    // 2. 숏 포지션이 사라졌는지 확인
    if (hedgeTrade.sideOpened.short && !activeSides.includes("short")) {
      console.log(
        "⚠️ [SYNC] 숏 포지션이 거래소에서 사라짐 (SL 혹은 수동종료 감지)",
      );
      hedgeTrade.sideOpened.short = false;
      hedgeTrade.shortAmount = 0;
    }
    // 3. 양쪽 포지션이 모두 사라졌을 경우 거래 종료 처리
    if (!hedgeTrade.sideOpened.long && !hedgeTrade.sideOpened.short) {
      console.log("🎯 [SYNC] 모든 포지션 종료됨. 거래를 클리어합니다.");
      hedgeTrade = null;
      saveAppState();
    }
  } catch (err) {
    console.error("❌ Position Sync Error:", err.message);
  }
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
      // 거래소랑 싱크 맞추기
      await syncPositionWithExchange(appState.hedgeTrade);
      if (!appState.hedgeTrade) return; // 🛡️ SL 등에 의해 포지션이 초기화되었다면 루프 즉시 중단

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
              { posSide: "long", marginMode: "isolated" },
            ),
            okxHedge.createOrder(
              symbol,
              "market",
              "buy",
              appState.hedgeTrade.shortAmount,
              undefined,
              { posSide: "short", marginMode: "isolated" },
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
            { posSide: sideToClose, marginMode: "isolated" },
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
        const sideToClose = exitResult.side;
        const finalQty =
          sideToClose === "long"
            ? appState.hedgeTrade.longAmount
            : appState.hedgeTrade.shortAmount;

        // 1. 수량 검수 (51000 방지)
        if (!finalQty || finalQty <= 0) {
          console.log("⚠️ 종료할 수량이 0입니다. 상태만 초기화합니다.");
          appState.hedgeTrade.sideOpened[sideToClose] = false;
          appState.hedgeTrade.winnerClosed = sideToClose; // 누가 이겼는지는 기록
          saveAppState();
          return;
        }

        // 2. 실전 주문 및 예외 처리
        if (isLive) {
          try {
            const orderSide = sideToClose === "long" ? "sell" : "buy";
            await okxHedge.createOrder(
              symbol,
              "market",
              orderSide,
              finalQty,
              undefined,
              {
                posSide: sideToClose,
                marginMode: "isolated",
              },
            );
            console.log(
              `✅ [HEDGE] ${sideToClose.toUpperCase()} Winner 전량 익절 주문 성공!`,
            );
          } catch (err) {
            if (err.message.includes("51169")) {
              console.log(
                `⚠️ [Sync] 거래소에 ${sideToClose} 포지션이 이미 없습니다. 봇 기억 삭제.`,
              );
              appState.hedgeTrade = null; // 포지션이 아예 없으니 봇을 초기 상태로 리셋
              saveAppState();
              return;
            }
            throw err; // 다른 심각한 에러는 루프 에러로 던짐
          }
        }

        // 3. 주문 성공 후 상태 업데이트 (중요!)
        appState.hedgeTrade.sideOpened[sideToClose] = false; // 닫힌 쪽 표시
        if (sideToClose === "long") appState.hedgeTrade.longAmount = 0;
        else appState.hedgeTrade.shortAmount = 0;

        appState.hedgeTrade.winnerClosed = sideToClose; // 승리자 기록
        appState.hedgeTrade.winnerPnL = exitResult.profitUSDT; // 수익 기록
        appState.hedgeTrade.winnerClosedTime = Date.now(); // Phase 2 타이머 시작

        console.log(
          `🎯 [WINNER CLOSED] ${sideToClose.toUpperCase()} 정리 완료. Phase 2 진입.`,
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
              { posSide: "long", marginMode: "isolated" },
            );
          if (appState.hedgeTrade.shortAmount > 0)
            await okxHedge.createOrder(
              symbol,
              "market",
              "buy",
              appState.hedgeTrade.shortAmount,
              undefined,
              { posSide: "short", marginMode: "isolated" },
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

        console.log(
          `🧪 [MONITOR] ${openSides.join(" | ")} | RSI: ${indicators.rsi.toFixed(1)} | P: ${appState.profitMode}%    `,
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
    const p = getSymbolParams(symbol);

    // 1. 마진 모드 및 레버리지 설정 (진입 전 1회 수행)
    try {
      // OKX는 setMarginMode 호출 시 'lever' 파라미터를 명시적으로 요구하는 경우가 많음
      await okxHedge.setMarginMode("isolated", symbol, { lever: 10 });
      await okxHedge.setLeverage(10, symbol, { posSide: "long" });
      await okxHedge.setLeverage(10, symbol, { posSide: "short" });
      console.log(`✅ [SETTING] 마진(Isolated) 및 레버리지(10x) 설정 완료`);
    } catch (e) {
      if (!e.message.includes("No change")) {
        console.error("⚠️ 마진/레버리지 설정 에러:", e.message);
      }
    }

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

    // --------------------------------------------------------------------------
    // [보호 로직] 청산 방지용 SL 가격 계산 (10배 레버리지 기준)
    // --------------------------------------------------------------------------
    // 지표 가격(15분 캔들 종가)은 변동성이 클 때 실시간 거래소 가격과 차이가 생길 수 있어,
    // 아주 조금이라도 안 맞으면 OKX가 SL trigger price 에러(51278)를 반환합니다.
    // 진입 직전 가장 최신 호가(ticker)를 기준으로 잡아야 안전합니다.
    let livePrice = indicators.currentPrice;
    try {
      const ticker = await okxHedge.fetchTicker(symbol);
      if (ticker && ticker.last) livePrice = ticker.last;
    } catch (err) {
      console.log("⚠️ ticker 조회 실패, 지표 가격을 임시로 사용합니다.");
    }

    const SL_RATE = p.hedgeLiquidationSL || 0.08; // 8% 변동 시 손절 (청산가 전 보호)

    const longSL = okxHedge.priceToPrecision(
      symbol,
      livePrice * (1 - SL_RATE)
    );
    const shortSL = okxHedge.priceToPrecision(
      symbol,
      livePrice * (1 + SL_RATE)
    );

    const [longOrder, shortOrder] = await Promise.all([
      okxHedge.createOrder(symbol, "market", "buy", amount, undefined, {
        posSide: "long",
        marginMode: "isolated",
        // OKX 전용 SL 파라미터 (청산 방지용)
        slTriggerPx: longSL,
        slOrdPx: "-1",
      }),
      okxHedge.createOrder(symbol, "market", "sell", amount, undefined, {
        posSide: "short",
        marginMode: "isolated",
        // OKX 전용 SL 파라미터 (청산 방지용)
        slTriggerPx: shortSL,
        slOrdPx: "-1",
      }),
    ]);

    appState.hedgeTrade = {
      entryTime: Date.now(),
      proportion: hedgeProportion,
      longAmount: Number(longOrder.filled || amount),
      shortAmount: Number(shortOrder.filled || amount),
      usdtBefore: usdtBalance,
      sideOpened: { long: true, short: true },
      longEntry: Number(longOrder.average || livePrice),
      shortEntry: Number(shortOrder.average || livePrice),
      winnerPnL: 0,
      realizedProfit: 0,
      currentQtyRate: 1.0,
      partialWinnerClosed: false,
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
