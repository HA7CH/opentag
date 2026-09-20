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
- Independent bounded execution and delivery lanes; capacity waits do not consume failure retries.
- An unresolved prior run prevents new work until its effects are reconciled.
- Failed and uncertain side effects remain visible to the owner; bounded recovery cannot recursively spawn recovery work.
- Verified, private, content-addressed artifacts and version history. Review and publication recheck the exact bytes.
- Background Feishu grants do not write or remove another active turn's CLI credential files.
- Exact-message Feishu identity checks and durable text receipts, not yet connected to production ingress.
- Public assistant message phases survive the Codex bridge, including terminal-snapshot-only messages.
- A bounded Card 2.0 projection separates actual answers and keeps commentary as progress.
  Steering alone does not create a card. Tool logs, raw reasoning and user input are excluded.
  A live card publisher is not yet connected.
- Metadata-only private inventory tooling; imported material is not automatically promoted to authority.

## Reproducible checks

Run the repository commands in AGENTS.md with its pinned toolchain.

The current foundation passed formatting/lint contracts, serial workspace build,
bundle reporting and all workspace type checks. Tests passed: 335 root script
tests and 3,705 workspace unit tests (228 shared, 950 server, 1,182 client,
911 web and 434 CLI).

The Agent Runtime coverage gate reports 100% for its configured scope:
4,068 statements, 2,898 branches, 703 functions and 3,618 lines.
This is not a claim of repository-wide or ANC-module-wide coverage.

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
contracts. Provider UUID deduplication is time-limited; durable local receipts
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
