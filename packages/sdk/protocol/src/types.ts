/**
 * Named wire types for the DeepSeek Harness SDK runtime protocol: the typed
 * request/result pairs and the five server-to-client notification payloads
 * exchanged over the newline-delimited JSON-RPC stdio transport. The server
 * plugin (`@deepseek-ai/dsh-sdk-jsonrpc-server`) and SDK clients share these shapes;
 * `serverInfo.name` stays the wire-stable `deepseek-harness-sdk-runtime`.
 *
 * @module @deepseek-ai/dsh-sdk-protocol/types
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'

/** Parameters for the process-wide SDK handshake. */
export interface InitializeParams {
  /** Working directory recorded on every SDK-created session's header. */
  cwd: string
  /** Provider route every SDK-created agent runs on. */
  provider: string
  /** Model name every SDK-created agent runs on (the server may mount a fallback adapter; see `HarnessSdkJsonRpcServer.initialize`). */
  model: string
  /** Optional positive output-token cap inherited by SDK-created agents and their in-process descendants. */
  maxTokens?: number
  /** Optional adapter-owned reasoning effort inherited by SDK-created agents. */
  reasoningEffort?: string
}

/** Wire-stable server identity returned by initialization. */
export interface InitializeResult {
  /** Wire-stable server identity (`deepseek-harness-sdk-runtime`) and version. */
  serverInfo: { name: string; version: string }
  /** Optional protocol features this server emits. */
  capabilities: ServerCapabilities
}

/** Optional protocol features a server advertises at initialization. */
export interface ServerCapabilities {
  /**
   * The server sends `subagent.linked` for every in-process one-shot child a
   * tool call started, and `subagent.finished` carries that call's `toolCallId`.
   */
  subagentLinks: boolean
  /**
   * The server's build loads `@deepseek-ai/dsh-attachment-local`, including
   * its native image decoder in a packaged executable. A composition that
   * enables that plugin serves durable `image` content blocks and the
   * `read_image` tool. The value describes the build, not whether the current
   * composition enabled the attachment store.
   */
  attachments: boolean
}

/** One user turn on one SDK session. */
export interface SessionPromptParams {
  /** The SDK-side session id; an unknown id lazily creates the agent+session pair. */
  sessionId: string
  /** The prompt content blocks, sent verbatim as the user message. */
  contentBlocks: ContentBlock[]
}

/** Durable enqueue receipt for one prompt. */
export interface SessionPromptResult {
  /** Identity of the queued user message. */
  messageId: string
}

/** Per-session composition applied before a new or resumed Agent is published. */
export interface SessionOpenParams {
  /** Stable session identity to create or recover from the configured persistence backend. */
  sessionId: string
  /** Load an existing persisted session instead of creating a fresh log. */
  resume?: boolean
  /** Optional provider route overriding the process-wide initialized route. */
  provider?: string
  /** Optional model overriding the process-wide initialized model. */
  model?: string
  /** Optional positive output-token cap overriding the process-wide initialized cap. */
  maxTokens?: number
  /** Optional adapter-owned reasoning effort overriding the process-wide initialized effort. */
  reasoningEffort?: string
  /** Exact system prompt for this Agent; omission preserves deployment composition. */
  systemPrompt?: string
  /** Exact global-tool allowlist for this Agent; unknown names fail session creation. */
  allowedTools?: string[]
  /** Optional object-rooted JSON Schema for this session's authoritative structured output. */
  outputSchema?: Record<string, unknown>
}

/** Result of publishing one explicitly opened SDK session. */
export interface SessionOpenResult {
  /** Stable identity shared by the live Agent and session log. */
  sessionId: string
  /** Whether the live Agent was created from a new log or recovered from persistence. */
  disposition: 'created' | 'resumed'
}

/** Identified next-step input for a live SDK session. */
export interface SessionInputParams {
  /** Target live SDK session. */
  sessionId: string
  /** Content blocks delivered verbatim in the identified user message. */
  contentBlocks: ContentBlock[]
}

/** Durable enqueue receipt for steering or injected context. */
export interface SessionInputResult {
  /** Identity of the queued user message. */
  messageId: string
  /** True when steering woke an Agent that was idle at admission time. */
  wokeIdle?: boolean
}

/** Queue-aware cancellation of one live SDK session. */
export interface SessionCancelParams {
  /** Target live SDK session. */
  sessionId: string
  /** Preserve pending inbox work while aborting the active activity. */
  keepInbox?: boolean
}

/** Parameters for a method targeting one live SDK session. */
export interface SessionTargetParams {
  /** Target live SDK session. */
  sessionId: string
}

/** Idempotent per-session close result. */
export interface SessionCloseResult {
  /** True when this call owned and disposed a live server session. */
  closed: boolean
}

/** Current authoritative structured-output state for one session. */
export interface SessionOutputResult {
  /** Whether the scoped structured-output tool has committed a valid value. */
  available: boolean
  /** Committed JSON value; present exactly when `available` is true. */
  structuredOutput?: unknown
}

/** Deployment-mapped SDK outcome: `ok` for an accepted result, `error` otherwise. */
export type SdkRunStatus = 'ok' | 'error'

/** `session.event` payload: one session-log event, streamed as it is recorded. */
export interface SessionEventNotification {
  /** Session the event belongs to (every session in the runtime, not only SDK-created ones). */
  sessionId: string
  /** The full session-log event envelope. */
  event: SessionEvent
}

/** Whole-agent lifecycle state for one session. */
export interface SessionStatusNotification {
  /** Session whose live agent changed status. */
  sessionId: string
  /** The whole-agent state after the transition. */
  status: 'idle' | 'running'
}

/** `subagent.started` payload: an in-runtime child session was created. */
export interface SubagentStartedNotification {
  /** The delegating session. */
  parentSessionId: string
  /** The new child session. */
  childSessionId: string
}

/**
 * `subagent.linked` payload: an in-process one-shot child was published for a
 * parent tool call. Sent after that child's `subagent.started` and before its
 * `subagent.finished`; the child's earliest `session.event` notifications may
 * precede it. Runs no tool call started, remote runs, and continuable children
 * are not linked.
 */
export interface SubagentLinkedNotification {
  /** The delegating session. */
  parentSessionId: string
  /** The child session. */
  childSessionId: string
  /** The delegating session's tool call (`tool/call` `callId`) that started the child. */
  toolCallId: string
}

/** `subagent.finished` payload: an in-process subagent run ended (remote runs are not reported). */
export interface SubagentFinishedNotification {
  /** Subagent provider name that ran the child. */
  provider: string
  /** The child agent's id (equals {@link childSessionId} for local runs). */
  agentId: string
  /** The delegating session. */
  parentSessionId: string
  /** The child session. */
  childSessionId: string
  /** Deployment-mapped run outcome. */
  status: SdkRunStatus
  /** The provider-reported stop reason. */
  stopReason: SubagentStopReason
  /** The child's selected assistant output; absent when the child produced none. */
  lastAssistantMessage?: ContentBlock[]
  /** The tool call that started the child, as in {@link SubagentLinkedNotification}; absent when the run was not linked. */
  toolCallId?: string
}

/** Server-to-client notifications by JSON-RPC method name. */
export interface HarnessSdkNotificationMap {
  'session.event': SessionEventNotification
  'session.status': SessionStatusNotification
  'subagent.started': SubagentStartedNotification
  'subagent.linked': SubagentLinkedNotification
  'subagent.finished': SubagentFinishedNotification
}

/** Client-to-server request methods with their param and result shapes. */
export interface HarnessSdkRequestMap {
  'initialize': { params: InitializeParams; result: InitializeResult }
  'session/open': { params: SessionOpenParams; result: SessionOpenResult }
  'session/prompt': { params: SessionPromptParams; result: SessionPromptResult }
  'session/steer': { params: SessionInputParams; result: SessionInputResult }
  'session/inject': { params: SessionInputParams; result: SessionInputResult }
  'session/cancel': { params: SessionCancelParams; result: Record<string, never> }
  'session/output': { params: SessionTargetParams; result: SessionOutputResult }
  'session/close': { params: SessionTargetParams; result: SessionCloseResult }
  'shutdown': { params: undefined; result: Record<string, never> }
}
