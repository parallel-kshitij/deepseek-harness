# @deepseek-ai/dsh-sdk-jsonrpc-server

English | [中文](README.zh.md)

The `jsonrpc` plugin serves newline-delimited JSON-RPC over stdio so out-of-process SDK clients can drive harness agents. [`HarnessSdkJsonRpcServer`](src/server.ts) owns the protocol methods and notifications; the transport and the named wire types live in [`dsh-sdk-protocol`](../protocol/README.md), shared with the client SDKs; [`jsonrpc-demo`](../../examples/jsonrpc-demo/README.md) supplies the surrounding `cordis.yml` application.

## Wiring

`inject: ['agents']`. The server gets or creates one agent per `sessionId`. Explicit `session/open` composes the Agent before publication; lazy creation through `session/prompt` remains available for callers that need only deployment defaults. It forwards subagent tool-call links and completions only when the service-snapshotted lifecycle `local` flag is true; provider names, child ids, and durable lineage never establish locality. A registered adapter wins, an unowned `deepseek-official` route mounts `dsh-llm-deepseek`, and any other unowned provider fails initialization. Other capabilities come from the surrounding `cordis.yml`.

## Config

`maxTokensAsSuccess` defaults to `false` and affects only the deployment-mapped status on `subagent.finished`; root-session prompts have no prompt-level status. `JsonRpcConfig.input`, `output`, and `exit` are runtime-only transport hooks; production uses process stdio and `process.exit`.

## stdout is the protocol

Stdout carries only JSON-RPC frames. The deployment must not compose a stdout logger; diagnostics belong on stderr.

## Shutdown and exit semantics

The plugin answers `shutdown`, flushes the response, disposes the root context so SDK-owned agents, subscriptions, and persistence reach quiescence, then exits with code 0. EOF and signal exits belong to the app bin, which also disposes the root context. Unloading only this plugin stops serving without exiting the process.

## Wire notes

`initialize.serverInfo.name` is the wire-stable `deepseek-harness-sdk-runtime`, and `initialize.capabilities.subagentLinks` is `true`: when a `subagent/start` lifecycle edge carries an `originCallId`, the server sends `subagent.linked` with that id as `toolCallId`, and the paired `subagent.finished` repeats it. `initialize.capabilities.attachments` is `true`: the server's build loads `@deepseek-ai/dsh-attachment-local`, so a composition that enables it serves `read_image` and durable `image` content blocks; the value does not report whether the current composition enabled it. Optional positive `maxTokens` and non-empty `reasoningEffort` values become process defaults. `session/open` may override provider, model, output cap, and reasoning effort; install an exact agent-scoped system prompt; restrict inherited/global tools; attach an object-rooted JSON Schema; and create or resume the named persisted session. Restrictions are validated by the tool runtime: unknown global names fail session creation, while the schema-bound `structured_output` tool stays session-local and therefore remains available under an explicit allowlist.

`session/prompt`, `session/steer`, and `session/inject` each return a durable `{ messageId }` receipt. Prompt and steer wake their target; injection does not wake an idle Agent. `session/cancel` aborts one Agent and optionally keeps its inbox. `session/output` reads a committed schema-valid value, and `session/close` removes and disposes one owned Agent without affecting siblings. The server streams every durable fact as `session.event` and every whole-agent lifecycle transition as `session.status`; it does not assign an assistant message or `turn/end` to one enqueue receipt. Persistence roots and baseline persona still come from `cordis.yml`.

## Model Experience

### SDK user message

#### What the model sees

For each accepted `session/prompt`, the conversation model receives the caller-supplied `contentBlocks` verbatim as one user message in that SDK session. This package adds no system-prompt prose or tool schema; those come from the plugins in the surrounding `cordis.yml`.

#### Token effect

Data-dependent user-message tokens enter retained session history and are resent on later turns until another package compacts them. The JSON-RPC frames, session notifications, and server bookkeeping add zero model-context tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Per-session composition

#### What the model sees

When supplied, `session/open.systemPrompt` replaces the deployment persona section for that Agent. `allowedTools` removes unlisted inherited/global tool schemas and execution capabilities. `outputSchema` adds the scoped `structured_output` schema plus its completion instruction; a successful call concludes the turn and makes the validated value readable only through `session/output`.

#### Token effect

The selected system prompt, surviving tool schemas, and optional structured-output instruction/schema are fixed per-session request-prefix costs. User, assistant, and tool-result content remains data-dependent durable history.

#### KV Cache effect

Stable for later steps of the same session. Changing persona, tools, model selection, reasoning effort, or output schema requires opening a differently composed Agent and may invalidate the affected prefix.

## Known Limitations and Deferred Work

- **There is no per-prompt result** — `MessageId` identifies inbox admission only; clients that own an automation interval must define and observe that interval themselves.
- **stdout purity is deployment-enforced** — a surrounding config can still load a stdout logger and corrupt the JSON-RPC channel; this plugin does not inspect or veto sibling loggers.
- **Automatic adapter mounting is DeepSeek-specific** — `initialize` can reuse any pre-registered model adapter, but its only fallback mounts `dsh-llm-deepseek`.
