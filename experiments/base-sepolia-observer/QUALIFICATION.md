# Base Sepolia RPC qualification

On 13 November 2026, Base and PublicNode agreed on linked headers and one Circle USDC `Transfer` log for blocks **58,287,672–58,287,675**. The older sample stayed `unresolved` because both providers returned an error for its first required header. The CLI exited 1 because both samples must pass for the run to report `operational_agreement` overall.

## Reproduce

From the repository root with Node.js 24 and HTTPS access to the public RPC endpoints:

```powershell
node experiments/base-sepolia-observer/qualification.ts onfinality
node experiments/base-sepolia-observer/qualification.ts publicnode
```

Each invocation selects Base plus one independently published operator endpoint. Separate operators may share infrastructure or data sources. [Base public RPC](https://docs.base.org/get-started/connect-to-base), [OnFinality public RPC](https://www.onfinality.io/en/rpc-assistant/base-public-rpc-url-and-dev-tools), [PublicNode by Allnodes](https://base.publicnode.com/).

| Operator | Endpoint |
| --- | --- |
| Base | `https://sepolia.base.org` |
| OnFinality | `https://base-sepolia.api.onfinality.io/public` |
| PublicNode (Allnodes) | `https://base-sepolia-rpc.publicnode.com` |

Each provider has ceilings of 24 JSON-RPC requests, 30 seconds of elapsed time, 4 seconds per request, 256 KiB of decoded body per response, and 1 MiB of decoded body in total. The HTTP request body is capped at 512 bytes and the log range at four blocks inclusive. The providers run in parallel with one request at a time per provider. Each command therefore permits at most 48 requests and 2 MiB of decoded response bodies. There are no retries or redirects. Exit 0 requires agreement on both samples, exit 1 reports an unresolved sample, and exit 2 indicates an invalid command argument.

The CLI uses HTTP POST for these read methods:

| Method | Parameters and checks |
| --- | --- |
| `eth_chainId` | `[]`. Require Base Sepolia chain ID `0x14a34` (`84532`) before reading any blocks. |
| `eth_getBlockByNumber` | `["finalized", false]`, `["latest", false]`, and `["0x…", false]` for exact numbered heights. Check the finalized tag against its numbered block. For each sample, fetch and compare the numbered predecessor through the end of the range, checking parent hashes, nondecreasing timestamps, and transaction lists. |
| `eth_getLogs` | Use inclusive `fromBlock` and `toBlock`, Circle USDC at `0x036cbd53842c5426634e7929541ec2318f3dcf7e`, and `topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]`. Check event shape, block hash, transaction position, removal flag and unique log position. Compare each range to the corresponding single-height results, then compare the two providers. |

The fixed historical sample is `42,123,681–42,123,684` (`0x282c1a1–0x282c1a4`). It requires a transfer for the explorer-indexed transaction at `42,123,682` as a positive control against a shared empty response. The recent sample takes four blocks ending at the lower sampled finalized height after both providers pass their numbered anchor checks. The code reads full transaction hash lists from block responses and uses the broad `Transfer` filter to exercise log retrieval. [Historical transaction on BaseScan](https://sepolia.basescan.org/tx/0xc4b59822afe0905e528e665631f024e798575853f6f1b7d11aff69f04d25237a), [Circle USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses), [ERC-20 event specification](https://eips.ethereum.org/EIPS/eip-20), [Base block method](https://docs.base.org/base-chain/api-reference/ethereum-json-rpc-api/eth_getBlockByNumber), [Base log method](https://docs.base.org/base-chain/api-reference/ethereum-json-rpc-api/eth_getLogs).

## Observed runs

All times below are UTC on 13 November 2026. Response bytes count decoded body bytes consumed by the client, excluding HTTP headers and network overhead. The request-byte column counts JSON bytes prepared by the client. A DNS failure can prevent those bytes from being sent. The client discards non-success HTTP response bodies, so a measured zero for HTTP 429 does not describe the server's body size. Durations are measured locally and include connection and parsing time. Each row sums that provider's individual call durations.

| Start | Provider | Requests (`chainId` / block / logs) | Request / response bytes | Summed latency | Observed outcome |
| --- | --- | ---: | ---: | ---: | --- |
| 14:34:42.837 | Base | 1 / 0 / 0 | 59 / 0 | 60.43 ms | DNS `ENOTFOUND` in sandbox |
| 14:34:42.837 | OnFinality | 1 / 0 / 0 | 59 / 0 | 29.86 ms | DNS `ENOTFOUND` in sandbox |
| 14:34:55.622 | Base | 1 / 4 / 0 | 396 / 6,973 | 715.55 ms | Chain ID, both tags and numbered anchor returned. Historical predecessor `42,123,680` returned HTTP 200 with RPC error `4444`. |
| 14:34:55.622 | OnFinality | 1 / 2 / 0 | 226 / 2,331 | 840.98 ms | Chain ID and finalized tag returned. HTTP 429 on `latest` at 109.94 ms, before the numbered anchor and ranges. |
| 14:36:00.993 | Base | 1 / 8 / 5 | 1,946 / 16,822 | 1,822.22 ms | Tags, numbered anchor and recent range returned. Historical predecessor returned HTTP 200 with RPC error `4444`. |
| 14:36:00.993 | PublicNode | 1 / 8 / 5 | 1,946 / 16,828 | 680.08 ms | Tags, numbered anchor and recent range returned. Historical predecessor returned HTTP 200 with RPC error `4444`. |

The three invocations allowed at most 144 request attempts, 6 MiB of decoded response bodies and 90 seconds of elapsed RPC time in total, plus command startup and output. The measured totals were 38 client attempts, of which 36 reached HTTP, 42,954 decoded response bytes and 2,875.32 ms elapsed across the three runs. The first two runs are transcribed from the original command output. The last run's captured output is in [qualification-publicnode-2026-11-13.json](qualification-publicnode-2026-11-13.json).

The history error code corresponds to unavailable pruned history in the Ethereum execution API. Base and PublicNode failed on the historical predecessor `42,123,680` (`0x282c1a0`), so no historical log calls were made, and the historical positive control remains unverified by this probe. [Ethereum execution API block methods and error definitions](https://github.com/ethereum/execution-apis/blob/main/src/eth/block.yaml).

All three endpoints returned chain ID `84532` and the finalized tag at `58,287,675` with hash `0x914f8bfc3eafbfd5929b4d9d8ca7c630ac8540d2a5d61b8713ac666ad205733c`. Base and PublicNode verified the tag against the exact numbered header. Base's first latest sample was `58,293,146`, a gap of 5,471 blocks and 1,095 seconds. In the comparison run Base returned latest `58,293,472` and PublicNode returned `58,293,471`, gaps of 5,797 and 5,796 blocks respectively and 1,160 seconds for both. The finalized tag height skew was zero. The timestamp difference uses block timestamps and is an observed sample of finalized lag.

The recent comparison covered predecessor `58,287,671` and blocks `58,287,672–58,287,675` (`0x3796638–0x379663b`). Both providers reported the same ordered headers and transaction lists, with normalized header SHA-256 `911041c74101b09015044ac6c4a8b9461663c54d561a6f1e856870b6c7d52a51`. Each range query and each provider's combined single-height queries returned one valid Circle USDC `Transfer` at `58,287,673`. Both normalized log sets had SHA-256 `007ab2afb22d05690f697d31585935a505dac2da53b17df73b716a260ad247ce`.

| Provider | Recent numbered headers, excluding reused anchor | One range log call | Four single-height log calls | Total catch-up calls with headers, range vs. single |
| --- | --- | --- | --- | --- |
| Base | 4 calls, 8,394 response B, 468.26 ms | 1 call, 705 response B, 116.10 ms | 4 calls, 820 response B, 550.14 ms | 5 vs. 8 |
| PublicNode | 4 calls, 8,398 response B, 166.10 ms | 1 call, 705 response B, 35.41 ms | 4 calls, 816 response B, 171.86 ms | 5 vs. 8 |

The recent comparison used 242 request body bytes for one range query and 968 for four singles, per provider. Both strategies require the same header reads. These are observed catch-up costs for four blocks with one event and a reused anchor. The comparison establishes no larger range limit, throughput guarantee or monetary cost.

## Evidence limits

Operational agreement covers the tested providers, headers and returned sets. Providers or query modes can share omissions, including identical empty or silently truncated responses. The digests summarize equality of normalized responses. Cryptographic proof of absence would require independently authenticated finalized headers and complete receipt data verified against their commitments. Live qualification does not advance a durable cursor or authorize a terminal watch outcome. A matching ERC-20 tuple is evidence of a transfer. Business invoice identity requires an independent binding.
