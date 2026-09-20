# ANC V4 pilot baseline and rollout gates

Status: implementation branch; NOT a production release.

## Provenance

Fork: HA7CH/opentag. Source baseline: 724134b4bd6dc98ac1f87c4026b27781a3042b61.
Retain the upstream Git history, Apache-2.0 license and THIRD_PARTY_NOTICES.
The ANC modules in this change are original integration code using the existing durable-file and Codex runtime contracts; no OpenClaw or Hermes source has been copied.

The existing source checkout and installed production package are separate. The version directory is labeled 0.0.5, but its app symlink resolves to the HA7CH-customized 0.0.5-probe-budget-20260917 build. Do not replace that build with an unqualified upstream 0.0.5 package. A source commit is not a deployed version. A release must record source SHA, lockfile digest, artifact digest, service executable path and observed process version.

## Isolation

Development runs in a separate AWS worktree on codex/anc-v4-human-loop. It must not overwrite the company vault, historical V2 working tree, empty V3 directory, Yili services or production sessions.
Keep private inventories, credentials, messages, generated artifacts and run snapshots outside this repository. GitHub operations originate from AWS.

## Implemented foundation

- Per-project, fsynced atomic state including operation dedupe and pending side effects.
- Version-bound human requests with recipient validation, one reminder and explicit blocking.
- Stable outbox effect IDs, bounded retries only for known no-side-effect failures, unknown-result reconciliation.
- Separate project/worker sessions, task-scoped hosted tools, stored provider bindings and bounded execution.
- Two execution lanes independent of two delivery/reconciliation lanes; capacity waits do not consume failure retries.
- Native Codex tool schemas normalized to the existing portable contract; strict domain validation stays in the handler.
- A session with an unresolved prior run cannot start a new event until its effects are reconciled.
- Failed and uncertain side effects become visible to the project owner. A recovery wake cannot recursively spawn more recovery wakes, and unknown-result lookups stop after three attempts without authorizing resend.
- Allowlisted Feishu transport verifies the exact message author, tenant, application and conversation; its text-delivery ledger survives restarts. It is not connected to production ingress yet.
- Read-only private inventory generator; no automatic promotion of imported material.

## Verification so far

- Thirty-eight focused client tests pass (19 lifecycle, 4 session, 15 mocked Feishu transport): lifecycle, recipient/version authorization, dedupe, real file digest, amendments, restart/outbox reconciliation, cross-channel routing, concurrent execution/delivery, exact-thread resume and steering.
- A live Codex app-server smoke run completed both turns: the model invoked the proposal tool, the host persisted one pending human approval, then a new runtime process resumed the exact same binding and read that state. Forty-eight event records were captured privately. It performed no Feishu sends.
- Three private-inventory tests pass. The project execution Skill passes structural validation.
- Full repository `check`, serial build, bundle report and serial typecheck passed at their recorded checkpoints; the latest client typecheck also passed. A complete rerun on the final tree remains required.
- The full unit suite exceeded its 30-minute budget on the shared host and did not complete. Coverage was stopped to protect host resources; PostgreSQL integration remains unverified. These are release blockers, not passing gates.
- The live `src/smoke/anc-project-loop-e2e.ts` run passed: the owner dispatched two tasks, three persistent Codex sessions completed six runs, courseware progressed while poster review waited, the poster title was actually revised, both file hashes verified, and the project closed after simulated approval. All five human responses and nine external side effects were explicitly simulated. No Feishu client receipt was tested.
- The live smoke command is explicitly opt-in: `pnpm --filter @opentag/client exec tsx src/smoke/anc-hosted-tools-e2e.ts`. Set `ANC_SMOKE_DIRECTORY` to a private evidence directory; no production secrets belong in the repository.

The transport follows the official [message lookup](https://open.feishu.cn/document/server-docs/im-v1/message/get.md) and [send-message](https://open.feishu.cn/document/server-docs/im-v1/message/create.md) contracts. Feishu UUID deduplication lasts only one hour; the durable local receipt ledger must remain authoritative beyond that window.

These checks are not a full Feishu acceptance or a deployment claim. Repository-wide gates and a fresh run after subsequent changes remain required.

## Required remaining rollout evidence

Do not interpret unit fixtures as a live end-to-end pass. Before production enablement:
1. Establish the installed build correspondence and exclusive ownership of pilot ingress.
2. Run all repository gates, real Codex create/resume/tool tests, and flight/restart recovery.
3. Connect verified Feishu identities, card/reply callbacks, attachment delivery and receipt reconciliation.
4. Run the marked Beijing Camp project with only the operator and bot: start, poster revision, courseware, cross-channel reply, delivery and explicit close.
5. Review every discovered source, assign canonical destinations and resolve authority conflicts; exercise knowledge and skill review/promotion.
6. Record client-visible receipt, actual readable artifacts and unchanged non-pilot services.

## Shared-host validation safety

The shared host recorded a global out-of-memory event during the development window; the legacy gateway was automatically restarted by systemd. There is insufficient evidence to attribute the whole event to a single workload. Do not claim uninterrupted production from a later healthy status. The task-owned full-gate supervisor and coverage process group were stopped after this was discovered; logs and all application data were preserved.

Do not rerun unrestricted full-suite jobs on the shared host. Use a task-owned cgroup with an explicit total memory/swap/CPU cap and a runtime budget, or run repository-wide checks in CI. Heap limits and low process priority alone do not cap the aggregate process tree. Existing production services and unrelated workloads must not be killed to make room.

## Data migration rules

Inventory output is metadata only and remains private. Hashes identify bytes, not authority. A pending-review entry is not migrated.
For each source record the canonical repository/version, owner, access scope, destination, and disposition (canonical, merge, history, human arbitration, excluded with reason).
Legacy kanban and projects must not both write migrated state. Old imports do not run or notify anyone. Customer data is excluded from the HA7CH knowledge boundary.
No history is deleted in this rollout.

## Rollback

Stop only the V4 pilot scheduler. Preserve the V4 outbox, thread bindings and receipts for reconciliation. Do not replay V4 side effects through V2/V3.
Keep production routing unchanged until exclusive pilot routing is verified. A deploy failure does not authorize restarting unrelated services or resetting sessions.
