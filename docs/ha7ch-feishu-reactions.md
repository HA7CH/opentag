# HA7CH Feishu turn reactions

This fork adds optional runtime-owned progress reactions to OpenTag v0.0.5. It is independently maintained by HA7CH; upstream is `first-tree-ai/opentag`. Original Apache-2.0 licensing and notices remain in place.

Set `OPENTAG_FEISHU_TURN_REACTIONS=1` in the OpenTag daemon environment and restart it after active turns finish. Omit the variable to preserve upstream behavior. This option applies to Feishu/Lark messages owned by this computer; it does not enable Slack reactions.

- `OnIt`: credentials are ready and the turn is starting or processing.
- `DONE`: the model turn ended normally. This is not proof that every business objective was achieved or that a reply was delivered.
- `ERROR`: the turn failed, was cancelled, or has an unknown outcome.

A successful steer gets the same feedback. Repeated message IDs within a turn are deduplicated. Observer copies never react. Ordinary ambient deliveries owned by the session do react, even when the model chooses not to send a reply.

The client uses the existing short-lived tenant token, with no additional stored app secret. Each API request has a three-second deadline and does not follow redirects. Processing creation runs concurrently with the model; terminal cleanup is bounded and completes before credential cleanup. Provider failures are logged without response bodies or credentials and do not change the model outcome. Only the processing reaction ID returned to this client is deleted. There is no blind retry after an ambiguous API failure.

A process kill, network failure, or expired token can leave a stale processing reaction; these reactions are UI hints, not a durable task ledger. Reactions may require the bot's message-reaction permission in Feishu. The feature does not grant that permission automatically.

The branch also preserves the existing Codex Context Tree fix: the connected tree's `.git` directory is explicitly included in writable roots so fetch/write operations work inside the sandbox.

## Verification

Run the reaction, turn-runner, credential-environment, and session-runtime-manager tests, then `pnpm check`, client/CLI build, and typecheck. For live acceptance, send a human message in the target chat and verify `OnIt`, its removal, a terminal reaction, and any actual reply separately. Wait for active turns to finish before restarting a daemon.
