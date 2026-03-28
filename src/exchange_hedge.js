import ccxt from "ccxt";
import dotenv from "dotenv";

dotenv.config();

export const okxHedge = new ccxt.okx({
  apiKey: process.env.OKX_HEDGE_API_KEY,
  secret: process.env.OKX_HEDGE_API_SECRET,
  password: process.env.OKX_HEDGE_API_PASSWORD,
  enableRateLimit: true,
  options: {
    defaultType: "swap", // 무기한 선물
  },
});

export async function testHedgeConnection() {
  try {
    const balance = await okxHedge.fetchBalance();
    console.log("✅ OKX Hedge 봇 연결 성공! 잔고 확인 완료.");
    console.log(`현재 USDT 시드: ${balance.total.USDT} 달러`);
  } catch (e) {
    console.error("❌ Hedge 봇 연결 실패:", e.message);
  }
}

export async function setupHedgeExchange(symbol) {
  try {
    await okxHedge.setPositionMode(true).catch(() => {});

    try {
      await okxHedge.setMarginMode("isolated", symbol, { lever: 10 });
      console.log("✅ 마진 모드 변경 성공 (Isolated)");
    } catch (e) {
      console.error(
        "❌ 마진 모드 변경 실패 (포지션이 있으면 실패함):",
        e.message,
      );
    }
    const a = await okxHedge.fetchMarginMode();
    console.log(a);
    // 3. 롱/숏 레버리지 각각 재확인 도장 찍기
    // 파라미터 키를 'marginMode'로 정확히 기입하세요.
    await okxHedge.setLeverage(10, symbol, {
      marginMode: "isolated",
      posSide: "long",
    });
    await okxHedge.setLeverage(10, symbol, {
      marginMode: "isolated",
      posSide: "short",
    });

    // 4. 최종 검증
    const zz = await okxHedge.fetchLeverage(symbol);
    console.log("📊 현재 서버 실제 값:", JSON.stringify(zz.info, null, 2));
    console.log(
      `✅ [${symbol}] Hedge 봇 리스크 관리: 10배 격리 / 양방향 모드 세팅 완료!`,
    );
  } catch (error) {
    console.error("❌ Hedge 봇 마진/레버리지 셋업 실패:", error.message);
  }
}
