# Sentry 15M Bot Implementation Plan

This plan details the implementation of a new trading strategy (`strategy_sentry_15m`) designed to operate alongside the existing OKX bot.

## Proposed Changes

### [src/exchange.js](file:///c:/Users/speak/OneDrive/%EB%B0%94%ED%83%95%20%ED%99%94%EB%A9%B4/be-rich/src/exchange.js)
Add a new OKX instance for the Sentry bot using the `OKX_15M_` API keys.
#### [MODIFY] [exchange.js](file:///c:/Users/speak/OneDrive/%EB%B0%94%ED%83%95%20%ED%99%94%EB%A9%B4/be-rich/src/exchange.js)
- Export a new `okxSentry` instance authenticated with `OKX_15M_API_KEY`, etc.
- Export `setupSentryExchange(symbol)` to initialize the 10x isolated leverage for this account.

---
### `src/analyzer_sentry.js`
A new file specifically for extracting 15M timeframe indicators.
#### [NEW] [analyzer_sentry.js](file:///c:/Users/speak/OneDrive/%EB%B0%94%ED%83%95%20%ED%99%94%EB%A9%B4/be-rich/src/analyzer_sentry.js)
- **15M Fractal S/R**: Calculate support and resistance based on the last 5 candles.
- **Bollinger Bands (20, 2)**: Calculate Upper, Mid (SMA 20), and Lower bands.
- **ADX (14)**: Calculate the latest ADX value to distinguish between trend (>=25) and ranging (<25) markets.

---
### `src/strategy_sentry.js`
A new file containing the core strategy rules.
#### [NEW] [strategy_sentry.js](file:///c:/Users/speak/OneDrive/%EB%B0%94%ED%83%95%20%ED%99%94%EB%A9%B4/be-rich/src/strategy_sentry.js)
- **Position Sizing**: Calculate 30% of the USDT balance (`marginSizePercent = 0.30`).
- **Fees**: Use [getNetFeeRate()](file:///c:/Users/speak/OneDrive/%EB%B0%94%ED%83%95%20%ED%99%94%EB%A9%B4/be-rich/src/strategy.js#138-144) assuming 65% payback.
- **Entry Logic**:
  - *Long Reversion*: Price touches/drops below Lower BB and closes inside.
  - *Long Trend*: ADX >= 25 AND closes > 15M Resistance + 0.2%.
  - *Short Reversion*: Price touches/rises above Upper BB and closes inside.
  - *Short Trend*: ADX >= 25 AND closes < 15M Support - 0.2%.
- **Exit Logic (Bracket Params)**:
  - *TP Reversion*: Target = BB Mid (SMA 20).
  - *TP Trend*: Target = Net Profit 0.6%.
  - *SL*: -1% from the entry price.

---
### `src/index_sentry.js`
The main execution loop for the Sentry bot, decoupled from the main bot.
#### [NEW] [index_sentry.js](file:///c:/Users/speak/OneDrive/%EB%B0%94%ED%83%95%20%ED%99%94%EB%A9%B4/be-rich/src/index_sentry.js)
- Reads the `--live` flag for LIVE or DRY RUN mode.
- Uses `state_sentry.json` and `history_sentry.json` to prevent collisions with the existing bot.
- Fetches 15M OHLCV data using `okxSentry` and processes the logic every 15 seconds.

---
### [src/index.js](file:///c:/Users/speak/OneDrive/%EB%B0%94%ED%83%95%20%ED%99%94%EB%A9%B4/be-rich/src/index.js)
Update the existing bot's entry point to kick off the new bot concurrently.
#### [MODIFY] [index.js](file:///c:/Users/speak/OneDrive/%EB%B0%94%ED%83%95%20%ED%99%94%EB%A9%B4/be-rich/src/index.js)
- Import `./index_sentry.js` to initialize the Sentry bot's `setInterval` loop within the same Node.js process without blocking the existing bot.

## Verification Plan

### Automated Tests
- Since this project does not appear to have an existing unit test framework, we will rely on dry-run verification.

### Manual Verification
- Run `npm run start` (DRY RUN mode) and verify the console outputs for both bots simultaneously.
- Check that `state.json` and `state_sentry.json` update independently without overriding each other.
- Run `npm run live` momentarily to verify that API connection for both standard and 15M accounts (`okx` and `okxSentry`) succeeds without "invalid api key" errors.
