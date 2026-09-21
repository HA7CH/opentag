# ANC: human messaging, not a workflow engine

This draft ports PR #3 (`5d2d2e2d`) onto synchronized HA7CH `main` (`7bf1cea8`),
which contains upstream `6d1a26cb`. It does not include PRs #1/#2 or the legacy
`feat/feishu-turn-reactions` branch. The tool, tests and Skill retain their original
Git blob identities; only this integration document changes for the new baseline.

It adds one hosted tool and a correspondence ledger. It does not define projects,
task modes, approval stages, a scheduler or another session engine. Agents choose
their work using normal tools, OpenTag session collaboration and the accompanying Skill.

`HumanMessaging.tools(scope)` supplies `send_msg_to_person` through the existing
`CreateAgentRuntimeRequest.hostedTools` interface. The runtime supplies the source
session, tenant and admitted people; the model supplies the message and retry key.
The ledger is written before sending; an uncertain outcome is reconciled, never
blindly resent. Call `receive(eventId)` from verified ingress to fetch the original
reply and match its sender, tenant, conversation and quoted message to the source
session. Reply text is data, not proof of approval. No semantic classification is
required. Unquoted replies remain ordinary chat rather than guessing a destination.

## Integration boundary — not yet live

This PR implements the transport-neutral tool, persistence, correlation and tests.
It does NOT install a Feishu transport or connect production ingress. The host must
provide authenticated send/lookup/readReply and durable idempotent enqueue adapters.
Use the maintained Session collaboration and durable-work path described in
[Internal Session collaboration](./internal-session-collaboration.md), preserving
stable message IDs and the source/target authorization boundary. An in-memory FIFO
alone is not durable custody, and acceptance is not completion. The upstream path
already has persistence/retry contracts; do not introduce a competing scheduler.

The current upstream Local callback path requires `runtime.sessionCollaboration`
v2 and `runtime.imCredentialGrant` v2. Internal Sessions do not receive IM credentials;
visible callback Sessions retain their existing conversation authority. A human-message
adapter must explicitly validate the admitted recipient and bot binding rather than
assuming internal-session authority authorizes arbitrary external messaging.

Use one private ledger directory per bot binding, outside agent-writable roots.
Concurrent access fails closed on an exclusive lock. After a process crash an
operator must verify the recorded PID is dead before removing `writer.lock`, then
call `replayReplies()`. Automatic lock recovery and retention are not implemented.
An unknown outbound send requires reconciliation. Replies queued before a crash
reuse their stable ID. Adapters must validate destination access and preserve that
ID through durable acceptance. There are no attachments yet: use authorized links.

## Verification and deployment

The port reuses the original production/test/Skill blobs instead of reconstructing
or modifying them. Their original test results are not acceptance for this new base.
Run all `AGENTS.md` gates and the focused `human-messaging.test.ts` suite on the
combined tree. The porting environment could not clone/install the repository, so
it did not run the full typecheck, build, Vitest suites or PostgreSQL integration.
No service was deployed, no message was sent and no completed Feishu pilot is claimed.
