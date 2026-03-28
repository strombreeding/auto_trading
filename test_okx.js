import ccxt from "ccxt";

async function main() {
  const okx = new ccxt.okx();
  await okx.loadMarkets();
  const market = okx.markets["BTC/USDT:USDT"];
  console.log("contractSize:", market.contractSize);
  console.log("min amount:", market.limits.amount.min);
  console.log("precision amount:", market.precision.amount);
}

main().catch(console.error);
