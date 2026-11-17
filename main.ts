// Dip-and-rally hybrid for cbBTC 1-minute bars (agent-fun/bars-replay/v1).
//
// One asset, one position, long only, $1,000 of paper money. A round trip
// costs roughly 35 bps on this pool (4 bps fee + 2 bps slippage + ~11 bps
// of price impact per leg at dev-window depth), so the bot trades rarely
// and only when a move can pay for itself. It switches between two
// engines by the market's own 4-hour return, because the two 24-hour
// windows on record behave in opposite ways: one fell 400 bps in a day,
// the other chopped sideways in a 250 bps range.
//
// Regime (recomputed every bar from closes alone):
//   R240 = the close's return over the previous 240 bars, in bps.
//   R240 < -100  -> downtrend: ride relief rallies (breakout engine).
//   otherwise    -> range / up: fade deep dips (mean-reversion engine).
//
// Mean-reversion engine (range regime):
//   - Buy 100% of cash when the close sits at least 70 bps below the
//     mean of the previous 60 closes (a 1-hour mean), after a 5-bar
//     cooldown following any exit. The order fills at the next bar's open.
//   - Exit the whole position at +150 bps over the fill price, or at
//     -150 bps under it (a failed dip keeps falling), whichever comes
//     first; an 8% equity guard flattens everything as a backstop.
//   - No trailing stop here on purpose: the legs this catches pull back
//     50-80 bps inside their rise, so a tight trail exits early and the
//     re-entry that follows buys the same dip again at a loss.
//
// Breakout engine (downtrend regime):
//   - Buy 100% of cash when the close breaks to at least the highest high
//     of the previous 60 bars (a 1-hour Donchian breakout), after the same
//     5-bar cooldown. In a falling market these breakouts are relief
//     rallies, so the bot rides them and cuts them fast.
//   - Exit the whole position at +300 bps over the fill price, or on a
//     trailing stop 50 bps below the best close since the fill, or when
//     the position is 120 bars old without either firing; the same 8%
//     equity guard applies.
//
// Everything is deterministic: signals come only from the bars in each
// batch and the fills the harness reports, prices are compared in integer
// basis points (BigInt, floored division), and there is no clock, no
// randomness, no network and no I/O besides the protocol lines. Two runs
// on the same bars therefore produce the same orders.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- shared ---------------------------------------------------------------

// Bars to wait after an exit before a fresh entry.
const COOLDOWN_BARS = 5;
// Flatten everything if equity falls this far (bps) from its peak.
const EQUITY_GUARD_BPS = 800n;
// Slippage cap on every order, in bps from the latest close.
const MAX_SLIPPAGE_BPS = 100;
// The regime line: a 240-bar return below this (bps) means downtrend.
const DOWNTREND_BPS = -100n;

// --- mean-reversion engine ------------------------------------------------

// Bars defining the dip reference (one hour of 1-minute bars).
const MR_LOOKBACK_BARS = 60;
// How far (bps) below that mean the close must sit to buy the dip.
const MR_ENTRY_BPS = 70n;
// Take profit / stop loss, in bps from the fill price.
const MR_TAKE_PROFIT_BPS = 150n;
const MR_STOP_BPS = 150n;

// --- breakout engine ------------------------------------------------------

// How many prior bars define the breakout high (one hour).
const BO_LOOKBACK_BARS = 60;
// Take profit, in bps above the fill price.
const BO_TAKE_PROFIT_BPS = 300n;
// Trailing stop, in bps below the best close since the fill.
const BO_TRAIL_BPS = 50n;
// Give up on a breakout after this many bars without an exit.
const BO_MAX_HOLD_BARS = 120;

// --- state ----------------------------------------------------------------

// Closes and highs of every bar seen so far, oldest first. Only the last
// 240 closes and the last 60 highs are ever read, so the arrays are
// trimmed as they grow.
const closes: bigint[] = [];
const highs: bigint[] = [];

// Which engine opened the open position ('mr' | 'bo' | null), its fill
// price (raw price units, as in bar.c), the best close since the fill,
// the batch seq of the fill, and the batch seq of the last exit fill. All
// of these are set from the harness's own fills, never guessed from an
// order we sent.
let entryMode: 'mr' | 'bo' | null = null;
let fillPrice: bigint | null = null;
let bestClose: bigint | null = null;
let fillSeq = -1;
let lastExitSeq = -1_000_000;

// The mode of the buy order currently awaiting its fill report.
let pendingMode: 'mr' | 'bo' | null = null;

// Highest equity seen (micro-USDC), for the equity guard.
let peakEquity = 1_000_000_000n;

/** Floored integer division (BigInt's `/` truncates toward zero). */
function divFloor(a: bigint, b: bigint): bigint {
  if (b < 0n) return divFloor(-a, -b);
  if (a >= 0n) return a / b;
  return -((-a + b - 1n) / b);
}

/** Basis points of `value` against `base`: (value - base) * 10000 / base. */
function bpsDiff(value: bigint, base: bigint): bigint {
  return divFloor((value - base) * 10_000n, base);
}

/** Mean of the last `n` closes, or null before that many bars exist. */
function meanClose(n: number): bigint | null {
  if (closes.length < n) return null;
  let sum = 0n;
  for (let i = closes.length - n; i < closes.length; i++) sum += closes[i]!;
  return sum / BigInt(n);
}

/** Highest high of the last `n` bars, or null before that many exist. */
function topHigh(n: number): bigint | null {
  if (highs.length < n) return null;
  let top = -1n;
  for (let i = highs.length - n; i < highs.length; i++) {
    if (highs[i]! > top) top = highs[i]!;
  }
  return top;
}

// Record this batch's close and high after deciding, so every signal
// compares against earlier bars alone.
function recordBar(batch: Batch): void {
  for (const b of batch.bars) {
    if (b.symbol !== SYMBOL) continue;
    closes.push(BigInt(b.c));
    highs.push(BigInt(b.h));
    if (closes.length > 240) closes.splice(0, closes.length - 240);
    if (highs.length > 60) highs.splice(0, highs.length - 60);
  }
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    // Learn what filled on the previous bar before deciding anything.
    // A fill is reported in the batch whose bar it filled at, so the
    // reporting batch's seq is the fill bar's seq.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        fillPrice = BigInt(fill.price);
        bestClose = fillPrice;
        fillSeq = batch.seq;
        entryMode = pendingMode;
        pendingMode = null;
      } else if (fill.side === 'sell') {
        fillPrice = null;
        bestClose = null;
        fillSeq = -1;
        entryMode = null;
        pendingMode = null;
        lastExitSeq = batch.seq;
      }
    }

    if (state.equity > peakEquity) peakEquity = state.equity;
    if (state.warmingUp) {
      recordBar(batch);
      return [];
    }

    // Decide only on this batch's own fresh bar. A batch with no CBBTC
    // bar (a gap minute) carries no new price: deciding on state.latest
    // would re-decide on a stale close and could send a second buy while
    // the first is still unfilled, so a gap batch sends nothing.
    let bar: (typeof batch.bars)[number] | undefined;
    for (const b of batch.bars) {
      if (b.symbol === SYMBOL) {
        bar = b;
        break;
      }
    }
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    const held = state.positions.get(SYMBOL);
    const orders: (BuyInput | SellInput)[] = [];

    // The 240-bar return decides the regime: a close 241 bars back is
    // the earliest close still kept, so this is exact.
    const r240 = closes.length > 240 ? bpsDiff(close, closes[closes.length - 241]!) : null;
    const downtrend = r240 !== null && r240 < DOWNTREND_BPS;

    if (held !== undefined && held.qty > 0n) {
      if (fillPrice === null) {
        recordBar(batch);
        return []; // fill not reported yet; wait a bar
      }
      if (close > bestClose!) bestClose = close;
      const gainBps = bpsDiff(close, fillPrice);
      const lossBps = bpsDiff(fillPrice, close);
      const trailBps = divFloor((bestClose! - close) * 10_000n, bestClose!);
      const ageBars = batch.seq - fillSeq;
      const drawdownBps = divFloor((peakEquity - state.equity) * 10_000n, peakEquity);
      const guard = drawdownBps >= EQUITY_GUARD_BPS;
      let exit = guard;
      if (entryMode === 'mr') {
        exit = exit || gainBps >= MR_TAKE_PROFIT_BPS || lossBps >= MR_STOP_BPS;
      } else {
        exit =
          exit ||
          gainBps >= BO_TAKE_PROFIT_BPS ||
          trailBps >= BO_TRAIL_BPS ||
          ageBars >= BO_MAX_HOLD_BARS;
      }
      if (exit) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
      recordBar(batch);
      return orders;
    }

    // Flat: one engine or the other opens a position, after the cooldown.
    if (batch.seq - lastExitSeq < COOLDOWN_BARS) {
      recordBar(batch);
      return [];
    }
    const cash = state.cash;
    if (cash < BigInt(state.hello.fees.min_notional_quote_units)) {
      recordBar(batch);
      return [];
    }
    if (downtrend) {
      const top = topHigh(BO_LOOKBACK_BARS);
      recordBar(batch);
      if (top === null || close < top) return [];
      pendingMode = 'bo';
      orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS });
      return orders;
    }
    const mean = meanClose(MR_LOOKBACK_BARS);
    recordBar(batch);
    if (mean === null) return [];
    if (bpsDiff(mean, close) < MR_ENTRY_BPS) return [];
    pendingMode = 'mr';
    orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS });
    return orders;
  },
});
