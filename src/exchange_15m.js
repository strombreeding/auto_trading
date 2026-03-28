import ccxt from "ccxt";
import dotenv from "dotenv";

dotenv.config();

export const okx15m = new ccxt.okx({
  apiKey: process.env.OKX_15M_API_KEY,
  secret: process.env.OKX_15M_API_SECRET,
  password: process.env.OKX_15M_API_PASSWORD,
  enableRateLimit: true,
  options: {
    defaultType: "swap", // 무기한 선물 거래 세팅
  },
});

export async function testSentryConnection() {
  try {
    const balance = await okx15m.fetchBalance();
    console.log("✅ OKX Sentry 15M 연결 성공! 잔고 확인 완료.");
    console.log(`현재 USDT 시드: ${balance.total.USDT} 달러`);
  } catch (e) {
    console.error("❌ Sentry 15M 연결 실패:", e);
  }
}

export async function setupSentryExchange(symbol) {
  try {
    // 마진 모드를 격리로 설정
    await okx15m.setMarginMode("isolated", symbol).catch((e) => {});
    // 무기한 선물 레버리지 10배 설정
    await okx15m
      .setLeverage(10, symbol, { marginMode: "isolated" })
      .catch((e) =>
        console.log("이미 레버리지가 설정되어 있을 수 있습니다:", e.message),
      );
    console.log(
      `✅ [${symbol}] Sentry 15M 리스크 관리: 10배 격리 모드 레버리지 설정 완료!`,
    );
  } catch (error) {
    console.error("❌ Sentry 15M 마진/레버리지 셋업 실패:", error.message);
  }
}
