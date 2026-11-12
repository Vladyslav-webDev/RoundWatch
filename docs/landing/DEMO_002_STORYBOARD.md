# Demo 002 — Canonical x402 on Algorand TestNet

Cut a roughly 75-second recap from the recorded November 2026 TestNet run. Keep an **Algorand TestNet · recorded run** label visible while showing its evidence. Use the service settlement and later USDC transfer as two distinct on-chain events tied together by the watch ID.

| Time | On screen | Narration |
| --- | --- | --- |
| 0–12 s | Unsigned `POST /spike/watch`, HTTP `402` and the decoded `PAYMENT-REQUIRED` offer. Highlight x402 v2, `exact` and `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe`. | “An unsigned 402 advertises the offer. Check the terms and body before signing locally. The signed retry is subject to paid admission checks.” |
| 12–27 s | Annotate the approved service receiver and the watched transfer’s sender and receiver separately. Overlay the purchase sequence: local signing → signed retry → verify → durable preparation → settlement → activation. | “The service fee buys the watch. RoundWatch validates the signed retry, verifies the payment and durably prepares the watch before settlement, then activates it.” |
| 27–41 s | Show the saved create response with watch ID `d1bc7771-47e3-4f56-ab81-1bef5af80dfe`. Cut to the confirmed service settlement `ZE56FBJ2ZYA63V3XZAKZUU4Z7D6B44IPK2W3HZIQNCWMTLOYNQAA`. | “Once the watch is active, the caller can exit and use the saved ID later.” |
| 41–61 s | Show the separate confirmed TestNet USDC transfer `27SSHVRZRFOJ266QPRGEGQF6S7AROANNR6NYRWX2B2GVPL2SXVAQ`. Show the saved `GET /spike/watch/{id}` response with `watch.state` set to `matched`, the same watch ID and both transaction IDs. | “This later transfer is the payment the watch was created to observe. The free status lookup links it to the original watch.” |
| 61–75 s | End card with two lines: **Canonical paid end-to-end proof · TestNet** and **November 9 MainNet release · health, readiness and unpaid 402 checks passed**. | “A paid MainNet purchase with this release is still unverified.” |

## Required recording assets

- Redacted captures from the original run showing the decoded offer, paid-create response and final status response. Use the actual offer amount and TestNet asset from the capture. Remove wallet secrets, credentials, signed payment payloads and private notes or keys used for idempotency.
- Saved TestNet explorer or Indexer evidence for both transaction IDs, with the network, asset and confirmed rounds visible. Check the IDs against the watch record and show the later transfer’s round where the capture supports it.
- November 9 release and smoke-check evidence for the MainNet end card. Label the September MainNet canary or existing site video as historical whenever shown.
- A labeled sequence graphic for server steps, a TestNet poster, captions and a transcript. Use clearly labeled diagrams for stages without footage. The existing video and poster remain the legacy demonstration until the replacement is available.

## Evidence and review

The November TestNet IDs and MainNet smoke results are from the release evidence supplied for Refresh 001A. The pinned production source verifies the API contract, SDK version, routes and canonical IDs. The September canary documents the earlier paid MainNet purchase and separate matched transfer. The raw November captures and smoke logs still need to be attached for recording review. There is no confirmed independent paying customer. [Production route and payment flow](https://github.com/Vladyslav-webDev/RoundWatch/blob/8384c6ff4b1cc8f8412d5e4ad59f6c8d8b1992a5/apps/server/app.ts) · [Canonical network IDs](https://github.com/Vladyslav-webDev/RoundWatch/blob/8384c6ff4b1cc8f8412d5e4ad59f6c8d8b1992a5/apps/algorand-networks.ts) · [SDK version](https://github.com/Vladyslav-webDev/RoundWatch/blob/8384c6ff4b1cc8f8412d5e4ad59f6c8d8b1992a5/apps/server/package.json) · [September MainNet canary](https://github.com/Vladyslav-webDev/RoundWatch/blob/8384c6ff4b1cc8f8412d5e4ad59f6c8d8b1992a5/docs/POST_REPRICE_CANARY_2026-09-29.md)
