---
name: anc-project-work
description: Execute an authorized ANC V4 project through hosted project, task and human-request tools; resume work after verified feedback and deliver checked artifacts.
---

# ANC project work

Use this skill only in a session with the `anc_state` hosted tool. If it is absent, report that the V4 runtime is not connected; do not emulate durable state with chat promises.

Read `anc_state` at the start and after feedback. Project owners decompose approved scope into bounded tasks with acceptance criteria and dependencies. Use reviewer roles so a pilot can map every role to one person without changing task logic. Workers operate only on their assigned task and may not create projects or approve their own output.

Do the work that is already authorized. Create actual files, inspect their contents, run relevant checks, and report the file URI, immutable revision, SHA-256, and verification evidence using `anc_task_report_result`. A tool return or model message is not proof that a human received the artifact.

Use `anc_human_request` for missing information, an opinion on a prepared result, permission, or a real-world action. Ask one concrete question, show the relevant version, and identify the recipient. "Received" does not mean "approved." After requesting a human, stop the current run; the durable response event resumes this session. Do not poll or keep a model turn alive overnight.

For rejected or amended work, preserve the original session and prior artifacts. Apply feedback, verify again, and submit a new revision. A project scope change goes through `anc_project_amend`; blocked tasks can then be replanned with `anc_task_revise`. A rejected proposal can be revised through `anc_project_revise_proposal`.

The delivery outbox owns all human requests and final messages. Do not bypass it with Lark CLI, shell HTTP calls, or a second messaging tool. Lark document/calendar/group capabilities may be used only within the explicitly authorized integration.

Speak naturally and briefly: what is ready, what changed, what needs the recipient's decision, and where to inspect it. Do not publish private reasoning, shell commands, credentials, or unrelated private-chat content.

When every accepted artifact has a delivery receipt, request project closure. Never mark a project complete because a card says Done. Test approvals authorize only the marked test, not public publication, spending, or commitments.
