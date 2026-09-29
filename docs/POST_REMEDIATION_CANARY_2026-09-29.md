# Post-remediation MainNet canary — 2026-09-29

This record captures the successful production MainNet canary run performed after
the readiness, Indexer failure-handling, MCP contract, and polling-backoff
remediation work merged through PR #82.

It is evidence of the observed production run, not a synthetic benchmark.

## Production build

- Production commit: `4393736b89295f646eaf0fa1c0d66f2645b66430`
- Render deploy: `dep-datqnegu01pc73fk6cb0`
- Deploy status before the paid canary: `live`
- Network: Algorand MainNet
- Watched asset: Circle USDC ASA `31566704`
- RoundWatch service price during this canary: `0.02 USDC`

## Durable watch

- Watch ID: `11d8381e-d618-4c07-9c12-11adfeccc90e`
- Service settlement transaction:
  `GGZDKTXPZHNYAYNMN7VYWHSOISXFZUZEL2QZFCUXBB26BQBMM4CQ`
- Activation round: `65506129`
- Activated at: `2026-09-29T12:19:16.677Z`
- Created at: `2026-09-29T12:19:11.865Z`
- Watch expiry: `2026-09-29T12:49:11.865Z`
- Watched amount: `1` USDC atomic unit (`0.000001 USDC`)
- Work-unit budget: `500`

The service settlement and the watched transfer were separate MainNet
transactions. The watched transfer was sent only after the durable watch had
already activated.

## Matched watched transfer

- Invoice / matched transaction:
  `GB2IUPO57JPMFARPZTK4CO344X2ORY34X4GAAUZ5SIHURMHF5U4Q`
- Matched round: `65506218`
- Final watch state: `matched`
- Final `scanAfterRound`: `65506217`
- Work units used: `50 / 500`

The matched round was strictly later than the activation round:

```text
activation round  65506129
matched round     65506218
difference               89 rounds
```

## Production telemetry

The terminal per-watch telemetry recorded:

```text
scan-page attempts        48
scan-page successes       48
scan-page failures         0
scan-page timeouts         0

reconciliation attempts    2
reconciliation successes   2
reconciliation failures    0
reconciliation timeouts    0

transactions returned      1
transactions examined      1
rounds covered            88
work units claimed        50

active duration        249544 ms
time to terminal       254356 ms
final state            matched
```

The production runtime snapshot immediately after the match reported:

```text
Indexer successes   260
Indexer failures      0
Indexer timeouts      0
```

Subsequent runtime snapshots continued without Indexer failures or timeouts in
the observed post-canary window.

No `roundwatch_readiness_blocked` event was observed in the production log
window covering the deployed build and this canary.

## What this canary proves

For this production build and this exact MainNet run, RoundWatch successfully:

1. returned an unpaid x402 challenge for watch creation;
2. accepted and settled the service payment;
3. activated a durable watch with the intended nonzero monitored sender;
4. continued background polling after activation;
5. observed a separate future USDC transfer matching the watch specification;
6. transitioned the durable watch to `matched`;
7. did so without an Indexer failure, timeout, or observed readiness blocker in
   the canary window.

This run does not prove horizontal multi-worker safety, arbitrary-provider
availability, multi-chain behavior, or every possible watch specification. It
is a production proof of the current single-service Algorand MainNet purchase,
durable-polling, and matching path.
