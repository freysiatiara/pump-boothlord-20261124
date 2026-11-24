// Pump.fun Paper Sprint — early-snipe bot, v2 (fresh strategy, written for this entry).
//
// v1 lesson (dev grade -2.25 SOL, win rate 21.8%): buying a +8% breakout and holding up
// to 12,000 slots mostly buys the top of a move that then reverts, while the +30% take
// profit caps the few real runners (the biggest v1 win, +0.163 SOL, was a position that
// rode to completion past the cap). v2 flips both sides:
//   - ENTER EARLY: within ~100 slots of a curve's creation, before the move has run far
//     (price at most +25% above the create price), and only when the opening tape looks
//     genuine: at least 2 distinct non-creator buyers, net buy flow positive, and the
//     creator has not sold anything. A launch the creator is already dumping is skipped.
//   - EXIT: stop loss -15%, trailing stop -25% from the peak once up +50%, or a time
//     stop after 20,000 slots (~2.2 hours). There is deliberately NO fixed take profit:
//     capping winners at +20-35% threw away the fat tail that pays for the losers (v1's
//     best win, +0.163 SOL, was a position that rode to completion). Losers are cut
//     before they bleed for hours; the creator selling while we hold exits at once.
// Stakes stay small (0.05 SOL) and at most 5 positions are open, so the bot cycles
// through many fresh launches; every buy is >= 0.01 SOL, clearing the 20-distinct-mint
// round-trip guardrail.
//
// Fully deterministic: every decision comes from the batch stream only (insertion-ordered
// maps, exact bigint price comparisons, no clock, no environment, no Math.random).
// Diagnostics go to stderr; stdout carries replies only.

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

/** SOL per buy (0.05 SOL). */
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n;
/** Smallest buy worth sending; also the guardrail's minimum round-trip buy. */
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n;
/** Oldest age (slots since creation) at which a first buy may still be decided. */
const MAX_ENTRY_AGE_SLOTS = 100;
/** Entry: price at most +20% above the create price. */
const MAX_RUNUP_BPS = 2000;
/** Entry: at least this many distinct non-creator buyers seen. */
const MIN_BUYERS = 3;
/** Entry: net buy flow on the observed tape must clear this (lamports). */
const MIN_NET_BUY_LAMPORTS = 100_000_000n;
/** Entry: at least this many recorded trades. */
const MIN_TRADES = 3;
/** Entry: curve must hold at least this much real SOL. */
const MIN_REAL_SOL_LAMPORTS = 300_000_000n;
/** Take profit: effectively off (+1000%) — runners are left to run to completion and
    are harvested by the trailing stop instead; capping winners at +20-35% threw away
    the fat tail that pays for the losers (v1's best win, +0.163 SOL, rode to completion). */
const TAKE_PROFIT_BPS = 1_000_000;
/** Stop loss: position value <= cost * 0.85. */
const STOP_LOSS_BPS = 8500;
/** Trailing stop arms once value >= cost * 1.50, then sells at value <= peak * 0.75. */
const TRAIL_ARM_BPS = 15_000;
const TRAIL_BPS = 7500;
/** Time stop: sell after this many slots held. */
const MAX_HOLD_SLOTS = 20_000;
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

/** price(vqA, vtA) <= price(vqB, vtB) * (10000 + bps) / 10000 ? */
function priceLteByBps(
  vqA: bigint, vtA: bigint,
  vqB: bigint, vtB: bigint,
  bps: number,
): boolean {
  return vqA * vtB * 10_000n <= vqB * vtA * BigInt(10_000 + bps);
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
  creator: Pubkey | null;
  createdSlot: number | null;
  trades: number;
  /** Distinct non-creator wallets that bought. */
  buyers: Set<Pubkey>;
  /** SOL bought minus SOL sold on the observed tape (lamports, signed). */
  netBuyLamports: bigint;
  /** The creator sold at least once. */
  creatorSold: boolean;
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

function trackFor(mint: Pubkey, vq: bigint, vt: bigint): MintTrack {
  let t = tracks.get(mint);
  if (t === undefined) {
    t = {
      firstVq: vq, firstVt: vt,
      creator: null, createdSlot: null,
      trades: 0, buyers: new Set<Pubkey>(),
      netBuyLamports: 0n, creatorSold: false,
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
      );
      if (t.createdSlot === null) t.createdSlot = e.slot;
      if (t.creator === null) t.creator = e.creator;
    } else if (e.event === 'TradeEvent') {
      const vq = BigInt(e.virtual_quote_reserves);
      const vt = BigInt(e.virtual_token_reserves);
      const t = trackFor(e.mint, vq, vt);
      t.trades += 1;
      const sol = BigInt(e.sol_amount);
      if (e.is_buy) {
        t.netBuyLamports += sol;
        if (t.creator === null || e.user !== t.creator) t.buyers.add(e.user);
      } else {
        t.netBuyLamports -= sol;
        if (t.creator !== null && e.user === t.creator) t.creatorSold = true;
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
    const track = tracks.get(mint);
    const creatorDumped = track !== undefined && track.creatorSold;
    if (takeProfit || stopLoss || trailing || timeStop || creatorDumped) {
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

  // --- entries: young launches with a genuine-looking opening tape ----------------
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
    if (t.createdSlot === null) continue;
    if (slot - t.createdSlot > MAX_ENTRY_AGE_SLOTS) continue;
    if (t.trades < MIN_TRADES) continue;
    if (t.buyers.size < MIN_BUYERS) continue;
    if (t.creatorSold) continue;
    if (t.netBuyLamports < MIN_NET_BUY_LAMPORTS) continue;
    if (t.entries >= MAX_ENTRIES_PER_MINT) continue;
    if (slot < t.cooldownUntil) continue;
    if (curve.real_quote_reserves < MIN_REAL_SOL_LAMPORTS) continue;
    const vq = curve.virtual_quote_reserves;
    const vt = curve.virtual_token_reserves;
    if (vt === 0n) continue;
    // Do not chase: price at most +25% above the create price.
    if (!priceLteByBps(vq, vt, t.firstVq, t.firstVt, MAX_RUNUP_BPS)) continue;
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
