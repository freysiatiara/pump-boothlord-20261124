# Pump.fun Paper Sprint — Momentum Breakout Bot

Entry for the make.fun bounty: https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b

![bounty](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)
![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/freysiatiara/pump-boothlord-20261124/rank.svg)
![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/freysiatiara/pump-boothlord-20261124/reward.svg)

A momentum breakout bot for the pump.fun paper-trading replay (`agent-fun/replay/v2`, Node 22, `main.ts`).

## Strategy

Watch every new bonding curve from first sight. Buy a small fixed stake (0.10 SOL) when the price breaks out: **+8% above the first-seen price and +15% above the low since first seen**, with at least 4 recorded trades, and never more than +60% above first seen (no chasing tops).

Exits, measured on position value vs cost (fees included):

- Take profit at **+30%**
- Stop loss at **−15%**
- Trailing stop **−12% from the peak** once up **+10%**
- Time stop after **12,000 slots** held

Stakes stay small and at most 5 positions are open, so the bot keeps rotating through fresh breakouts — every buy is ≥ 0.01 SOL, clearing the 20-distinct-mint round-trip guardrail.

## Determinism

Every decision comes from the batch stream only: insertion-ordered maps, exact bigint price comparisons, no clock, no environment, no randomness. The entry runs twice in grading and both action logs must match byte for byte.

## Files

- `main.ts` — the strategy (stdlib only, no dependencies)
- `vendor/makefun-bot.ts` — the kit's bot shim, copied verbatim from the kit
- `LICENSE` — MIT
