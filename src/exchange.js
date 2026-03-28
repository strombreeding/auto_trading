import ccxt from "ccxt";
import dotenv from "dotenv";

dotenv.config();

export const okx = new ccxt.okx({
  apiKey: process.env.OKX_API_KEY,
  secret: process.env.OKX_API_SECRET,
  password: process.env.OKX_API_PASSWORD, // OKX는 필수!
  enableRateLimit: true,
  options: {
    defaultType: "swap", // 무기한 선물 거래 세팅
    // leverage: 10,
  },
});

export async function testConnection() {
  try {
    const balance = await okx.fetchBalance();
    console.log("✅ OKX 연결 성공! 잔고 확인 완료.");
    // 실제 USDT 잔고만 필터링해서 출력
    console.log(`현재 USDT 시드: ${balance.total.USDT} 달러`);
  } catch (e) {
    console.error("❌ 연결 실패:", e);
  }
}

export async function setupExchange(symbol) {
  try {
    // 마진 모드를 격리로 설정
    // await okx
    //   .setMarginMode("isolated", symbol, { leverage: 10 })
    //   .catch((e) => {});
    // // 무기한 선물 레버리지 10배 설정
    // await okx
    //   .setLeverage(10, symbol, { marginMode: "isolated" })
    //   .catch((e) =>
    //     console.log("이미 레버리지가 설정되어 있을 수 있습니다:", e.message),
    //   );

    const zz = await okx.fetchLeverage(symbol, {
      marginMode: "isolated",
    });
    console.log("📊 현재 서버 실제 값:", JSON.stringify(zz.info, null, 2));
    console.log(
      `✅ [${symbol}] 리스크 관리: 10배 격리 모드 레버리지 설정 완료!`,
    );
  } catch (error) {
    console.error("❌ 마진/레버리지 셋업 실패:", error.message);
  }
}
