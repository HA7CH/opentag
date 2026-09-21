# ANC V4 pilot foundation and rollout gates

Status: draft implementation; NOT a production release.

## Provenance

This branch builds on the public OpenTag source commit
`724134b4bd6dc98ac1f87c4026b27781a3042b61`.
Retain upstream Git history, Apache-2.0 licensing and THIRD_PARTY_NOTICES.
The ANC modules are original integration code using the existing durable-file and
Codex runtime contracts; no OpenClaw or Hermes source has been copied.

A source commit is not a deployed version. Release operators must privately
record the source SHA, lockfile digest, artifact digest, executable path and
observed process version. Do not place host inventories or runtime evidence in
this public repository.

## Isolation

Develop and validate in isolated worktrees. Do not overwrite existing knowledge
stores, historical working trees, independent tenants or live sessions.
Credentials, source material, generated deliverables, message records and
deployment configuration stay in access-controlled runtime storage.

## Implemented foundation

- Atomic, fsynced project state with command deduplication and durable side effects.
- Version-bound human requests, recipient validation, one reminder and explicit blocking.
- Stable outbox IDs, bounded retries for known no-side-effect failures and unknown-result reconciliation.
- Separate owner/worker sessions, scoped hosted tools and stored provider bindings.
- Durable goal intake creates and retains the original owner session through proposal revision and approval.
  A single background worker drives ready intake, effects and due reminders without polling the model while idle.
- Independent bounded execution and delivery lanes; capacity waits do not consume failure retries.
- An unresolved prior run prevents new work until its effects are reconciled.
- Failed and uncertain side effects remain visible to the owner; bounded recovery cannot recursively spawn recovery work.
- Verified, private, content-addressed artifacts and version history. Review and publication recheck the exact bytes.
- Background Feishu grants do not write or remove another active turn's CLI credential files.
- Exact-message Feishu identity checks and durable text/card creation receipts, not yet connected to production ingress.
- Consecutive card revisions under a single delivery lock; stale updates cannot overwrite newer content.
  Unknown PATCH results block later writes until the exact original card JSON is verified.
  Explicit rate-limit rejections and readback attempts are bounded to three; uncertainty never authorizes a second card.
- Public assistant message phases survive the Codex bridge, including terminal-snapshot-only messages.
- A bounded Card 2.0 projection separates actual answers and keeps commentary as progress.
  Steering alone does not create a card. Tool logs, raw reasoning and user input are excluded.
- A durable, coalescing card publisher separates model output from network I/O. Public snapshots checkpoint at
  a bounded cadence and at terminal events; immutable pending writes survive newer output and process restarts.
  Namespace/project/run isolation, consecutive revisions and bounded reconciliation prevent duplicate sends.
- Verified plain-text feedback requires a quoted request or explicit confirmation reference. Acknowledgements,
  conditional prose, mismatched anchors and stale cards cannot authorize a different action or version.
  Replayed messages reuse the original durable command, including its verified human identity.

These components are not yet connected to the live pilot ingress. Do not enable a second listener or
let the ordinary CLI reply path and the ANC publisher both own the same input. Human-request cards,
project-group creation, attachment delivery and callback integration remain separate release gates.
- Metadata-only private inventory tooling; imported material is not automatically promoted to authority.

## Reproducible checks

Run the repository commands in AGENTS.md with its pinned toolchain.

Record the exact source tree for formatting/lint contracts, serial workspace build,
bundle reporting, all workspace type checks, root script tests and workspace tests.
The local test fixtures require loopback socket access; a sandbox-denied listener
is not a product failure or a passing test.

The Agent Runtime coverage gate requires 100% for its configured scope.
This is not repository-wide or ANC-module-wide coverage. Keep failed and retried
run records alongside the eventual result; do not report a partial run as a pass.

Mocked transport tests and opt-in model smoke tests are different evidence levels.
The smoke fixtures explicitly simulate human approvals and external delivery.
They do not prove Feishu client receipt, real document delivery or deployment.
Private run traces must not be added to this repository.

PostgreSQL integration still requires a working container runtime.
A CI result, real client acceptance and release provenance remain required.
All checks must be rerun after relevant changes.

## Transport contracts

The adapter follows the official
[message lookup](https://open.feishu.cn/document/server-docs/im-v1/message/get.md)
and [send-message](https://open.feishu.cn/document/server-docs/im-v1/message/create.md)
contracts, plus the [card update](https://open.feishu.cn/document/server-docs/im-v1/message-card/patch.md)
contract. Card previews are bounded by encoded UTF-8 size, including escaped markup.
Provider UUID deduplication is time-limited; durable local receipts
remain authoritative after that window expires.

## Remaining release gates

1. Prove the installed build correspondence and exclusive pilot ingress ownership.
2. Complete repository integration gates and flight/restart recovery checks.
3. Connect verified identities, card/reply callbacks, attachments and receipt reconciliation.
4. Run a marked single-reviewer test project: start, parallel tasks, revision,
   cross-channel reply, actual delivery and explicit close.
5. Review imported sources and authority conflicts; verify knowledge and skill promotion.
6. Prove client-visible receipt, readable artifacts and isolation from non-pilot workloads.

Keep the PR in draft until these gates are met. Passing unit tests or a healthy
service is not a substitute for the complete user-visible flow.

## Resource safety

Do not run unrestricted full-suite jobs on a shared production machine.
Use isolated CI or a source-only verification workspace, or an explicitly bounded
process group with total memory, swap, CPU and runtime limits.
A per-process heap limit does not cap an entire descendant tree.
Never kill unrelated services to make room for validation.

## Migration and rollback

Inventory metadata stays private. Hashes identify bytes, not authority.
Each source needs a version, owner, access scope, destination and disposition:
canonical, merge, history, human arbitration, or exclusion with a reason.
Pending review is not migration. Separate tenants' data must not be combined.
Legacy and new projections must not both write migrated project state.
Imports do not automatically execute work or send notifications.

Rollback stops only the pilot scheduler and preserves its state, bindings and
receipts for reconciliation. Never replay uncertain pilot side effects through
another runtime. Preserve historical data and sessions.
