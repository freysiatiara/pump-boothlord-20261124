// Pump.fun Paper Sprint — momentum breakout bot (fresh strategy, written for this entry).
//
// Idea: on a 6-hour replay of fresh pump.fun curves, most coins die flat and a few run.
// This bot watches every curve from the moment it first appears, records its first-seen
// price and its low since then, and buys a small fixed stake when the price breaks out:
//   +8% above the first-seen price AND +15% above the low since first seen,
//   while not already up more than +60% from first seen (do not chase the top).
// It needs at least 4 recorded trades so the breakout is real tape, not one print.
//
// Exits (all measured on position value vs cost, fees included in cost):
//   take profit at +30%, stop loss at -15%, trailing stop -12% from the peak once the
//   position has been up +10%, or a time stop after MAX_HOLD_SLOTS slots held.
// A sold coin rests for COOLDOWN_SLOTS and may be bought at most twice per run.
//
// Rotation is the point: stakes are small (0.10 SOL) and at most 5 positions are open,
// so the bot keeps cycling through fresh breakouts. The guardrail needs round trips of
// at least 0.01 SOL on 20 distinct mints; every buy here is >= 0.01 SOL by construction
// (the size cap must clear MIN_BUY_LAMPORTS first), and the time stop forces turnover.
//
// Fully deterministic: every decision comes from the batch stream only (insertion-ordered
// maps, bigint price comparisons by cross-multiplication, no clock, no environment,
// no Math.random). Diagnostics go to stderr; stdout carries replies only.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type Pubkey,
  type SellInput,
} from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- parameters

/** SOL per buy (0.10 SOL). */
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 10n;
/** Smallest buy worth sending; also the guardrail's minimum round-trip buy. */
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n;
/** Breakout: price >= first-seen price * (1 + 8%). */
const ENTRY_UP_FIRST_BPS = 800;
/** Breakout: price >= low-since-seen * (1 + 15%). */
const ENTRY_UP_LOW_BPS = 1500;
/** Do not chase: price must stay <= first-seen price * (1 + 60%). */
const ENTRY_MAX_UP_BPS = 6000;
/** Recorded trades on the curve before it can be bought. */
const MIN_TRADES = 4;
/** Take profit: position value >= cost * 1.30. */
const TAKE_PROFIT_BPS = 13_000;
/** Stop loss: position value <= cost * 0.85. */
const STOP_LOSS_BPS = 8500;
/** Trailing stop arms once value >= cost * 1.10, then sells at value <= peak * 0.88. */
const TRAIL_ARM_BPS = 11_000;
const TRAIL_BPS = 8800;
/** Time stop: sell after this many slots held. */
const MAX_HOLD_SLOTS = 12_000;
/** Rest after an exit before the same mint may be bought again. */
const COOLDOWN_SLOTS = 2000;
/** Most buys per mint over the run. */
const MAX_ENTRIES_PER_MINT = 2;
/** Slippage allowances (bps). Buys wide open so a fill is never refused for latency. */
const BUY_SLIPPAGE_BPS = 10_000;
const SELL_SLIPPAGE_BPS = 5000;

// ---------------------------------------------------------------- bigint price helpers
//
// A price is virtual_quote_reserves / virtual_token_reserves (SOL per token).
// Compare prices a/b vs c/d by cross-multiplication: a*d ? c*b. All comparisons below
// are exact bigint arithmetic, so two runs of the same stream agree bit for bit.

/** price(vqA, vtA) >= price(vqB, vtB) * (10000 + bps) / 10000 ? */
function priceGteByBps(
  vqA: bigint, vtA: bigint,
  vqB: bigint, vtB: bigint,
  bps: number,
): boolean {
  return vqA * vtB * 10_000n >= vqB * vtA * BigInt(10_000 + bps);
}

/** price(vqA, vtA) <= price(vqB, vtB) * (10000 + bps) / 10000 ? */
function priceLteByBps(
  vqA: bigint, vtA: bigint,
  vqB: bigint, vtB: bigint,
  bps: number,
): boolean {
  return vqA * vtB * 10_000n <= vqB * vtA * BigInt(10_000 + bps);
}

/** price(vqA, vtA) < price(vqB, vtB) ? */
function priceLt(vqA: bigint, vtA: bigint, vqB: bigint, vtB: bigint): boolean {
  return vqA * vtB < vqB * vtA;
}

/** Current SOL value of `tokens` at reserves (vq, vt), rounded down. */
function valueLamports(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (vt === 0n) return 0n;
  return (tokens * vq) / vt;
}

// ---------------------------------------------------------------- per-mint state

interface MintTrack {
  firstVq: bigint;
  firstVt: bigint;
  lowVq: bigint;
  lowVt: bigint;
  trades: number;
  createdSlot: number | null;
  entries: number;
  cooldownUntil: number;
}

interface Held {
  entrySlot: number;
  peakValue: bigint;
}

const tracks = new Map<Pubkey, MintTrack>();
const held = new Map<Pubkey, Held>();
/** client_id -> mint for buys still in flight, so a mint is never double-bought. */
const buyInFlight = new Map<string, Pubkey>();
/** Mints with a buy sent and not yet resolved. */
const buyPendingMints = new Set<Pubkey>();

let buysSent = 0;
let sellsSent = 0;
let buysFilled = 0;
let sellsFilled = 0;
const roundTripped = new Set<Pubkey>();

function trackFor(mint: Pubkey, vq: bigint, vt: bigint, slot: number): MintTrack {
  let t = tracks.get(mint);
  if (t === undefined) {
    t = {
      firstVq: vq, firstVt: vt,
      lowVq: vq, lowVt: vt,
      trades: 0, createdSlot: null,
      entries: 0, cooldownUntil: 0,
    };
    tracks.set(mint, t);
  }
  return t;
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  const slot = state.slot;
  const caps = state.hello.caps;
  const tx = state.txFeeLamports();

  // --- fold this batch's fills: resolve in-flight buys, count round trips --------
  for (const f of batch.fills) {
    const mint = buyInFlight.get(f.client_id);
    if (mint !== undefined) {
      buyInFlight.delete(f.client_id);
      buyPendingMints.delete(mint);
      if (f.status === 'filled' && f.side === 'buy') buysFilled += 1;
    }
    if (f.status === 'filled' && f.side === 'sell') {
      sellsFilled += 1;
      roundTripped.add(f.mint);
    }
  }

  // --- reconcile held positions: exits, completes and flattens drop out ---------
  for (const mint of [...held.keys()]) {
    if (!state.positions.has(mint)) {
      held.delete(mint);
      const t = tracks.get(mint);
      if (t !== undefined) t.cooldownUntil = slot + COOLDOWN_SLOTS;
    }
  }

  // --- update per-mint tape from this batch's events ------------------------------
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      const t = trackFor(
        e.mint,
        BigInt(e.virtual_quote_reserves),
        BigInt(e.virtual_token_reserves),
        e.slot,
      );
      if (t.createdSlot === null) t.createdSlot = e.slot;
    } else if (e.event === 'TradeEvent') {
      const vq = BigInt(e.virtual_quote_reserves);
      const vt = BigInt(e.virtual_token_reserves);
      const t = trackFor(e.mint, vq, vt, e.slot);
      t.trades += 1;
      if (priceLt(vq, vt, t.lowVq, t.lowVt)) {
        t.lowVq = vq;
        t.lowVt = vt;
      }
    }
    // CompleteEvent: nothing to track; state.curves already marks it complete.
  }

  // --- exits for open positions --------------------------------------------------
  let free = state.freeCashLamports();
  for (const [mint, pos] of state.positions) {
    const curve = state.curves.get(mint);
    if (curve === undefined) continue;
    let h = held.get(mint);
    if (h === undefined) {
      h = { entrySlot: slot, peakValue: 0n };
      held.set(mint, h);
    }
    const value = valueLamports(
      pos.token_amount,
      curve.virtual_quote_reserves,
      curve.virtual_token_reserves,
    );
    if (value > h.peakValue) h.peakValue = value;
    const cost = pos.cost_lamports;
    const takeProfit = value * 10_000n >= cost * BigInt(TAKE_PROFIT_BPS);
    const stopLoss = value * 10_000n <= cost * BigInt(STOP_LOSS_BPS);
    const trailing =
      h.peakValue * 10_000n >= cost * BigInt(TRAIL_ARM_BPS) &&
      value * 10_000n <= h.peakValue * BigInt(TRAIL_BPS);
    const timeStop = slot - h.entrySlot >= MAX_HOLD_SLOTS;
    if (takeProfit || stopLoss || trailing || timeStop) {
      if (orders.length >= caps.max_orders_per_batch) continue;
      const sell: SellInput = {
        side: 'sell',
        mint,
        token_amount: pos.token_amount,
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      };
      orders.push(sell);
      sellsSent += 1;
      free -= tx;
    }
  }

  // --- entries: breakouts seen in this batch's events -----------------------------
  let openSlots = caps.max_open_positions - state.committedPositionCount();
  for (const e of batch.events) {
    if (orders.length >= caps.max_orders_per_batch) break;
    if (openSlots <= 0) break;
    if (e.event !== 'TradeEvent' && e.event !== 'CreateEvent') continue;
    const mint = e.mint;
    if (state.positions.has(mint) || buyPendingMints.has(mint)) continue;
    const t = tracks.get(mint);
    const curve = state.curves.get(mint);
    if (t === undefined || curve === undefined || curve.complete) continue;
    if (t.trades < MIN_TRADES) continue;
    if (t.entries >= MAX_ENTRIES_PER_MINT) continue;
    if (slot < t.cooldownUntil) continue;
    const vq = curve.virtual_quote_reserves;
    const vt = curve.virtual_token_reserves;
    if (vt === 0n) continue;
    // Breakout: up 8% from first seen, up 15% from the low, not up more than 60%.
    if (!priceGteByBps(vq, vt, t.firstVq, t.firstVt, ENTRY_UP_FIRST_BPS)) continue;
    if (!priceGteByBps(vq, vt, t.lowVq, t.lowVt, ENTRY_UP_LOW_BPS)) continue;
    if (!priceLteByBps(vq, vt, t.firstVq, t.firstVt, ENTRY_MAX_UP_BPS)) continue;
    // Size: the per-reply cap (1% of real reserve) must clear the guardrail minimum.
    const cap = state.maxBuyLamports(mint);
    if (cap < MIN_BUY_LAMPORTS) continue;
    const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
    if (free < amount + tx) continue;
    const clientId = state.clientId();
    const buy: BuyInput = {
      side: 'buy',
      mint,
      quote_lamports: amount,
      max_slippage_bps: BUY_SLIPPAGE_BPS,
      client_id: clientId,
    };
    orders.push(buy);
    buyInFlight.set(clientId, mint);
    buyPendingMints.add(mint);
    t.entries += 1;
    buysSent += 1;
    free -= amount + tx;
    openSlots -= 1;
  }

  return orders;
}

await runBot({
  onHello(state) {
    console.error(
      `hello: seed=${state.hello.seed} capital=${state.hello.capital.lamports} ` +
        `maxOpen=${state.hello.caps.max_open_positions}`,
    );
  },
  onBatch,
  onDone(state) {
    console.error(
      `done: batches=${state.seq} cash=${state.cash} buysSent=${buysSent} ` +
        `buysFilled=${buysFilled} sellsSent=${sellsSent} sellsFilled=${sellsFilled} ` +
        `roundTrippedMints=${roundTripped.size} trackedMints=${tracks.size}`,
    );
  },
});
