import fs from "fs";
import path from "path";
import { okx, setupExchange } from "./exchange.js";
import { getIndicators } from "./analyzer.js";
import {
  checkHybridStrategy,
  calculatePositionSize,
  getBracketParams,
  getNetFeeRate,
} from "./strategy.js";
import { powerState } from "./symbol_config.js";

let symbol = "BTC/USDT:USDT";
let proportion;
try {
  const configPath = path.join(process.cwd(), "proportion.json");
  if (fs.existsSync(configPath)) {
    const configStr = fs.readFileSync(configPath, "utf8");
    const config = JSON.parse(configStr);
    proportion = config;
    if (config.bots?.hybrid_5m?.symbol) symbol = config.bots.hybrid_5m.symbol;
  }
} catch (e) {}

// 명령줄 인자(CLI arguments)를 통한 모드 판별
const isLive = process.argv.includes("--live");

const stateFilePath = path.join(
  process.cwd(),
  isLive ? "state.json" : "state-dry.json",
);
const historyFilePath = path.join(
  process.cwd(),
  isLive ? "history.json" : "history-dry.json",
);

let appState = null;

function loadAppState() {
  if (fs.existsSync(stateFilePath)) {
    appState = JSON.parse(fs.readFileSync(stateFilePath, "utf8"));
    if (!appState.strategyData) appState.strategyData = {};
    if (!isLive && !appState.currentUSDT) appState.currentUSDT = 100;
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
  if (!powerState()) return console.log("파워가 꺼져있습니다. - main");
  try {
    let usdtBalance = 0;
    if (isLive) {
      const balance = await okx.fetchBalance();
      usdtBalance = Number(balance.total.USDT || 0);
      appState.currentUSDT = usdtBalance;
    } else {
      usdtBalance = appState.currentUSDT || 100;
    }

    let hybridProportion = 0.2;
    try {
      const configPath = path.join(process.cwd(), "proportion.json");
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        hybridProportion = config.bots.hybrid_5m.proportion || 0.2;
      }
    } catch (e) {
      console.error("⚠️ proportion JSON 로드 에러", e.message);
    }

    saveAppState();

    // 0-A. [LIVE 모드] 실제 거래소 활성 포지션 체크 및 Safety Net (스탑로스 검사)
    if (isLive) {
      const positions = await okx.fetchPositions([symbol]);
      const activePosition = positions.find((p) => Number(p.contracts) > 0);

      if (activePosition) {
        // CCXT가 주는 미실현 수익/현재가 정보 활용
        const pnlStr =
          activePosition.percentage !== undefined
            ? ` | 수익률: ${Number(activePosition.percentage).toFixed(2)}%`
            : "";
        const currentMark =
          activePosition.markPrice || activePosition.lastPrice || "N/A";
        const baseCoin = symbol.split("/")[0];
        console.log(
          `🔥 [LIVE 포지션 상태] 진입가: ${activePosition.entryPrice} | 마크가: ${currentMark}${pnlStr} (규모: ${activePosition.contracts} ${baseCoin})`,
        );
        return; // 실거래 포지션 진행 중이면 추가 스캔 스킵
      }
    }

    // 0-B. [DRY RUN 모드] 가상 포지션 종료 여부 체크 및 PNL 로깅
    if (!isLive && appState.virtualTrade) {
      const vt = appState.virtualTrade;
      // 최신의 5분봉 불러오기 (현재 가격 확인을 위함)
      const ohlcv5M_latest = await okx.fetchOHLCV(symbol, "5m", undefined, 5);
      if (!ohlcv5M_latest || ohlcv5M_latest.length === 0) return;

      const latestCandle = ohlcv5M_latest[ohlcv5M_latest.length - 1];
      const h = Number(latestCandle[2]);
      const l = Number(latestCandle[3]);
      const c = Number(latestCandle[4]);

      let closed = false;
      let exitPrice = 0;
      let reason = "";

      if (vt.side === "buy") {
        // 롱 포지션
        if (h >= vt.tp) {
          closed = true;
          exitPrice = vt.tp;
          reason = "TP 🎯";
        } else if (l <= vt.sl) {
          closed = true;
          exitPrice = vt.sl;
          reason = "SL 🛑";
        }
      } else {
        // 숏 포지션
        if (l <= vt.tp) {
          closed = true;
          exitPrice = vt.tp;
          reason = "TP 🎯";
        } else if (h >= vt.sl) {
          closed = true;
          exitPrice = vt.sl;
          reason = "SL 🛑";
        }
      }

      if (closed) {
        const durationMin = ((Date.now() - vt.entryTime) / 60000).toFixed(1);

        // PNL 계산 (10배 레버리지 고려)
        let rawPnlPercent = 0; // Gross PNL 비율
        if (vt.side === "buy") {
          rawPnlPercent = (exitPrice / vt.entryPrice - 1) * 10;
        } else {
          rawPnlPercent = ((vt.entryPrice - exitPrice) / vt.entryPrice) * 10;
        }

        const marginUsed = vt.usdtBefore * hybridProportion;
        const positionValue = marginUsed * 10;

        // Net PNL 계산: 순수익 = (마진 * 총수익률) - (포지션규모 * 넷수수료율)
        const netFeeRate = getNetFeeRate();
        const netFeeUSDT = positionValue * netFeeRate;
        const grossPnlUSDT = marginUsed * rawPnlPercent;
        const netPnlUSDT = (grossPnlUSDT - netFeeUSDT).toFixed(4);

        console.log(`\n===========================================`);
        console.log(`[종료] 가상 포지션(${vt.side.toUpperCase()}) 종료!`);
        console.log(`사유: ${reason}`);
        console.log(`Net PNL: ${netPnlUSDT} USDT (수수료 제함)`);
        console.log(`소요 시간: ${durationMin}분`);
        console.log(`===========================================\n`);

        // 매매 일지 작성
        appendHistory({
          time: new Date().toLocaleString(),
          mode: "DRY_RUN",
          side: vt.side.toUpperCase(),
          entryPrice: vt.entryPrice,
          exitPrice: exitPrice,
          durationMinutes: durationMin,
          reason: reason,
          pnlUSDT: Number(netPnlUSDT),
        });

        appState.virtualTrade = null;
        if (!isLive) appState.currentUSDT += Number(netPnlUSDT);
        saveAppState();
      } else {
        // 미실현 수익률 계산 (현재 종가 c 기준, 10배 레버리지)
        let rawUnrealized = 0;
        if (vt.side === "buy") rawUnrealized = (c / vt.entryPrice - 1) * 10;
        else rawUnrealized = ((vt.entryPrice - c) / vt.entryPrice) * 10;

        const unrealizedRoe = (rawUnrealized * 100).toFixed(2);

        // state.json에 실시간 현재가와 수익률 정보 업데이트
        vt.currentPrice = c;
        vt.unrealizedRoe = `${unrealizedRoe}%`;
        saveAppState();

        console.log(
          `🧪 [DRY RUN 포지션 상태] 방향: ${vt.side.toUpperCase()} | 진입가: ${vt.entryPrice} | 현재가: ${c} | 수익률: ${unrealizedRoe}% (TP: ${vt.tp}, SL: ${vt.sl})`,
        );
      }
      return; // 포지션 있으면 추가 타점 안 잡음
    }

    // 포지션이 없다면 타점 스캔 진행
    // 1. 데이터 수집
    const ohlcv1H = await okx.fetchOHLCV(symbol, "1h", undefined, 50);
    const ohlcv15M = await okx.fetchOHLCV(symbol, "15m", undefined, 100);
    const ohlcv5M = await okx.fetchOHLCV(symbol, "5m", undefined, 5);

    if (!ohlcv1H.length || !ohlcv15M.length || !ohlcv5M.length) {
      console.log("⚠️ 데이터를 가져오지 못했습니다. 잠시 후 재시도...");
      return;
    }

    // 2. 지표 분석
    const indicators = getIndicators(ohlcv1H, ohlcv15M, ohlcv5M);
    if (!indicators) return;

    // 3. 전략에 따른 방향 타점 판단 (하이브리드: 횡보/추세)
    const signal = checkHybridStrategy(
      indicators,
      appState.strategyData,
      symbol,
    );
    saveAppState();

    const modeName =
      signal.mode === "BREAKOUT"
        ? "🔥 추세(Breakout) 모드"
        : "✅ 횡보(Reclaim) 모드";
    console.log(
      `[${modeName} | ADX: ${indicators.adx.toFixed(2)}] 현재가: ${indicators.currentPrice5M}`,
    );
    console.log(`[상태] ${signal.reason}`);

    if (signal.shouldEnter) {
      const side = signal.side;
      let rawAmount = calculatePositionSize(
        usdtBalance,
        indicators.currentPrice5M,
        hybridProportion,
      );

      await okx.loadMarkets();
      let amount = Number(okx.amountToPrecision(symbol, rawAmount));
      const minAmount = okx.markets[symbol]?.limits?.amount?.min || 0.01;

      if (amount < minAmount) {
        console.log(
          `⚠️ 계산된 진입 수량(${amount})이 OKX 최소 주문 수량(${minAmount})보다 작습니다!`,
        );
        return;
      }

      // getBracketParams 통과 시 모드 식별자도 넘겨줌 (TP 산정 및 SL 차이 위함)
      const rawParams = getBracketParams(
        side,
        indicators.currentPrice5M,
        indicators.support1H,
        indicators.resistance1H,
        signal.mode,
        symbol,
      );

      const preciseTP = Number(
        okx.priceToPrecision(symbol, rawParams.takeProfit.triggerPrice),
      );
      const preciseSL = Number(
        okx.priceToPrecision(symbol, rawParams.stopLoss.triggerPrice),
      );

      const params = {
        takeProfit: { triggerPrice: preciseTP },
        stopLoss: { triggerPrice: preciseSL },
        marginMode: "isolated",
      };

      const baseCoin = symbol.split("/")[0];
      if (isLive) {
        console.log(
          `🧨 [LIVE] ${side.toUpperCase()} 진입 시도: ${amount} ${baseCoin} (고도화 TP: ${preciseTP}, SL: ${preciseSL})`,
        );
        try {
          await okx.createOrder(
            symbol,
            "market",
            side,
            amount,
            undefined,
            params,
          );
          console.log(
            "✅ [LIVE] 🚀 브라켓 오더와 함께 성공적으로 실거래 진입을 완료했습니다!",
          );
          const entryLog = {
            time: new Date().toLocaleString(),
            symbol: symbol,
            mode: signal.mode,
            side: signal.side.toUpperCase(),
            entryPrice: indicators.currentPrice5M,
            reason: signal.reason,
            // 🔍 복기를 위한 디테일 데이터 추가
            detail: {
              adx: indicators.adx.toFixed(2),
              support: indicators.support1H,
              resistance: indicators.resistance1H,
              touchCount:
                signal.mode === "RECLAIM"
                  ? signal.side === "buy"
                    ? appState.strategyData.supportTouches.length
                    : appState.strategyData.resistanceTouches.length
                  : null,
            },
          };

          appendHistory(entryLog);
        } catch (err) {
          console.error("❌ [LIVE] 진입 중 에러 발생:", err.message);
        }
      } else {
        console.log(
          `🚀 [DRY RUN] ${side.toUpperCase()} 가상 진입 시도: ${amount} ${baseCoin} (가상 TP: ${preciseTP}, SL: ${preciseSL})`,
        );
        // 실제 주문 대신 가상 포지션 기록 (history를 만들기 위함)
        appState.virtualTrade = {
          entryTime: Date.now(),
          mode: signal.mode,
          side: side,
          entryPrice: indicators.currentPrice5M,
          amount: amount,
          tp: preciseTP,
          sl: preciseSL,
          usdtBefore: usdtBalance,
        };
        saveAppState();
        console.log("✅ [DRY RUN] 가상 포지션이 state.json에 기록되었습니다.");
      }
    }
  } catch (error) {
    console.error("❌ 분석 루프 에러:", error.message);
  }
}

async function startBot() {
  console.log(
    `🤖 Support Reclaim 롱/숏 봇 셋업 중... [모드: ${isLive ? "LIVE 🔥 실거래" : "DRY RUN 🧪 가상테스트"}]`,
  );
  await setupExchange(symbol);

  // 상태 로드 및 초기 정보 확인
  loadAppState();
  console.log("📄 state.json 기록을 불러왔습니다.");

  console.log("🔄 15초마다 시장 감시 시작...");
  monitorLoop();
  setInterval(monitorLoop, 15000);
}

startBot();
