# Agent Note: Subagent tool-call links on the SDK protocol

Status: implemented

English | [中文](2026-09-27-subagent-tool-call-links.zh.md)

## Problem

The SDK server already streams every child session's `session.event` notifications, tagged with the child's `sessionId`, and announces each child with `subagent.started {parentSessionId, childSessionId}`. A host that renders delegations still cannot tell which of the parent's tool calls a child belongs to. The parent's `tool/call` carries a `callId`; nothing on the wire carries that `callId` together with the child session id. When one assistant message starts several delegations in parallel, a host has no reliable way to attach each child's live transcript to the tool call that started it, and matching by timing or label is guesswork.

The child's durable `subagent/descriptor` is not a suitable carrier: it is persisted, its version is checked exactly on read, and the call id is a property of the parent's execution, not of the child's durable identity.

## Decision

The link is an observe-only lifecycle fact that crosses the process boundary as its own notification.

- `SubagentStartRequest.originCallId?: CallId` names the model tool call that requested a one-shot delegation. `dsh-tool-subagent` sets it to the executing call's `exec.callId` on every route; `tool-subagent-profiles` inherits it through the shared `apply`. The value is not model-visible, not persisted, and providers do not act on it.
- `SubagentRuntime.start()` passes it to the one-shot run observer, which copies it onto both `SubagentRunInfo` and `SubagentRunEndInfo` as `originCallId`. Continuable Activation epochs never carry one.
- The SDK server listens to `subagent/start` and, for a `local` run with an `originCallId`, sends `subagent.linked {parentSessionId, childSessionId, toolCallId}`. `subagent.finished` repeats `toolCallId` for the same runs. The locality rule is the one `subagent.finished` already uses.
- `initialize` returns `capabilities: { subagentLinks: true }`, so a host can distinguish a server that never links from a delegation that was not linked.
- The TypeScript and Python clients include `subagent.linked` in session-tree subscriptions under the same parent/child rule as the other lineage notifications. The TypeScript client reports an absent capability as `false`; the Python `InitializeResponse.capabilities` is `None` for a server that sends none.

`subagent/start` fires after the provider publishes the child, so `subagent.linked` follows `subagent.started` and can follow the child's first `session.event` notifications. A host that attributes child events must hold them until the link arrives or the child finishes.

## Alternatives considered

**Add the call id to `subagent/descriptor`.** The descriptor is durable, so the field would become part of the session log and require a descriptor version change for a value no reader of the log needs. The call id also belongs to the parent's execution, not the child's identity.

**Add `toolCallId` to `subagent.started`.** That notification comes from `session/created`, which knows only the child session header. Threading the call id into session creation would put a transport concern into the session store.

**Let hosts infer the link from ordering or labels.** Parallel delegations interleave, labels are model-chosen and may repeat, and background one-shot jobs return their `tool/result` before the child starts, so neither ordering nor labels identify the call.

**Gate emission behind an `initialize` opt-in.** Clients ignore unknown notification methods and extra fields, so an opt-in adds a negotiation path without protecting any consumer. The capability flag in the `initialize` result is enough for a host to decide whether to wait for links.

## Consequences

Hosts can bind a child's live `session.event` stream to the parent tool call that started it without parsing tool results or guessing, which is what a per-delegation detail pane needs. The change adds one notification, one optional field on `subagent.finished`, and one `initialize` result field; no durable format changes.

Continuable children, runs a tool did not start, and remote runs are not linked, and a host that needs their attribution still has only `subagent.started`. The link can arrive after the child's earliest events, so consumers carry a small pre-link buffer. Nested calls dispatched through Code Mode link to their own `callId`, not the root model call.

## Testing

`packages/sdk/server/tests/server.spec.ts` covers the linked, unlinked, and remote cases, the ordering of `subagent.started`, `subagent.linked`, and `subagent.finished`, and the `initialize` capability. `packages/subagent/subagent/tests/service.spec.ts` covers `originCallId` on both lifecycle edges. `packages/subagent/tool-subagent/tests/tool-subagent.spec.ts` covers the foreground and one-shot background routes. `packages/sdk/client/tests/sdk-client.spec.ts` and `python/sdk/tests/test_client.py` cover tree filtering and the capability projection. The keyless `subagent-spawn-in-process` snapshot under `examples/jsonrpc-agent/tests/snapshots/` pins the assembled wire stream.
