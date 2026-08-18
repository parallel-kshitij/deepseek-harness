# Agent Note: ParallelLoop runtime parity over DeepSeek Harness

Status: implemented

Release certification: incomplete

English | [中文](2026-08-18-parallelloop-runtime-parity.zh.md)

## Problem

ParallelLoop's Agents SDK currently has production runtime adapters for Claude Agent SDK and Pi. Its provider-neutral intelligence plane also owns capabilities that are not model-loop concerns: command dispatch, Celery orchestration, Redis event delivery, workspace isolation, artifact journaling, memory jobs, git synchronization, webhooks, authentication, and control-plane integration.

DeepSeek Harness already implements a broad agent kernel: durable sessions, scoped prompt and tool composition, cancellation and steering, model routing, compaction, persistence, MCP, hooks, skills, approvals, sandboxes, subagents, background jobs, workflows, attachments, LSP, web tools, telemetry, web UI, and Python and TypeScript SDKs. However, its out-of-process SDK protocol exposes only process initialization, prompt enqueue, and shutdown. Core capabilities such as cancellation, steering, persisted resume, session disposal, per-agent persona and tool restriction, reasoning selection, and root structured output cannot currently be controlled through that boundary.

Treating parity as "copy every ParallelLoop service into DeepSeek Harness" would duplicate infrastructure and create two conflicting owners. Treating parity as "the model can answer a prompt" would silently drop production behavior. The integration needs a system-level definition of parity and an executable ledger that distinguishes kernel work from adapter work and retained platform work.

## Current-system capability inventory

The inventory below is the parity contract. "Native" means the official harness already owns the behavior. "Bridge" means a narrow SDK protocol or Agents SDK adapter must expose it. "Platform" means the existing provider-neutral Agents SDK implementation remains authoritative. "Gap" means implementation and proof are required before the DeepSeek provider may claim support.

### Runtime lifecycle and stream

| Capability | Claude/Pi behavior to preserve | DeepSeek mechanism | Owner | Initial state | Required proof |
|---|---|---|---|---|---|
| Provider selection | Closed-by-default runtime selection with explicit enablement | New `deepseek` provider registration | Bridge | Gap | Selection and default-off tests |
| Process startup | Isolated runtime per execution or managed warm holder | SDK JSON-RPC subprocess and bundled runtime | Bridge | Partial | Startup, handshake, stderr, and teardown tests |
| Warm reuse | Reuse a healthy process without leaking run state | One SDK process, independent session ids | Bridge | Gap | Sequential and concurrent-session tests |
| Prompt enqueue | Identified durable user message | `session/prompt` and inbox receipt | Native | Present | Protocol and adapter tests |
| Text streaming | Incremental assistant deltas | `session.event` text chunks/deltas | Bridge | Present | Frozen `StreamDelta` translation tests |
| Reasoning streaming | Incremental thinking without merging it into answer text | Reasoning chunk events | Bridge | Present | Frozen `ThinkingMessage` tests |
| Tool lifecycle | Tool start, input, result, and failure activity | Durable tool-call/result events | Bridge | Present | Ordered translation and activity tests |
| Usage | Input, output, cache-read, and cache-write tokens | `TokenUsage` on model events | Bridge | Present | Accumulation and final-result tests |
| Cost | Stable run-level cost where pricing is known | Usage plus provider/model price catalog | Bridge | Gap | Exact arithmetic and unknown-price tests |
| Final result | Exactly one provider-neutral result after stream completion | Receipt-to-idle owned interval | Bridge | Partial | SYSTEM-first/RESULT-last contract tests |
| Finish reason | Completed, max-token, aborted, refused, or error | Durable `turn/end.reason` | Bridge | Present | Mapping table tests |
| Maximum turns | Hard provider-neutral turn cap | Agent pre-step/turn policy or adapter cancellation | Bridge | Gap | Boundary and cancellation tests |
| Cancellation | Abort active work and optionally clear queued work | `Agent.cancel()` | Bridge | SDK gap | Mid-model, mid-tool, and idle-race tests |
| Steering | Inject user guidance at the next step | `Agent.steer()` | Bridge | SDK gap | Running and idle steering tests |
| Context injection | Add next-step context without waking idle work | `Agent.inject()` | Bridge | SDK gap | Running and parked injection tests |
| Session close | Dispose one session without shutting down the runtime | Owned `AgentHandle.dispose()` | Bridge | SDK gap | Idempotence and no-cross-session tests |
| Runtime shutdown | Drain sessions, plugins, persistence, and child process | SDK `shutdown` plus client reap ladder | Native | Present | Quiescent teardown tests |
| Watchdog | Bound stalled runtime activity | `BaseRuntimeProvider` watchdog | Platform | Present | Existing base-provider suite plus DeepSeek composition |
| Circuit breaker | Stop dispatching to a repeatedly failing backend | `BaseRuntimeProvider` breaker | Platform | Present | Existing base-provider suite plus selection tests |
| Neutral errors | Stable provider-independent error envelope | Base provider error normalization | Platform | Present | Error mapping tests without provider class leakage |

### Conversation, model, and output contract

| Capability | Claude/Pi behavior to preserve | DeepSeek mechanism | Owner | Initial state | Required proof |
|---|---|---|---|---|---|
| Workspace cwd | Absolute workspace identity for every session and tool | Session header `cwd` | Native | Present | Path round-trip and subprocess tests |
| System prompt | Per-run prompt and append-system-prompt semantics | Agent-scoped system-prompt section/persona | Bridge | SDK gap | Complete and additive prompt snapshots |
| Model selection | Explicit provider and model | Agent options plus `agent/request` | Native | Present | Request-header assertion |
| Reasoning effort | Provider-supported effort chosen per run | `ReasoningEffortId` and model selection | Bridge | SDK gap | Supported/unsupported effort tests |
| Output token cap | Explicit model-output budget | `AgentOptions.maxTokens` | Native | Present | Existing SDK max-token tests |
| Budget cap | Stop before exceeding a run cost budget | Usage/cost observer plus cancellation | Bridge | Gap | Pre-dispatch and in-run budget tests |
| Structured output | JSON Schema-conformant authoritative final value | Scoped `structured_output` tool and validator | Bridge | Root SDK gap | Valid, retry, invalid, and Code Mode tests |
| Images and attachments | Content blocks survive without lossy text conversion | DSH content blocks and attachment stores | Bridge | Present | Image/file block round-trip tests |
| Compaction | Bounded context with durable reconstructability | Compaction plugins and checkpoints | Native | Present | Existing snapshots plus adapter resume test |
| Resume in-process | Continue a known warm session | Server session map | Native | Present | Multi-turn history test |
| Resume after restart | Load a persisted session by stable id | `ctx.agents.resume()` and persistence backend | Bridge | SDK gap | Cold-restart transcript continuity test |
| Transcript mirror | Preserve provider-neutral memory and eval inputs | Durable event log translated by adapter | Bridge | Gap | Complete-message mirror and ordering tests |
| Model switching | Change route at a logged step boundary | Scoped model selection / `agent/request` | Bridge | SDK gap | Request-header change test |

### Tools, extensions, and delegated work

| Capability | Claude/Pi behavior to preserve | DeepSeek mechanism | Owner | Initial state | Required proof |
|---|---|---|---|---|---|
| Built-in file and shell tools | Read, edit, search, execute, and persistent shell state | DSH tool plugins and Code Mode | Native | Present | Profile composition snapshot |
| Allowed/disallowed tools | Honest per-run tool filtering | Agent-scoped `tools.restrict()` | Bridge | SDK gap | Unknown-tool fail-loud and allow/deny tests |
| Custom tools | Provider-neutral tool invocation | Cordis tool service | Native/Bridge | Partial | Adapter-side registration strategy and composition test |
| MCP stdio | External tools over child processes | MCP client stdio transport | Native | Present | Real-process composition test |
| MCP HTTP | External tools over Streamable HTTP with reconnect | MCP client HTTP transport | Native | Present | Auth, reconnect, and schema tests |
| Hook lifecycle | Pre/post tool, prompt, stop, and notification policy | Claude Code/Codex hook bridges and Cordis events | Native/Bridge | Partial | Event mapping and failure-policy tests |
| User approvals | Ask/allow/deny with durable tool outcomes | User-approval and sandbox-policy plugins | Native | Present | Approval composition test |
| Filesystem sandbox | Kernel/platform restrictions around executable tools | bwrap, Landlock, Seatbelt, Windows ACL plugins | Native/Platform | Present | No-broader-than-outer-policy security tests |
| Subprocess environment | Secret-stripped allowlisted environment | Agents SDK environment seam plus explicit child env | Platform/Bridge | Gap | Security skill A6 tests and leak canary |
| Skills | Discover, validate, select, and load skill instructions | DSH skill plugins and ParallelLoop skill pipeline | Native/Platform | Present | Discovery and selected-skill composition test |
| Web search/fetch | Search and retrieve web content | DSH web tools | Native | Present | Keyless mocked composition test |
| LSP | Code intelligence exposed as tools/context | DSH LSP plugins | Native | Present | Profile composition test |
| Subagents | Spawn/fork/continue children with depth, tools, persona, schema | In-process and external subagent providers | Native | Present | Parent/child lifecycle and structured-output tests |
| Background jobs | Start, poll, and collect delegated work | DSH jobs and subagent continuation tools | Native | Present | Job ownership and cancellation tests |
| Workflows | Multi-agent graphs, Ralph loops, goal/plan/todo | Workflow and goal plugins | Native/Platform | Present | Existing DSH tests; PL workflow routing unchanged |
| Schedules | Persist and trigger delayed/recurring work | Schedule plugins | Native/Platform | Present | Existing DSH tests; PL Celery ownership documented |
| Self-extension | Load/unload plugin compositions under explicit policy | Cordis loader and self-modifying tools | Native | Present | Existing HMR and invariant tests |

### ParallelLoop production plane

| Capability | Authoritative implementation | DeepSeek integration rule | Owner | Initial state | Required proof |
|---|---|---|---|---|---|
| Command registry | YAML-driven Agents SDK dispatch | No provider-specific branch outside runtime selection | Platform | Present | Existing registry suite |
| Celery queues | Nine production queues and retry policy | Runtime adapter is called by existing tasks | Platform | Present | Existing task suite |
| Chat orchestration | Universal chat flow and conversation identity | Forward run/session ids and frozen messages | Platform/Bridge | Partial | Chat-provider integration test |
| Redis streaming | Text, thinking, and activity channels | Publish translated frozen runtime messages | Platform/Bridge | Partial | Ordering and terminal-result tests |
| Memory | Memory tasks, transcript mirroring, and MCP memory tools | Reuse provider-neutral memory; DSH log is source input | Platform/Bridge | Gap | Warm and cold memory tests |
| Artifact detection | LD_PRELOAD write journal and `FilesWritten` | Preserve journal env through DSH child tree; emit one frozen event | Platform/Bridge | Gap | Write/rename/delete and child-process tests |
| Artifact registration | Existing artifact service | Consume provider-neutral `FilesWritten` unchanged | Platform | Present | Existing artifact suite plus DeepSeek event test |
| Git synchronization | ChangeLog plus periodic sync, never inline commit | No DSH git ownership | Platform | Present | Existing git-decoupling tests |
| Webhook outbox | HMAC-signed at-least-once delivery | No DSH network call to Playbook | Platform | Present | Existing outbox tests |
| Authentication and org isolation | Agents SDK request and workspace boundaries | Provider receives only resolved workspace and allowlisted env | Platform/Bridge | Gap | Cross-org negative tests |
| Control-plane seam | Central Playbook client | No inline provider HTTP | Platform | Present | Security skill A7 grep and tests |
| Observability | Langfuse/Sentry/application metrics | Add provider/model/run attributes; optionally bridge OTEL | Platform/Bridge | Gap | Trace correlation tests |
| Eval recording | Provider-neutral runtime eval record | Base provider records DeepSeek results | Platform | Present | Existing base-provider composition test |
| Egress policy | Deployment network and proxy policy | DSH config may narrow, never widen, outer policy | Platform/Bridge | Gap | Proxy and denied-destination test |

## Decision

### 1. Keep one intelligence plane

ParallelLoop remains the owner of command dispatch, work queues, auth, org boundaries, Redis delivery, memory scheduling, artifact registration, git, webhooks, observability, and control-plane calls. The DeepSeek runtime is a third provider behind the existing `AgentRuntime` seam. This preserves one implementation of every business capability and lets the same command execute on Claude, Pi, or DeepSeek without changing its orchestration.

### 2. Extend the SDK at native capability seams

Add typed, additive JSON-RPC methods rather than a ParallelLoop-specific loop fork:

- `session/open` creates or resumes one session with scoped route, persona/system-prompt, tool restrictions, and optional structured-output schema;
- `session/prompt` remains enqueue-only and keeps its durable `messageId` semantics;
- `session/steer` and `session/inject` enqueue identified next-step inputs;
- `session/cancel` invokes the core queue-aware cancellation contract;
- `session/close` disposes one server-owned handle to quiescence;
- `session.result` (notification or query) reports authoritative root structured output without inventing prompt-level causal ownership.

The server continues to stream the complete durable session vocabulary. Python and TypeScript clients expose the same methods. Protocol additions must preserve the one-send-one-turn and owned-run decisions: a prompt receipt is not a promise for one assistant answer, and high-level `run()` still owns a receipt-to-idle interval.

### 3. Add one DeepSeek provider to Agents SDK

The provider subclasses `BaseRuntimeProvider` so watchdog, circuit breaker, neutral error mapping, eval records, warm-holder policy, interruption, and steering use the existing contracts. It owns only:

- subprocess launch and allowlisted environment construction;
- typed JSON-RPC session control;
- Cordis profile/config generation for requested MCP, hooks, skills, tools, permissions, and sandbox policy;
- translation from DSH durable/live notifications to frozen `RuntimeMessageType` values;
- usage/cost accumulation, final `RuntimeResult`, transcript mirror, and artifact-journal observation;
- capability validation that rejects unsupported combinations before model I/O.

No code outside `app/runtime/providers/deepseek/` imports the DeepSeek Python SDK. Provider selection and static feature tables name the provider, but depend only on the neutral runtime vocabulary.

### 4. Ship a constrained ParallelLoop profile

The profile loads only audited official packages from the bundled runtime closure. Per-run values are data, not generated executable code. Secrets enter only through the Agents SDK allowlisted child environment or MCP credential-proxy configuration. The inner DSH sandbox may narrow the already resolved workspace policy but must never widen the outer Landlock boundary. Optional network tools default off.

### 5. Certify claims instead of inferring them

A capability may move from Gap/Partial to Present only with its listed proof. The final parity report must include:

1. DSH package unit tests with 100% per-file coverage for changed files;
2. server/client protocol tests in TypeScript and Python;
3. keyless real-composition tests using the actual Cordis loader and a fake model transport;
4. Agents SDK unit tests for every frozen message and option mapping;
5. warm, cold-resume, interrupt, steering, structured-output, MCP, artifact-journal, and memory integration tests;
6. lint, typecheck, generated-doc, translation-pair, and security gates;
7. a final ledger where no claimed capability remains Gap or Partial.

## Implementation outcome (2026-08-18, certification reopened)

The design is implemented across DeepSeek Harness and ParallelLoop Agents SDK, but it is not release-certified as complete parity. The original outcome used the narrower definition of capability-honest routing plus retention of the provider-neutral production plane. The release bar is now the behavioral union of Claude Agent SDK and Pi, exercised through the production runtime path. The machine-readable source of truth is `app/runtime/providers/deepseek/parity_contract.yaml` in Agents SDK; it must remain `incomplete` while any required capability or Linux/service/staging/eval gate is open.

### DeepSeek Harness additions

- The typed JSON-RPC boundary now supports `session/open`, persisted resume, `session/steer`, `session/inject`, `session/cancel`, `session/output`, and `session/close`. Initialization and session open carry route, output cap, reasoning effort, exact system prompt, tool restriction, and optional output schema.
- TypeScript and Python clients expose the same controls and project finish reasons and authoritative structured output.
- The reusable structured runtime can be attached to another composition; the bundled Python runtime is a complete coding profile with sandboxed shell/files, instructions, skills, persistence/checkpoints, attachments, search, goals/jobs/todo, token metering, compaction, pruning, and in-process subagents.
- MCP gained a bounded, cancellable, loopback-only host transport. A host supplies one secret-free manifest under an opaque run token; registration and disposal are atomic and tool names use the existing deterministic normalization contract.
- Hosted web search gained a separate opaque-token `WebSearchProvider`. Named agent definitions become native fixed-persona subagent tools with depth and tool filters. A read-gate bridge and the Claude Code command-hook adapter run at typed pre/post tool interception points.
- The single-executable asset closure now includes `.dylib`, `.so`, and `.dll` dependencies required by native addons such as `sharp`, closing a source-versus-packaged attachment failure found by the real executable smoke.

### Agents SDK provider truth

| Certified capability | Implementation |
|---|---|
| Streaming and final result | Durable DSH events translate to frozen message types; the identified prompt interval ends at the target session's next idle state. |
| System prompt, route, output cap, effort, thinking | Sent through typed initialize/open controls; Claude-style thinking settings map to audited effort ids. |
| Built-in tools and allowlists | Neutral names map to exact DSH names; unknown tools fail before spawn; restrictions are session-scoped. |
| Structured output | JSON Schema is installed before publication and the authoritative root value is queried after the turn. |
| Cold resume | Stable ids reopen JSONL-persisted sessions inside an organization-bound root. |
| MCP and memory tools | Host objects, credentials, denied-tool policy, and invocation stay in Python; DSH receives only an opaque token and pinned manifest. |
| Web search | A separate opaque capability reaches the existing host search service; credentials and tenant policy stay host-side. |
| Named agents | Claude-shaped definitions become native in-process profile tools with validated persona and translated tool filters. |
| Hooks | Project command hooks run through the DSH Claude Code bridge; chat read-before-write checks reuse the unchanged host read gate. |
| Skills | The selected `.claude/skills/<name>/SKILL.md` and optional command wrapper are path-validated and folded into the scoped prompt; native discovery receives the explicit skills directory. |
| Permission modes and sandbox | The inner DSH sandbox can narrow the existing outer Landlock grant but cannot widen it. |
| Steering, interruption, maximum turns, watchdog, breaker, eval | Typed steering/cancel controls compose with the existing provider-neutral base-provider mechanisms. |
| Usage, cost, memory, files | Usage/cache buckets and configured cost rates project into the frozen result; complete messages use the neutral transcript writer; DSH write/edit events emit `FilesWritten` while the artifact journal remains authoritative. |

The provider advertises exactly `streaming`, `system_prompts`, `tool_use`, `allowed_tools`, `env`, `effort`, `thinking`, `output_format`, `session_resume`, `mcp_servers`, `memory_tools`, `web_search`, `agents`, `skills_pipeline_deepseek`, `permission_modes`, and `steer`. Workspace project hooks and the read gate are always-on composition features rather than the generic per-run `hooks` selector capability. The static selection table is locked to the same set.

### Open total-parity gaps

| Capability | Final disposition |
|---|---|
| Interactive ask-user turns | Claude-only. The unattended JSON-RPC provider has no provider-neutral question/answer rendezvous, and interactive selection remains closed. |
| Arbitrary per-run Python hook callbacks | Not advertised. Project command hooks and the chat read gate are supported; Python callable objects never cross the process boundary. |
| Full Claude `setting_sources` layering | Not advertised. Explicit project skills, workspace instructions, and project hook settings are supported without claiming Claude's user/local precedence rules. |
| Raw `extra_args` | Inapplicable provider-specific escape hatch and not advertised; DSH uses typed options and audited config. |
| `fallback_model` and `max_budget_usd` cancellation | Not advertised; shared call-site options are logged as ignored so selection cannot treat them as supported semantics. |
| Warm process reuse | Not advertised. Cold processes plus persisted semantic resume are implemented; a future holder must add isolation and concurrent-session proof before changing the claim. |

Closed capability gates prevent silent degradation, but they are still total-parity gaps under the stricter release bar. Interactive questions, arbitrary per-run hooks, full settings layering, fallback/budget controls, and warm reuse must be implemented and certified—or explicitly removed from the agreed product contract—before the release can be called complete.

### Production-plane ownership retained

Command registry, Celery routing, chat orchestration, Redis publishing, memory scheduling, artifact registration, git synchronization, webhook outbox, authentication, organization isolation, control-plane calls, observability, eval records, and egress policy remain in their existing provider-neutral owners. The DeepSeek adapter produces the same frozen inputs those services already consume and adds no second writer or direct Playbook call.

### Verification evidence

The items below are implementation evidence, not sufficient end-to-end release certification. The real packaged macOS carrier now also passes the live command-registry and provider-factory path through `BaseRuntimeProvider.execute_query`, including structured output, file writes/`FilesWritten`, and cold resume after process restart. Production Linux, real platform services, staging model/bridge traffic, and comparative eval remain mandatory open gates.

- DeepSeek host TypeScript build, Cordis config validation, runtime-closure validation, and package-invariant validation pass.
- MCP direct transports plus host transport, hosted web search, named subagent profiles, read-gate hooks, protocol/server/client, and Python SDK targeted suites pass.
- The rebuilt 215.5 MB macOS ARM64 single executable passes all keyless packaged-runtime scenarios, including the default profile, custom profile, persistent shell/editor, advanced subagent/workflow snapshot, and direct JSON-RPC path.
- The Agents SDK DeepSeek provider, protocol, selection, routing, environment, MCP lifecycle, and frozen-event suites pass 190 focused tests. A real provider run through the rebuilt executable and a local SSE endpoint emits `SystemMessage`, `StreamDelta`, `UsageUpdate`, `AssistantMessage`, and `ResultMessage` in order.

## Consequences

- DeepSeek becomes a first-class runtime, not a thin chat-completions adapter.
- DSH's scoped plugin model gives each session isolated persona, tools, policies, and child agents within a reusable SDK process. The ParallelLoop provider intentionally starts a cold process per run until a future holder proves concurrent-session isolation.
- Its append-only event log gives stronger resume, audit, and compaction foundations than reconstructing state from UI deltas.
- Native MCP, hooks, sandbox, subagent, workflow, attachment, LSP, and web packages remove large amounts of provider-specific glue.
- The same official SDK protocol serves ParallelLoop, Python users, TypeScript users, and DSH-as-subagent composition.
- Platform capabilities keep one owner, so DeepSeek gains production parity without forking git, Redis, memory, webhook, or auth behavior.
- The explicit ledger makes unsupported behavior fail before execution instead of silently degrading.

## Alternatives considered

**Fork the DSH loop and put ParallelLoop services inside it.** This duplicates business infrastructure, violates the plugin extension rule, and makes provider changes capable of bypassing org, git, webhook, and control-plane guarantees.

**Drive only `session/prompt` and kill the subprocess for cancellation.** This loses warm-session isolation, steering, persisted resume, scoped tools, and structured output, and turns routine cancellation into whole-runtime failure.

**Generate a bespoke `cordis.yml` for every semantic operation.** Composition should select audited plugins; live session controls belong on typed services. Encoding cancellation, steering, or secret values as YAML makes ownership and validation weaker.

**Claim native DSH features as automatic parity.** A capability unreachable from the SDK boundary is not available to ParallelLoop. Presence in a package is evidence for the mechanism, not proof of integration.

## Testing

- The Agents SDK parity contract currently records 70 capabilities and intentionally keeps the release status `incomplete` while required entries or release gates are open.
- DeepSeek is closed-by-default, explicitly selectable, and capability-honest in Agents SDK.
- The packaged carrier has command-level proof for selection, dispatch, streaming, usage, structured output, file writes, cleanup, and cold resume; cancellation, steering, injection, and cross-session isolation still require carrier-level certification.
- System prompt, tool restrictions, reasoning effort, MCP, skills, hooks, sandbox policy, attachments, subagents, and compaction retain source-level evidence but are not promoted to release-certified until their required contract tiers pass.
- All frozen runtime message types preserve their existing string values and ordering contracts.
- Memory, artifact journal, Redis, Celery, webhook, auth, org isolation, and related provider-neutral services still require a real DeepSeek platform-services run; provider neutrality alone is not counted as path proof.
- The provider-neutral memory mirror rejects path-shaped provider or session identities before any host-side transcript write.
- Python and TypeScript SDK clients remain behaviorally aligned and their public docs are updated in English and Chinese.
- DSH package invariants, full coverage thresholds, snapshots, generated docs, translation pairing, lint, and typecheck pass.
- Focused Agents SDK tests, Ruff lint/format, and the opt-in real-carrier suite pass. Broader repository results with deployment-related failures and an unavailable Pyright binary are evidence, not a green release gate.

## Risks

The runtime closure is large, so image size and cold-start time may be materially higher than Pi. A warm holder reduces latency but increases lifecycle and isolation obligations. Running an inner DSH sandbox under the existing outer Landlock boundary can create confusing failures unless policy is monotonic and diagnostics name both layers. Durable session ids are security-sensitive and must be bound to the same organization, project, conversation, and provider route. The SDK protocol is pre-release, but additive control methods still require simultaneous server, Python, TypeScript, runtime-closure, docs, and snapshot updates. Finally, DeepSeek model behavior and tool-use constraints can differ from Claude or Pi; protocol parity does not by itself guarantee equal task quality, so eval comparison remains a release gate.
