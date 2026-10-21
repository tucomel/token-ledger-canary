# TokenLedger Canary

Canary's MIT-licensed fork of [stv1024/token-ledger](https://github.com/stv1024/token-ledger). It keeps the upstream session panel, composer pill, overview and local ledger, with corrected Codex accounting. It tracks only the exact `codex-canary` provider. Claude, personal `codex`, Cursor, experimental providers and other aliases are excluded from collection, historical totals and composer pills. Previously stored records remain on disk for rollback. The native Paseo providers keep handling models, approvals, questions, planning, Fast mode and tools.

## Codex accounting

The daemon reads token events from the CLI's own session and archive JSONL files. Each request retains its model, applied processing tier, cache reads, cache writes and a stable native identity. Distinct requests with identical token counts are retained, while replayed cumulative snapshots are ignored. The reader is incremental and only persists counters and settings; prompts, responses, tool payloads and credentials are discarded.

Provider inheritance and `codex-canary`'s `CODEX_HOME` select the source directory. Missing live events and turns that occurred while the plugin was stopped can be recovered from existing logs. Native records replace overlapping Paseo telemetry instead of adding a second charge.

Prices are USD per million tokens. Verified OpenAI model rates apply Standard, Fast, Ultrafast, Flex/Batch and long-context rules to each request. GPT-5.5's published session-wide long-context rule is handled separately. Cache writes are removed from ordinary input before being priced. Mixed models and modes within a turn are priced separately. Custom `pricing.json` entries take precedence; their context tiers replace the built-in tiers, and their rates are Standard-mode rates before processing multipliers.

Supported verified families: GPT-6 Astra, GPT-6.1 Sol, GPT-6 Sol, GPT-6 Luna, GPT-5.6 Sol/Terra/Luna and GPT-5.5. Unknown models use an exact reference price when available, or remain unpriced. Unsupported processing modes remain unpriced rather than inheriting another mode's tariff.

## Install

Requires Paseo 0.11.0 or later. Tested locally on 0.11.4.

```sh
paseo plugin add github:tucomel/token-ledger-canary --ref canary-v0.8.0-3
```

Open **TokenLedger Canary Session Ledger** from the Command Center, the composer's cost pill, or the sidebar. The original plugin's runtime ID is `token-ledger`; this fork uses `token-ledger-canary`. Disable the original when switching to avoid duplicate controls.

State is isolated under `~/.paseo/plugins/token-ledger-canary/` or the equivalent `PASEO_HOME`. With both plugins stopped, existing `ledger.jsonl`, `tracker-state.json`, `pricing.json` and `openrouter-pricing.json` files can be copied from the original plugin's data directory. Keep the originals for rollback. Settings are host-native and separate for each runtime ID.

## Estimates and coverage

- Counts come from recorded usage. Prices are estimates, not an account billing API.
- When a cache-write lifetime is absent, 30-minute pricing is assumed and the turn displays that assumption. Explicit 12-hour retention and mixed retention counters are supported.
- If a log omits processing tier, Standard is assumed and marked. Missing write counts and invalid samples remain visible as coverage warnings.
- Provider-internal child-thread usage is not automatically added to a parent's own-thread totals. Only `codex-canary` usage is included.
- Deleted logs cannot be recovered. Shared native thread records have one ledger owner to avoid duplicate totals.
- Regional premiums, negotiated prices, historical price changes and tool fees need their own pricing data. The price snapshot is dated 2026-10-21; the GPT-5.6 Sol promotional rate must be rechecked after its published validity period.

## Development

Use Node 24 or later. Install dependencies in an isolated container where required by the host workspace rules.

```sh
node node_modules/typescript/lib/tsc.js --noEmit
node --test shared/*.test.ts server/*.test.ts
```

Tests cover the upstream lifecycle and replay behavior plus transcript recovery, custom homes, ACP mappings, equal-size calls, incomplete file tails, processing modes, context thresholds and cache-write pricing. The plugin compiles with Paseo's SDK imports and does not require a custom Paseo build or patched application files.

Original author: stv1024. Canary changes: tucomel. See [LICENSE](LICENSE).
