# Post-reprice MainNet canary — 2026-09-29

This record captures the successful production MainNet canary run after
RoundWatch repriced one 30-minute durable watch from 0.02 USDC to 0.10 USDC.

It is evidence of the observed production run, not a synthetic benchmark or an
availability guarantee.

## Production build

- Production commit: `c3648f16afca7a124679f5f27130592223b5c569`
- Render deploy: `dep-dats5ms9v7es73ar08eg`
- Deploy status before the paid canary: `live`
- Network: Algorand MainNet
- Watched asset: Circle USDC ASA `31566704`
- Service price: `0.10 USDC` (`100000` atomic units)
- Watch contract: 30-minute eligibility window, 500-turn durable work budget

The free preflight completed before the paid phase and verified that the live
unpaid `POST /v1/watch` returned HTTP 402 with the approved MainNet x402
requirement. The client reported that no transaction was constructed, signed,
or broadcast during preflight.

## Service purchase

- Watch ID: `dd79d2e3-a2c3-4b15-b607-0551d47dbf69`
- Service settlement transaction:
  `3TCQQKSTOZ46JQU5AWKGVSV7VF3RLHIMGE6PK2MMQNZBUEYIMOTA`
- Activation round: `65511054`
- Activated at: `2026-09-29T16:04:37.758Z`
- Created at: `2026-09-29T16:04:32.866Z`
- Watch expiry: `2026-09-29T16:34:32.866Z`

Production request telemetry for the paid retry recorded HTTP 200 with
`paymentPresented=true` and `paymentOutcome=settled`. A subsequent public
watch-status lookup returned HTTP 200 and the watch entered durable background
polling.

## Watched invoice and match

- Watched invoice amount: `1` USDC atomic unit (`0.000001 USDC`)
- Invoice transaction:
  `OQDBQ22YVAV3T4ACER5QMMCQ7746OGNKKPCUVPJ2JXX2DTJ5VYXA`
- Matched transaction:
  `OQDBQ22YVAV3T4ACER5QMMCQ7746OGNKKPCUVPJ2JXX2DTJ5VYXA`
- Matched round: `65511103`
- Final `scanAfterRound`: `65511102`
- Final watch state: `matched`
- Work units used: `28 / 500`

The matched round was strictly later than the activation round:

```text
activation round  65511054
matched round     65511103
difference               49 rounds
```

Production logs show scan progress continuing through round `65511102`,
followed by:

```text
RoundWatch matched watch dd79d2e3-a2c3-4b15-b607-0551d47dbf69 in round 65511103
```

## Runtime observations

The global Indexer counters immediately before the paid creation window were:

```text
successes  2595
failures      1
timeouts      1
```

The first runtime snapshot after the watch had matched reported:

```text
successes  2712
failures      1
timeouts      1
```

Therefore, no additional global Indexer failure or timeout was recorded during
this canary window. The pre-existing one failure / one timeout occurred before
this price canary and is not attributed to this watch.

## What this canary proves

For this production build and this exact MainNet run, RoundWatch successfully:

1. advertised and safety-validated the new `0.10 USDC` x402 service price;
2. settled a real MainNet service payment for the repriced contract;
3. activated a durable watch after settlement;
4. continued background polling;
5. observed a separate future MainNet USDC transfer;
6. exact-matched that transfer by the watch contract;
7. reached terminal state `matched` using only `28 / 500` durable work units;
8. completed the canary window without adding an Indexer failure or timeout.

This run does not prove arbitrary provider availability, horizontal multi-worker
safety, multi-chain behavior, or every possible watch specification. It is a
production proof that the repriced 0.10 USDC RoundWatch purchase and durable
matching path works end to end on Algorand MainNet.


## Bazaar post-reprice qualification

After the successful 0.10 USDC canary, the public discovery path was
requalified without spending additional funds.

The live RoundWatch `POST /v1/watch` challenge was current and valid:

- x402 version: `2`
- scheme: `exact`
- network: Algorand MainNet
- amount: `100000` atomic USDC (`0.10 USDC`)
- asset: `31566704`
- receiver: `EQPLN32HPLPGBCNPOZUL6BL34CTNQGT3VAAMNAJWSIZGQ5CUNXOHB634XY`
- challenge tag: `x402-global-challenge`
- Bazaar extension shape: HTTP POST + JSON input/output

The GoPlausible catalog was read to completion and contained one exact
RoundWatch resource / receiver match. That record was stale after the successful
0.10 USDC settlement:

- catalog amount: `20000` atomic USDC (`0.02 USDC`)
- settle count: `7`
- last seen: `2026-09-29T16:04:37.596Z`
- live paid watch activation: `2026-09-29T16:04:37.758Z`

The near-identical timestamps show that the facilitator observed the fresh
settlement and advanced catalog activity while retaining the predecessor price.

A full catalog forensics pass found no duplicate RoundWatch record with the new
price. The exact resource URL, RoundWatch host, service receiver, and RoundWatch
text each resolved to one resource candidate.

A local payment-payload echo probe then verified, without submitting a paid
retry, that the current server-side Bazaar extension is copied into the
client-created PaymentPayload unchanged:

```text
serverDeclared: true
payloadEchoed: true
sameJsonShape: true
networkSubmissionPerformed: false
```

Therefore the stale `20000` catalog amount is not explained by the current
RoundWatch challenge, duplicate catalog records, or loss of the Bazaar
extension during client payload construction. No additional paid recatalog
settlement was attempted because the successful 0.10 USDC settlement had
already updated `lastSeen` / `settleCount` without refreshing the stored
terms.

The discovery search endpoint returned HTTP 404 during this qualification, so
search ranking was not evaluated.
