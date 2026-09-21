# ANC: human messaging, not a workflow engine

This draft starts from `724134b4`, independently of PRs #1 and #2. It adds one
hosted tool and a correspondence ledger. It does not define projects, task modes,
approval stages, a scheduler or another session engine. Agents choose their work
using normal tools, OpenTag session collaboration and the accompanying Skill.

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
OpenTag's current best-effort session FIFO alone does not satisfy durable enqueue;
do not acknowledge a reply merely because it entered that FIFO. No service was
deployed and there is no claim of a completed Feishu pilot.

Use one private ledger directory per bot binding, outside agent-writable roots.
Concurrent access fails closed on an exclusive lock. After a process crash an
operator must verify the recorded PID is dead before removing `writer.lock`, then
call `replayReplies()`. Automatic lock recovery and retention are not implemented.
An unknown outbound send requires reconciliation. Replies queued before a crash
reuse their stable ID. Adapters must validate destination access and preserve that
ID through durable acceptance. There are no attachments yet: use authorized links.
