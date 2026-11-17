# BTC Race 24h — Dip-and-Rally Hybrid

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/jhonrudi12/btc-race-24h-20261117-0603/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/jhonrudi12/btc-race-24h-20261117-0603/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A bot for [Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261117-0603)
(`btc-race-24h-20261117-0603`): it trades cbBTC/USDC on 1-minute bars with
$1,000 of paper money, long only, one position at a time.

## Strategy

A round trip costs roughly 35 bps on this pool (4 bps fee + 2 bps slippage
+ ~11 bps of price impact per leg at dev-window depth), so the bot trades
rarely and only when a move can pay for itself. It switches between two
engines by the market's own 4-hour return, because the two 24-hour windows
on record behave in opposite ways: one fell 400 bps in a day, the other
chopped sideways in a 250 bps range.

- **Regime.** R240 = the close's return over the previous 240 bars. Below
  −100 bps the market is in a downtrend and the breakout engine runs;
  otherwise the mean-reversion engine runs.
- **Mean-reversion engine (range/up).** Buy 100% of cash when the close
  sits at least 70 bps below the mean of the previous 60 closes, after a
  5-bar cooldown following any exit. Exit the whole position at +150 bps
  over the fill price, or at −150 bps under it; an 8% equity guard
  flattens everything as a backstop. No trailing stop here on purpose:
  the legs this catches pull back 50–80 bps inside their rise, so a
  tight trail exits early and the re-entry that follows buys the same
  dip again at a loss.
- **Breakout engine (downtrend).** Buy 100% of cash when the close
  breaks to at least the highest high of the previous 60 bars (a 1-hour
  Donchian breakout), after the same 5-bar cooldown. In a falling market
  these breakouts are relief rallies, so the bot rides them and cuts
  them fast: exit at +300 bps over the fill, on a trailing stop 50 bps
  below the best close since the fill, or when the position is 120 bars
  old; the same 8% equity guard applies.
- **Otherwise flat in cash.** In a downtrend with no breakout, or in a
  range with no deep dip, the bot simply does not trade.

On the dev window this design catches the window's two big recovery legs
with the dip engine (+26.14 USDC, 4 trades, 0.75% max drawdown). The same
parameters on the previous competition's window — a 400 bps down day —
make +7.60 USDC (9 trades, 2.90% max drawdown), so the design survives
both regimes instead of being tuned to one. It is fully deterministic:
no clock, no randomness, no network, no files — signals come only from
the bars and fills in each batch, compared in integer basis points.

## Files

- `main.ts` — the bot (Node 22, `agent-fun/bars-replay/v1`)
- `vendor/makefun-bars.ts` — byte-for-byte copy of the kit's protocol shim
- `README.md`, `LICENSE` (MIT)
