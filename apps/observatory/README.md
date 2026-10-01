# Observatory V0: offline observation foundation

This package imports an explicitly chosen, saved Bazaar/discovery JSON snapshot as untrusted data. It retains the exact imported bytes, records their SHA-256 identity, and emits a deterministic `observatory.json` with conservative, versioned interpretations. The hash identifies bytes; it does not establish that the source claims are true.

Run from the repository root:

```sh
pnpm -C apps/observatory test
pnpm -C apps/observatory typecheck
pnpm -C apps/observatory snapshot --input fixtures/known-items.json --output my-new-run-directory
```

`--input` is required. `--output` must name a new directory whose parent already exists. No file is found automatically. A run writes `raw/sha256-<digest>.json` (original bytes), `observatory.json` (deterministic report), then `manifest.json` (run time and outcome). Existing output directories are rejected. Only a final manifest with `status: "complete"` marks a valid catalog import. Malformed JSON, malformed recognized envelopes, and unsupported envelopes retain evidence but get `status: "rejected"` and a nonzero CLI exit code.

Supported envelopes are top-level `items` or `resources`, `data.items` or `data.resources`, `result.items` or `result.resources`, and `result.data.items` or `result.data.resources`. Exactly one list must be present. These shapes follow the existing RoundWatch discovery fixtures and their nested variants. URLs inside snapshots are inert strings.

Records preserve explicit resource identifiers, source IDs, HTTP methods from top-level `method` or Bazaar `extensions.bazaar.info.input.method`, MCP tool names from `mcp.tool`, bounded descriptions, source timestamps, and separate x402 `accepts` offers. Unknown or absent values remain null. Atomic amounts are accepted only as decimal integer strings; numeric JSON values are rejected as interpretations. Original fields remain in the raw artifact, with JSON Pointer locators in the report.

There is no network, payment, signing, wallet, watch creation, merchant contact, MCP execution, shell execution, model integration, SQLite, opportunity detection, ranking, or deferred obligation classification in this runtime. It does not import server or client runtime modules.
