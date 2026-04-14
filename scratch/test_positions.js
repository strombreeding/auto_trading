import { okxHedge } from "../src/exchange_hedge_v2.js";

async function run() {
  const positions = await okxHedge.fetchPositions();
  console.log(JSON.stringify(positions, null, 2));
}
run();
