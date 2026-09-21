# ANC project boundaries: internal work is not external delivery

Alternative refinement of PR #1, based on `3d6ad563`. This reuses the existing
OpenTag runtime, store, effect runner, identity checks, artifact verification and
transports. It does not replace the runtime with OpenClaw or Hermes, introduce a
workflow language, or claim that the live Feishu pilot is connected.

## Mechanism versus project policy

The runtime owns durable facts, scoped commands, human identity, versions and
receipts. The agent and Skill own decomposition and working methods within the
approved scope. Two explicit task modes avoid forcing every internal step through
file creation, human review and a message send:

| Task mode | Completion | Dependency is satisfied by | External publication |
| --- | --- | --- | --- |
| omitted / `deliverable` | Verified artifact, human review, receipted send | `delivered` | Existing version-bound approval path |
| `internal` | `task.complete_internal` with a working summary | `completed` | Never scheduled by internal completion |

Internal tasks are opt-in, not a way to mark an existing deliverable approved.
Task mode is immutable. The tool rejects internal completion for a deliverable
and rejects the artifact-report/publication path for an internal task. An internal
summary is a model-produced working result, not independently verified business
truth. Final deliverables still require the normal file and human checks.

Use durable tasks for meaningful work or handoffs, not for every tool call.
A worker sees results only from its declared direct dependencies; sibling sessions,
private conversations and unrelated project state are not added to its view.
Missing inputs still use the same verified human-request/resume mechanism.

## Trusted, persisted admission

`AncLoopOptions.projectPolicy(projectId)` may return `existingGroupId` and
`allowInternalTasks`. Resolve both from verified admission/operator configuration,
not from model text or unverified message parameters. The transport must validate
that the existing group belongs to the authorized tenant and destination scope.
The callback is evaluated once for a new project, validated and saved with it.
Changing process configuration does not silently change an existing project's policy.

```ts
const pilotPolicies = new Map([
  ["pilot_quote", { existingGroupId: "oc_verified_pilot_chat", allowInternalTasks: true }],
]);
const loop = new AncProjectLoop(store, {
  verifyArtifact,
  retainArtifact,
  projectPolicy: (projectId) => pilotPolicies.get(projectId),
});
```

Without a policy, the strict pilot behavior remains: new group, reviewed file
milestones, receipted delivery. With an admitted existing group, start approval
wakes the same owner (or creates its session) without creating another group.
Start, amendment, recipient/version checks and explicit closure are not bypassed.
Closure requires all internal work completed and all external work delivered.

## Presentation is optional

The card publisher remains available, unchanged, for compositions needing it.
A minimal composition can omit the optional public-card event sink while retaining
human-request and final-artifact delivery through the effect outbox. Do not install
another listener or let legacy CLI replies and the ANC outbox own the same input.
This change deliberately does not add another scheduler, database or message ledger.

## Compatibility and verification

Old snapshots without a policy remain strict. New dispatch fields are optional,
not default-injected into old commands, preserving existing event digests on replay.
Snapshots containing internal tasks require this reader; do not roll an enabled
pilot back to the older reader. Keep the pilot state separate and reconcile it.
No existing tenant, production process or historical project is migrated here.

The added regression suite covers strict defaults, trusted admission, restart,
legacy digests, internal dependencies, human waits, scoped tools, external revision
and delivery, explicit closure, and attempts to bypass the new boundaries:

```sh
pnpm --filter @opentag/client exec vitest run src/__tests__/anc-project-policy.test.ts src/__tests__/anc-project-loop.test.ts --maxWorkers=1
```

Also run the repository gates in `AGENTS.md`. Mocked transport receipts are not
client receipt. The real exclusive ingress, verified callbacks, readable file
receipt and restart acceptance gates in `anc-v4-pilot.md` remain necessary.
