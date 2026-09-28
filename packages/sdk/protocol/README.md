# @deepseek-ai/dsh-sdk-protocol

English | [中文](README.zh.md)

The shared wire protocol for the DeepSeek Harness SDK runtime: one newline-delimited JSON-RPC 2.0 transport class plus the named request, result, and notification types both wire ends speak. The package root enumerates the protocol consumer interface; source modules are not exported as deep imports. The server side is the [`dsh-sdk-jsonrpc-server`](../server/README.md) plugin; clients are [`dsh-sdk-client`](../client/README.md) (TypeScript) and the [Python SDK](../../../python/README.md) (which mirrors these shapes but does not import them). A pure library — no plugin, no Config, no registration.

## Transport

`JsonRpcLineTransport` frames JSON-RPC 2.0 over caller-owned byte streams, one compact JSON frame per `\n`-terminated line. Frames with `id` and `method` are requests, `id` alone is a response, `method` alone is a notification; malformed JSON lines are ignored. `start()` attaches stream listeners, `close()` detaches them and rejects pending requests without destroying the streams. Missing request handlers answer `-32601`; handler rejections answer `-32603` with the error message. An error response rejects the pending `request()` with `JsonRpcResponseError`, which preserves the wire `code` and optional `data`. `JsonRpcTransportPeer` is the outbound surface (request/notify) the server class is typed against.

## Wire types

`types.ts` names every payload of the protocol served by `HarnessSdkJsonRpcServer`:

| Direction | Method | Types |
|---|---|---|
| client→server | `initialize` | `InitializeParams` → `InitializeResult` |
| client→server | `session/open` | `SessionOpenParams` → `SessionOpenResult` |
| client→server | `session/prompt` | `SessionPromptParams` → `SessionPromptResult` (durable enqueue receipt) |
| client→server | `session/steer` | `SessionInputParams` → `SessionInputResult` (wake the session) |
| client→server | `session/inject` | `SessionInputParams` → `SessionInputResult` (do not wake an idle session) |
| client→server | `session/cancel` | `SessionCancelParams` → `{}` |
| client→server | `session/output` | `SessionTargetParams` → `SessionOutputResult` |
| client→server | `session/close` | `SessionTargetParams` → `SessionCloseResult` |
| client→server | `shutdown` | no params → `{}` |
| server→client | `session.event` | `SessionEventNotification` (every session in the runtime, unfiltered) |
| server→client | `session.status` | `SessionStatusNotification` (whole-agent `running`/`idle` transition) |
| server→client | `subagent.started` | `SubagentStartedNotification` |
| server→client | `subagent.linked` | `SubagentLinkedNotification` (in-process one-shot runs a tool call started) |
| server→client | `subagent.finished` | `SubagentFinishedNotification` (in-process runs only) |

`HarnessSdkRequestMap` and `HarnessSdkNotificationMap` index these by method name. `session/open` publishes a fresh or persisted Agent before it can be driven and may scope provider, model, output cap, reasoning effort, exact system prompt, inherited/global tool allowlist, and an object-rooted structured-output schema. A schema installs a session-local `structured_output` capability; it is deliberately not named in the global allowlist. `session/output` returns only a value that completed that real tool pipeline and schema validation. `session/close` is idempotent and disposes only its target Agent.

`SessionPromptResult.messageId` and `SessionInputResult.messageId` identify queued `UserMessage`s; they do not identify a later assistant message, turn ending, or prompt result. `steer` wakes its target, while `inject` contributes context to the next step without waking an idle Agent. `cancel.keepInbox` selects whether queued work survives active-work cancellation. Clients combine the open-ended `session.event` stream with agent-wide `session.status` according to their own activity ownership. `SubagentLinkedNotification.toolCallId` names the delegating session's `tool/call` `callId` that started the child; it is sent after that child's `subagent.started`, may follow the child's first `session.event` notifications, and precedes its `subagent.finished`, which repeats the same `toolCallId`. `InitializeResult.capabilities.subagentLinks` is `true` when the server sends these links. `InitializeResult.capabilities.attachments` is `true` when the server's build can load the durable attachment store; it describes the build, not the current composition. `SubagentFinishedNotification.lastAssistantMessage` contains the child's last non-empty assistant message or, when no such message exists, its accumulated assistant text; the field is absent when the child produced neither. `InitializeParams.maxTokens` is an optional positive safe integer that caps each conversation-model output for SDK-created agents and their in-process descendants; omission allows the selected adapter's exact-model default to apply, or otherwise preserves provider behavior. `InitializeParams.reasoningEffort` supplies the process default, while `session/open.reasoningEffort` may override it for one Agent. The notification payload types depend on `SessionEvent` (`dsh-session`), `ContentBlock` (`dsh-llm`), and `SubagentStopReason` (`dsh-subagent`) — the protocol streams full session-log envelopes, so the session vocabulary is part of the wire contract. `serverInfo.name` stays the wire-stable `deepseek-harness-sdk-runtime`.

## Model Experience

None, as this package defines the client-facing wire protocol; the model-visible surfaces belong to the runtime plugins composed behind the serving [`dsh-sdk-jsonrpc-server`](../server/README.md) entry.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No protocol-version negotiation** — the handshake carries only `serverInfo.version` (`0.0.1`, unvalidated by clients) and the `capabilities` feature flags; pre-release stance, no compatibility promise.
- **Only one-shot children are linked to a tool call** — continuable children, runs started without a tool call, and remote runs send no `subagent.linked`.
- **No per-prompt result object** — prompt and input methods are enqueue receipts; high-level clients own receipt-to-idle activity intervals and read durable turn endings.
- **Server→client requests are dead capability** — the transport supports them, but the server never sends one; the Python SDK's responder surface exists for future approval flows.
