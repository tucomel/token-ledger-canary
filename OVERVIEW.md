TokenLedger Canary shows per-session and per-turn tokens, cache reads, cache writes and estimated USD cost. It is a fork of TokenLedger with corrected Codex accounting. It adds a cost/context pill beside the composer, an agent ledger panel, a sidebar total and an overview screen.

For Codex, the daemon reads the CLI's local session and archive logs using the configured provider's CODEX_HOME. Each recorded request retains its model, applied processing speed and cumulative identity. This recovers missed updates, keeps distinct equal-sized calls, and avoids adding replayed snapshots twice. The Canary ACP adapter's saved native thread mapping is supported. Original Paseo providers remain responsible for all agent behavior.

Verified OpenAI tariffs account for Fast/Ultrafast, Flex/Batch, per-request context size and cache writes. Custom Standard-mode prices can be set in pricing.json in the plugin's data folder. Unknown model or mode prices remain unavailable. When logs omit cache lifetime, the estimate assumes 30-minute writes and marks that assumption. Unknown processing speed uses a marked Standard assumption. Other providers use the original telemetry path.

State stays under the token-ledger-canary plugin data directory on the daemon host. Only usage metadata and counters are persisted. Prompts, responses, tool arguments and credentials are discarded. Optional public OpenRouter price refreshes contain no session data. Requires Paseo 0.11.0 or later; tested on 0.11.4.

Costs are estimates and do not include unrecorded provider-internal child-thread usage, regional premiums, negotiated pricing or tool fees. Deleted logs cannot be recovered. Disable the original TokenLedger when using this fork to avoid duplicate controls; its separate data can be retained for rollback.
