# RoundWatch MainNet Readiness

Status: preparation in progress

This document tracks production hardening required before any real MainNet payment is accepted.

## Current baseline

- RoundWatch Spike 0 lifecycle is merged into `main`.
- TestNet USDC flow is proven against GoPlausible and Algorand TestNet.
- Durable SQLite state survives a real process restart.
- Future exact USDC invoice matching is proven on TestNet.

## Blocking production gates

1. Reconcile the settlement → activation crash window.
2. Support explicit TestNet/MainNet network configuration without changing the known-good TestNet behavior.
3. Require a production-safe persistent SQLite path and reject unsafe defaults in production.
4. Confirm repository secrets hygiene and run a history-aware secret scanner before deployment.
5. Deploy a public HTTPS API with persistent disk.
6. Ensure the MainNet receiver is opted in to Circle USDC ASA `31566704` and has enough ALGO for minimum balance and transaction fees.
7. Perform one minimal real MainNet paid E2E.
8. Verify the resulting USDC transfer on-chain.
9. Verify the resource appears in the expected x402 discovery / challenge surfaces.

## Rules

- Never commit a mnemonic, private key, recovery phrase, wallet export, or funded `.env`.
- Never perform a MainNet payment during automated tests.
- MainNet must require an explicit configuration choice; it must never be inferred from a production hostname.
- TestNet remains the default for local development until MainNet is explicitly enabled.
- Do not merge MainNet-readiness code changes until typecheck and focused tests pass on a local checkout.

## Manual wallet steps

The human operator must perform all wallet signing in Pera. ChatGPT/Codex should never receive the wallet mnemonic or private key.

For the receiver account:

- switch to Algorand MainNet;
- ensure the account has enough ALGO for minimum balance and transaction fees;
- add/opt in to verified Circle USDC ASA `31566704`;
- record the public receiver address only.

For the payer account used for the live E2E:

- switch to Algorand MainNet;
- ensure it has enough ALGO for fees and minimum balance;
- ensure it holds a tiny amount of Algorand USDC;
- sign the final payment locally in Pera or through a local client after explicit confirmation.

## Not proof until executed

Code preparation is not evidence that MainNet works. The production gate passes only after:

- local typecheck/tests pass;
- the public HTTPS deployment is healthy;
- a real MainNet x402 settlement succeeds;
- the receiver balance/transaction is independently verified on-chain.
