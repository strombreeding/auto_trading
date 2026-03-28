import ccxt from "ccxt";
import fs from "fs";

async function run() {
  try {
    const okx = new ccxt.okx();
    await okx.loadMarkets();
    const btc = okx.markets["BTC/USDT:USDT"];
    const sol = okx.markets["SOL/USDT:USDT"];
    
    let res = "";
    res += `BTC: min=${btc.limits.amount.min}, precision=${btc.precision.amount}, contract=${btc.contractSize}\n`;
    res += `SOL: min=${sol.limits.amount.min}, precision=${sol.precision.amount}, contract=${sol.contractSize}\n`;

    fs.writeFileSync("output_ccxt.txt", res);
  } catch(e) {
    fs.writeFileSync("output_ccxt.txt", e.message);
  }
}
run();
