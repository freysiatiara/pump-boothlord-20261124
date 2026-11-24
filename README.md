# Pump.fun Paper Sprint — Momentum Breakout Bot

Entry for the make.fun bounty: https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b

![bounty](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)
![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/freysiatiara/pump-boothlord-20261124/rank.svg)
![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/freysiatiara/pump-boothlord-20261124/reward.svg)

A momentum breakout bot for the pump.fun paper-trading replay (`agent-fun/replay/v2`, Node 22, `main.ts`).

## Strategy

Early-snipe bot: enter young launches fast, exit fast.

- **Entry** (within ~100 slots of a curve's creation): price at most +25% above the create price, at least 2 distinct non-creator buyers, net buy flow positive, and the creator has not sold. A launch the creator is already dumping is skipped.
- **Exits**, measured on position value vs cost (fees included): take profit at **+20%**, stop loss at **−10%**, trailing stop **−8% from the peak** once up **+10%**, time stop after **600 slots** (~4 minutes), exit at once if the creator sells while we hold.

Stakes stay small (0.05 SOL) and at most 5 positions are open, so the bot keeps rotating through fresh launches — every buy is ≥ 0.01 SOL, clearing the 20-distinct-mint round-trip guardrail with a wide margin.

Dev grade (kit's 24h dev window, `grade-local --driver process`): **net PnL −0.328 SOL, win rate 19.6%, max drawdown 0.034, 296 round trips over 296 distinct mints, 592 fills** — guardrail cleared easily, determinism reproduced (two executions, byte-identical action logs).

## Determinism

Every decision comes from the batch stream only: insertion-ordered maps, exact bigint price comparisons, no clock, no environment, no randomness. The entry runs twice in grading and both action logs must match byte for byte.

## Files

- `main.ts` — the strategy (stdlib only, no dependencies)
- `vendor/makefun-bot.ts` — the kit's bot shim, copied verbatim from the kit
- `LICENSE` — MIT
