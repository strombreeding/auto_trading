import fs from "fs";
import path from "path";
import { okx15m, setupSentryExchange } from "./exchange_15m.js";
import { getIndicators15M } from "./analyzer_15m.js";
import {
  checkSentryStrategy,
  calculateSentryPositionSize,
  getSentryBracketParams,
} from "./strategy_sentry_15m.js";
import { getNetFeeRate } from "./strategy.js";

let symbol = "BTC/USDT:USDT";
let proportion;
try {
  const configPath = path.join(process.cwd(), "proportion.json");
  if (fs.existsSync(configPath)) {
    const configStr = fs.readFileSync(configPath, "utf8");
    const config = JSON.parse(configStr);
    proportion = config;
    if (config.bots?.sentry_15m?.symbol) symbol = config.bots.sentry_15m.symbol;
  }
} catch (e) {}

// 명령줄 인자를 통한 모드 판별: node src/index_sentry.js --live
const isLive = process.argv.includes("--live");

const stateFilePath = path.join(
  process.cwd(),
  isLive ? "state_sentry.json" : "state_sentry-dry.json",
);
const historyFilePath = path.join(
  process.cwd(),
  isLive ? "history_sentry.json" : "history_sentry-dry.json",
);

let appState = null;

function loadAppState() {
  if (fs.existsSync(stateFilePath)) {
    try {
      appState = JSON.parse(fs.readFileSync(stateFilePath, "utf8"));
      if (!isLive && !appState.currentUSDT) appState.currentUSDT = 100;
    } catch (e) {
      appState = {
        currentUSDT: isLive ? 0 : 100,
        strategyData: {},
        virtualTrade: null,
      };
    }
  } else {
    appState = {
      currentUSDT: isLive ? 0 : 100,
      strategyData: {},
      virtualTrade: null,
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
  if (!proportion.powerOn) return console.log("파워가 꺼져있습니다. - main");
  try {
    let usdtBalance = 0;
    if (isLive) {
      const balance = await okx15m.fetchBalance();
      usdtBalance = Number(balance.total.USDT || 0);
      appState.currentUSDT = usdtBalance;
    } else {
      usdtBalance = appState.currentUSDT || 100;
    }

    let sentryProportion = 0.3;
    try {
      const configPath = path.join(process.cwd(), "proportion.json");
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        sentryProportion = config.bots.sentry_15m.proportion || 0.3;
      }
    } catch (e) {
      console.error("⚠️ proportion JSON 로드 에러", e.message);
    }

    saveAppState();

    // 0-A. [LIVE 모드] 활성 포지션 체크 및 안전 장치
    if (isLive) {
      const positions = await okx15m.fetchPositions([symbol]);
      const activePosition = positions.find((p) => Number(p.contracts) > 0);
      if (activePosition) {
        const pnlStr =
          activePosition.percentage !== undefined
            ? ` | 수익률: ${Number(activePosition.percentage).toFixed(2)}%`
            : "";
        const currentMark =
          activePosition.markPrice || activePosition.lastPrice || "N/A";
        const baseCoin = symbol.split("/")[0];
        console.log(
          `🔥 [SENTRY LIVE] 진입가: ${activePosition.entryPrice} | 현재가: ${currentMark}${pnlStr} (규모: ${activePosition.contracts} ${baseCoin})`,
        );
        return;
      }
    }

    // 0-B. [DRY RUN 모드] 가상 포지션 종료 로직기록용 PNL 계산
    if (!isLive && appState.virtualTrade) {
      const vt = appState.virtualTrade;
      // 가장 최근 15분 봉만 가볍게 확인
      const ohlcv15M_latest = await okx15m.fetchOHLCV(
        symbol,
        "15m",
        undefined,
        5,
      );
      if (!ohlcv15M_latest || ohlcv15M_latest.length === 0) return;

      const latestCandle = ohlcv15M_latest[ohlcv15M_latest.length - 1];
      const h = Number(latestCandle[2]);
      const l = Number(latestCandle[3]);
      const c = Number(latestCandle[4]);

      let closed = false;
      let exitPrice = 0;
      let exitReason = "";

      if (vt.side === "buy") {
        if (h >= vt.tp) {
          closed = true;
          exitPrice = vt.tp;
          exitReason = "TP 🎯";
        } else if (l <= vt.sl) {
          closed = true;
          exitPrice = vt.sl;
          exitReason = "SL 🛑";
        }
      } else {
        if (l <= vt.tp) {
          closed = true;
          exitPrice = vt.tp;
          exitReason = "TP 🎯";
        } else if (h >= vt.sl) {
          closed = true;
          exitPrice = vt.sl;
          exitReason = "SL 🛑";
        }
      }

      if (closed) {
        const durationMin = ((Date.now() - vt.entryTime) / 60000).toFixed(1);

        let rawPnlPercent =
          vt.side === "buy"
            ? (exitPrice / vt.entryPrice - 1) * 10
            : ((vt.entryPrice - exitPrice) / vt.entryPrice) * 10;

        const marginUsed = vt.usdtBefore * sentryProportion;
        const positionValue = marginUsed * 10;

        const netFeeRate = getNetFeeRate();
        const netFeeUSDT = positionValue * netFeeRate;
        const grossPnlUSDT = marginUsed * rawPnlPercent;
        const netPnlUSDT = (grossPnlUSDT - netFeeUSDT).toFixed(4);

        console.log(`\n============== [SENTRY 15M 결과] ==============`);
        console.log(
          `[종료] 방향: ${vt.side.toUpperCase()} | 사유: ${exitReason}`,
        );
        console.log(`Net PNL: ${netPnlUSDT} USDT (수수료 제함)`);
        console.log(`소요 시간: ${durationMin}분`);
        console.log(`===========================================\n`);

        appendHistory({
          time: new Date().toLocaleString(),
          mode: "SENTRY_DRY_RUN",
          side: vt.side.toUpperCase(),
          entryPrice: vt.entryPrice,
          exitPrice: exitPrice,
          durationMinutes: durationMin,
          reason: exitReason,
          pnlUSDT: Number(netPnlUSDT),
        });

        appState.virtualTrade = null;
        if (!isLive) appState.currentUSDT += Number(netPnlUSDT);
        saveAppState();
      } else {
        let rawUnrealized =
          vt.side === "buy"
            ? (c / vt.entryPrice - 1) * 10
            : ((vt.entryPrice - c) / vt.entryPrice) * 10;
        const unrealizedRoe = (rawUnrealized * 100).toFixed(2);
        vt.currentPrice = c;
        vt.unrealizedRoe = `${unrealizedRoe}%`;
        saveAppState();

        console.log(
          `🧪 [SENTRY DRY RUN] 방향: ${vt.side.toUpperCase()} | 수익률: ${unrealizedRoe}% (TP: ${vt.tp.toFixed(1)}, SL: ${vt.sl.toFixed(1)})`,
        );
      }
      return;
    }

    // 포지션이 없다면 타점 스캔 진행
    const ohlcv15M = await okx15m.fetchOHLCV(symbol, "15m", undefined, 50);

    if (!ohlcv15M || ohlcv15M.length < 30) {
      console.log("⚠️ Sentry 데이터를 가져오지 못했습니다.");
      return;
    }

    // 15M 특화 지표 추출
    const indicators = getIndicators15M(ohlcv15M);
    if (!indicators) return;

    // 전략 확인
    const signal = checkSentryStrategy(indicators, symbol);

    console.log(
      `[SENTRY 15M (ADX: ${indicators.adx.toFixed(1)})] 상태: ${signal.reason}`,
    );

    if (signal.shouldEnter) {
      // 잔고 조건 필터링 해제

      const side = signal.side;
      let rawAmount = calculateSentryPositionSize(
        usdtBalance,
        indicators.currentPrice,
        sentryProportion,
      );

      await okx15m.loadMarkets();
      let amount = Number(okx15m.amountToPrecision(symbol, rawAmount));
      const minAmount = okx15m.markets[symbol]?.limits?.amount?.min || 0.01;

      if (amount < minAmount) {
        console.log(
          `⚠️ 계산된 진입 수량(${amount})이 OKX 최소 주문 수량(${minAmount})보다 작습니다!`,
        );
        return;
      }

      // 15M 브라켓 파라미터 획득
      const rawParams = getSentryBracketParams(
        side,
        indicators.currentPrice,
        signal.mode,
        indicators.bbMid,
        symbol,
      );

      const preciseTP = Number(
        okx15m.priceToPrecision(symbol, rawParams.takeProfit.triggerPrice),
      );
      const preciseSL = Number(
        okx15m.priceToPrecision(symbol, rawParams.stopLoss.triggerPrice),
      );

      const params = {
        takeProfit: { triggerPrice: preciseTP },
        stopLoss: { triggerPrice: preciseSL },
        marginMode: "isolated",
      };

      const baseCoin = symbol.split("/")[0];
      if (isLive) {
        console.log(
          `🧨 [SENTRY LIVE] 진입 시도: ${side.toUpperCase()} ${amount} ${baseCoin} (TP: ${preciseTP}, SL: ${preciseSL})`,
        );
        try {
          await okx15m.createOrder(
            symbol,
            "market",
            side,
            amount,
            undefined,
            params,
          );
          console.log("✅ [SENTRY LIVE] 실거래 진입 성공!");
        } catch (err) {
          console.error("❌ [SENTRY LIVE] 에러:", err.message);
        }
      } else {
        console.log(
          `🚀 [SENTRY DRY RUN] 가상 진입 시도: ${side.toUpperCase()} ${amount} ${baseCoin} (TP: ${preciseTP}, SL: ${preciseSL})`,
        );
        appState.virtualTrade = {
          entryTime: Date.now(),
          mode: signal.mode,
          side: side,
          entryPrice: indicators.currentPrice,
          amount: amount,
          tp: preciseTP,
          sl: preciseSL,
          usdtBefore: usdtBalance,
        };
        saveAppState();
      }
    }
  } catch (error) {
    console.error("❌ Sentry 루프 에러:", error.message);
  }
}

async function startSentryBot() {
  console.log(
    `🤖 Sentry 15M 롱/숏 봇 셋업 중... [모드: ${isLive ? "LIVE 🔥" : "DRY RUN 🧪"}]`,
  );
  await setupSentryExchange(symbol);

  loadAppState();
  console.log("📄 state_sentry.json 기록을 불러왔습니다.");

  console.log("🔄 Sentry 시장 감시 시작 (15초마다)...");
  monitorLoop();
  // 실시간 타점 포착을 위해 15초 간격 유지.
  setInterval(monitorLoop, 15000);
}

startSentryBot();
