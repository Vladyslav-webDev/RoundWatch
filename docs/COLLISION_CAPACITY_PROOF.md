# Canonical collision-capacity proof

Status: source-level validation of the transaction-size probe used by the RoundWatch economics audit. This proof is supporting capacity evidence; the production 500-turn work budget and `indeterminate` semantics remain the hard service-side safety bound and do not depend on the exact transaction size below.

## Question

The client probe reports a 203-byte `SignedTxnInBlock` for a minimal no-note USDC asset transfer at representative current MainNet round widths. Earlier audit notes treated that number as a JavaScript model because the probe reconstructs the block representation rather than executing the Go codec itself.

The source review checks whether that reconstruction is structurally identical to the current Go block encoder for the probe fixture.

## Current protocol path

In upstream `go-algorand`:

1. `BlockHeader.EncodeSignedTxn` converts a normal signed transaction to `SignedTxnInBlock`.
2. Current protocol descendants require `GenesisHash`. When the transaction hash matches the block header, `EncodeSignedTxn` clears the transaction's genesis-hash field before block serialization.
3. Because the protocol requires the hash, the legacy `HasGenesisHash` compatibility flag remains false.
4. The probe supplies no `GenesisID`, so `HasGenesisID` also remains false.
5. The probe models an ordinary successful asset transfer with empty `ApplyData`.
6. Generated `SignedTxnInBlock.MarshalMsg` omits zero-valued ApplyData, false hgh/hgi flags, absent multisig/logic/PQ signatures and absent auth address. For a standard Ed25519 signed transfer, the surviving top-level fields are therefore `sig` and `txn`.
7. `SignedTxnInBlock.GetEncodedLength()` is exactly the byte length produced by that `MarshalMsg`.

The local probe starts from the SDK's signed canonical transaction object, verifies the expected standard-signature shape, verifies that `gh` exists and `gen` does not, removes only `txn.gh`, and canonically MsgPack-encodes the remaining object.

The JS SDK's `encodeObj` delegates to its canonical MsgPack encoder with sorted keys. The relevant Go generated marshaler emits the same short protocol field names in canonical order. For this fixture there are no extra `SignedTxnInBlock` fields to encode.

## Result

For the stated fixture, the JavaScript reconstruction is source-equivalent to the current Go `SignedTxnInBlock` serialization shape. The measured 203-byte no-note value can therefore be used as a source-validated capacity estimate for that fixture rather than merely an unconstrained approximation.

The corresponding arithmetic is:

- block transaction-byte budget: 5,242,880 bytes;
- no-note fixture: 203 bytes per `SignedTxnInBlock`;
- floor(5,242,880 / 203) = 25,826 modeled transactions per full block;
- over 100 fully saturated rounds: 2,582,600 candidates;
- at 1,000 Indexer results per page: 2,583 pages.

These are upper-capacity calculations for the chosen transaction shape, not a claim that MainNet routinely approaches this density and not a statement that an attacker can always get a fully saturated block accepted. Mempool policy, congestion pricing, balances, ordering, and competition for block space all affect practical feasibility.

## Scope and maintenance

This proof is intentionally narrow. Revisit it if any of the following changes:

- the active MainNet consensus protocol changes block transaction encoding;
- `RequireGenesisHash` or `SignedTxnInBlock` compatibility behavior changes;
- RoundWatch models a different signature type or non-empty ApplyData;
- the probe begins supplying GenesisID or additional transaction fields;
- the SDK canonical MsgPack implementation changes incompatibly.

An executable Go fixture comparing `EncodeSignedTxn(...).MarshalMsg(nil)` byte-for-byte with the JS reconstruction would be an additional cross-language regression test, but it is no longer required to justify the service-side work bound. The hard service bound remains the durable 500-turn contract with enforced per-turn Indexer request ceilings.

## Source anchors inspected

- `algorand/go-algorand/data/bookkeeping/block.go`: `BlockHeader.EncodeSignedTxn`.
- `algorand/go-algorand/data/transactions/signedtxn.go`: `SignedTxnInBlock.GetEncodedLength`.
- `algorand/go-algorand/data/transactions/msgp_gen.go`: generated `SignedTxnInBlock.MarshalMsg`, `SignedTxn.MarshalMsg`, and transaction field encoding.
- `algorand/go-algorand/config/consensus.go`: required genesis hash inheritance and 5 MiB block transaction-byte budget.
- `algorand/js-algorand-sdk/src/encoding/encoding.ts`: canonical sorted-key MsgPack used by `encodeObj`.

Source snapshots inspected during this proof: `go-algorand` around `1f4ad10fd780a66a043e15b2e692079aede69b6a`; `js-algorand-sdk` around `b4ca42f9d605dbb9136f99ac09d5f365fc684a68`.
