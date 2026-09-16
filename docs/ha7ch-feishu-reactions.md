# HA7CH Feishu turn reactions

This fork adds optional runtime-owned progress reactions to OpenTag v0.0.5. It is independently maintained by HA7CH; upstream is `first-tree-ai/opentag`. Original Apache-2.0 licensing and notices remain in place.

Set `OPENTAG_FEISHU_TURN_REACTIONS=1` in the OpenTag daemon environment and restart it after active turns finish. Omit the variable to preserve upstream behavior. This option applies to Feishu/Lark messages owned by this computer; it does not enable Slack reactions.

- `OnIt`: the model decided to help or answer and explicitly claimed this message through the native CLI. Receipt alone creates no reaction.
- Normal completion: remove the processing reaction without posting a completion reaction.
- `ERROR`: the turn failed, was cancelled, or has an unknown outcome.

The model decides separately for each message, including successful steers, mentions, private chats, and ambient group messages. Repeated IDs within a turn are deduplicated. Observer copies never react. Unclaimed messages never receive ERROR. At turn completion, the client checks for a recent OnIt belonging to this bot and only finalizes that claim. Other actors and old reactions are left alone.

The client uses the existing short-lived tenant token, with no additional stored app secret. Each API request has a three-second deadline and does not follow redirects. The model uses the native CLI to create processing feedback after deciding to accept work; terminal lookup and cleanup are bounded and complete before credential cleanup. Provider failures are logged without response bodies or credentials and do not change the model outcome. Only a recent processing reaction ID verified as belonging to this bot is deleted. There is no blind retry after an ambiguous API failure.

A process kill, network failure, or expired token can leave a stale processing reaction; these reactions are UI hints, not a durable task ledger. Reactions may require the bot's message-reaction permission in Feishu. The feature does not grant that permission automatically.

The branch also preserves the existing Codex Context Tree fix: the connected tree's `.git` directory is explicitly included in writable roots so fetch/write operations work inside the sandbox.

## Verification

Run the reaction, turn-runner, credential-environment, and session-runtime-manager tests, then `pnpm check`, client/CLI build, and typecheck. For live acceptance, send a human message in the target chat and verify `OnIt`, its removal, a terminal reaction, and any actual reply separately. Wait for active turns to finish before restarting a daemon.
