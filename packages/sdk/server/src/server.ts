/**
 * JSON-RPC methods and notifications for out-of-process harness SDKs.
 * The surrounding context owns plugins, persistence, and configured adapters.
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-server/server
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import type { Agent, AgentHandle, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { carrierKeyOf, type Scoped } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import type SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import {
  attachStructuredRuntime,
  type StructuredAttachment,
} from '@deepseek-ai/dsh-subagent-in-process-driver'
import { PERSONA_ORDER, PERSONA_SECTION } from '@deepseek-ai/dsh-system-prompt'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import type {
  InitializeParams,
  InitializeResult,
  JsonRpcTransportPeer,
  SessionCancelParams,
  SessionCloseResult,
  SessionEventNotification,
  SessionInputParams,
  SessionInputResult,
  SessionOpenParams,
  SessionOpenResult,
  SessionOutputResult,
  SessionPromptParams,
  SessionPromptResult,
  SessionTargetParams,
  SubagentFinishedNotification,
  SubagentLinkedNotification,
  SubagentStartedNotification,
} from '@deepseek-ai/dsh-sdk-protocol'

interface SessionRecord {
  handle: AgentHandle
  structured?: StructuredAttachment
}

/** Recover the delegating parent from the service-owned scoped carrier. */
function subagentParentOf(carrier: Scoped<SubagentRuntime>): Agent {
  return carrierKeyOf(carrier) as Agent
}

/** Deployment-specific status mapping for SDK turn and subagent outcomes. */
export interface HarnessSdkJsonRpcServerOptions {
  /** Report max-token termination as an accepted result instead of an infrastructure error. */
  maxTokensAsSuccess?: boolean
}

function successStatus(reason: string, options: HarnessSdkJsonRpcServerOptions): 'ok' | 'error' {
  if (reason === 'completed') return 'ok'
  return reason === 'max-tokens' && options.maxTokensAsSuccess === true ? 'ok' : 'error'
}

/**
 * SDK server over one booted harness context and transport peer. Construction
 * subscribes to session, agent, and subagent lifecycle events until shutdown;
 * reinitialization is unsupported.
 */
export class HarnessSdkJsonRpcServer {
  private cwd = process.cwd()
  private provider = 'deepseek-official'
  private model = 'deepseek-official'
  private maxTokens: number | undefined
  private reasoningEffort: string | undefined
  private llmFiber: { dispose(): Promise<void> } | undefined
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly sessionCreations = new Map<string, Promise<SessionRecord>>()
  private readonly disposers: (() => void)[] = []
  private shutdownTask: Promise<Record<string, never>> | undefined
  private shuttingDown = false

  constructor(
    private readonly ctx: Context,
    private readonly transport: JsonRpcTransportPeer,
    private readonly options: HarnessSdkJsonRpcServerOptions = {},
  ) {
    const serverOptions = this.options
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const payload: SessionEventNotification = { sessionId: String(session.id), event }
      this.transport.notify('session.event', payload)
    }))
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      this.transport.notify('session.status', { sessionId: String(agent.session.id), status })
    }))
    this.disposers.push(ctx.on('session/created', (session) => {
      const parentSession = session.header.parentSession
      if (parentSession === undefined) return
      const payload: SubagentStartedNotification = {
        parentSessionId: String(parentSession),
        childSessionId: String(session.id),
      }
      this.transport.notify('subagent.started', payload)
    }))
    this.disposers.push(ctx.on('subagent/start', function (this: Scoped<SubagentRuntime>, info: SubagentRunInfo) {
      // The same locality rule as `subagent.finished`; a run no tool call
      // started has nothing to link.
      if (!info.local || info.originCallId === undefined) return
      const payload: SubagentLinkedNotification = {
        parentSessionId: String(subagentParentOf(this).session.id),
        childSessionId: String(info.id),
        toolCallId: String(info.originCallId),
      }
      transport.notify('subagent.linked', payload)
    }))
    this.disposers.push(ctx.on('subagent/end', function (this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo) {
      const parent = subagentParentOf(this)
      // This protocol reports only in-process child sessions. The service
      // snapshots the provider name and local flag through child disposal;
      // matching ids or parent lineage alone never establishes locality.
      if (!info.local) return
      const payload: SubagentFinishedNotification = {
        provider: info.provider,
        agentId: String(info.id),
        parentSessionId: String(parent.session.id),
        childSessionId: String(info.id),
        status: successStatus(info.stopReason, serverOptions),
        stopReason: info.stopReason,
        ...(info.lastAssistantMessage === undefined ? {} : { lastAssistantMessage: info.lastAssistantMessage }),
        ...(info.originCallId === undefined ? {} : { toolCallId: String(info.originCallId) }),
      }
      transport.notify('subagent.finished', payload)
    }))
  }

  /**
   * Configure the SDK route, mounting the DeepSeek fallback only when unowned.
   * @param params - SDK handshake parameters.
   * @returns server identity for the handshake.
   */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    assertMaxTokens(params.maxTokens, 'initialize')
    assertOptionalNonEmpty(params.reasoningEffort, 'initialize reasoningEffort')
    this.cwd = resolve(params.cwd)
    this.provider = params.provider
    this.model = params.model
    this.maxTokens = params.maxTokens
    this.reasoningEffort = params.reasoningEffort
    if (!this.hasAdapterFor(this.provider)) {
      if (this.provider !== 'deepseek-official') throw new Error(`no adapter registered for provider "${this.provider}"`)
      this.llmFiber = await this.ctx.plugin(LlmDeepSeek, {})
    }
    return {
      serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' },
      capabilities: { subagentLinks: true, attachments: true },
    }
  }

  /**
   * Publish one explicitly configured SDK session, either fresh or recovered
   * from the configured persistence backend.
   * @param params - session identity, route, and scoped composition.
   * @returns the published identity and creation disposition.
   */
  async open(params: SessionOpenParams): Promise<SessionOpenResult> {
    this.assertCanAddress(params.sessionId)
    if (this.sessions.has(params.sessionId) || this.sessionCreations.has(params.sessionId)) {
      throw new Error(`SDK session is already open: ${params.sessionId}`)
    }
    const creation = this.createSession(params)
    this.sessionCreations.set(params.sessionId, creation)
    try {
      await creation
    } finally {
      this.sessionCreations.delete(params.sessionId)
    }
    return {
      sessionId: params.sessionId,
      disposition: params.resume === true ? 'resumed' : 'created',
    }
  }

  /**
   * Queue one identified prompt without assigning later activity to it.
   * @param params - target session and user content.
   * @returns the durable message identity.
   */
  async prompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    const rec = await this.getOrCreateSession(params.sessionId)
    // An agent-loop-only reload disposes the loop's agents while this record
    // survives; a retained agent accepts followup() silently, so validate the
    // record against the live registry before delivery (as the ACP bridge does).
    if (this.ctx.agents.get(rec.handle.agent.id) !== rec.handle.agent) {
      throw new Error(`session agent was disposed outside the server: ${params.sessionId}`)
    }
    const message = createUserMessage({ content: params.contentBlocks, source: { kind: 'user' } })
    rec.handle.agent.followup(message)
    return { messageId: message.id }
  }

  /**
   * Queue next-step steering and wake the target Agent.
   * @param params - target session and user content.
   * @returns durable queued-message identity.
   */
  async steer(params: SessionInputParams): Promise<SessionInputResult> {
    return this.deliverInput(params, 'steer')
  }

  /**
   * Queue next-step context without waking an idle target Agent.
   * @param params - target session and user content.
   * @returns durable queued-message identity.
   */
  async inject(params: SessionInputParams): Promise<SessionInputResult> {
    return this.deliverInput(params, 'inject')
  }

  /**
   * Cancel one live Agent without affecting other SDK sessions.
   * @param params - target session and inbox-retention policy.
   * @returns empty JSON-RPC result.
   */
  cancel(params: SessionCancelParams): Promise<Record<string, never>> {
    const rec = this.liveSession(params.sessionId)
    rec.handle.agent.cancel({ kind: 'user' }, { keepInbox: params.keepInbox === true })
    return Promise.resolve({})
  }

  /**
   * Read the session-scoped structured-output capture, when configured.
   * @param params - target session identity.
   * @returns current capture availability and value.
   */
  output(params: SessionTargetParams): Promise<SessionOutputResult> {
    const rec = this.liveSession(params.sessionId)
    if (rec.structured === undefined) {
      return Promise.reject(new Error(`SDK session has no output schema: ${params.sessionId}`))
    }
    const captured = rec.structured.captured()
    return Promise.resolve(captured === undefined
      ? { available: false }
      : { available: true, structuredOutput: captured.value })
  }

  /**
   * Dispose one server-owned Agent to quiescence. Idempotent for unknown ids.
   * @param params - target session identity.
   * @returns whether a live session was closed.
   */
  async closeSession(params: SessionTargetParams): Promise<SessionCloseResult> {
    this.assertCanAddress(params.sessionId)
    const pending = this.sessionCreations.get(params.sessionId)
    if (pending !== undefined) await pending
    const rec = this.sessions.get(params.sessionId)
    if (rec === undefined) return { closed: false }
    this.sessions.delete(params.sessionId)
    await rec.handle.dispose()
    return { closed: true }
  }

  /**
   * Dispose server-owned agents, adapter, and subscriptions to quiescence.
   * The surrounding context remains running.
   * @returns empty JSON-RPC result.
   */
  shutdown(): Promise<Record<string, never>> {
    this.shutdownTask ??= this.performShutdown()
    return this.shutdownTask
  }

  private async performShutdown(): Promise<Record<string, never>> {
    this.shuttingDown = true
    const pendingCreations = [...this.sessionCreations.values()]
    await Promise.allSettled(pendingCreations)
    this.sessionCreations.clear()
    const records = [...this.sessions.values()]
    this.sessions.clear()
    const failures: unknown[] = []
    while (this.disposers.length > 0) {
      try {
        this.disposers.pop()?.()
      } catch (error) {
        failures.push(error)
      }
    }
    const teardownResults = await Promise.allSettled([
      ...records.map(rec => Promise.resolve().then(() => rec.handle.dispose())),
      ...(this.llmFiber === undefined ? [] : [Promise.resolve().then(() => this.llmFiber?.dispose())]),
    ])
    this.llmFiber = undefined
    failures.push(...teardownResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason as unknown))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'SDK server teardown failed')
    return {}
  }

  /**
   * Dispatch one incoming JSON-RPC request to its typed handler. Throws (→ a
   * JSON-RPC error response) on an unknown method.
   * @param method - the JSON-RPC method name.
   * @param params - the raw params object from the wire.
   * @returns the handler's result, to be serialized as the response.
   */
  async handleRequest(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(params as unknown as InitializeParams)
      case 'session/open':
        return this.open(params as unknown as SessionOpenParams)
      case 'session/prompt':
        return this.prompt(params as unknown as SessionPromptParams)
      case 'session/steer':
        return this.steer(params as unknown as SessionInputParams)
      case 'session/inject':
        return this.inject(params as unknown as SessionInputParams)
      case 'session/cancel':
        return this.cancel(params as unknown as SessionCancelParams)
      case 'session/output':
        return this.output(params as unknown as SessionTargetParams)
      case 'session/close':
        return this.closeSession(params as unknown as SessionTargetParams)
      case 'shutdown':
        return this.shutdown()
      default:
        throw new Error(`unknown DeepSeek Harness SDK runtime method: ${method}`)
    }
  }

  private async getOrCreateSession(sessionId: string): Promise<SessionRecord> {
    this.assertCanAddress(sessionId)
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const pending = this.sessionCreations.get(sessionId)
    if (pending) return pending
    const creation = this.createSession({ sessionId })
    this.sessionCreations.set(sessionId, creation)
    void creation.then(
      () => { this.sessionCreations.delete(sessionId) },
      () => { this.sessionCreations.delete(sessionId) },
    )
    return creation
  }

  private async createSession(params: SessionOpenParams): Promise<SessionRecord> {
    const sessionId = params.sessionId
    assertMaxTokens(params.maxTokens, 'session/open')
    assertOptionalNonEmpty(params.provider, 'session/open provider')
    assertOptionalNonEmpty(params.model, 'session/open model')
    assertOptionalNonEmpty(params.reasoningEffort, 'session/open reasoningEffort')
    if (params.allowedTools !== undefined
      && !params.allowedTools.every(name => typeof name === 'string' && name.length > 0)) {
      throw new TypeError('session/open allowedTools must contain only non-empty strings')
    }
    const outputSchema = params.outputSchema
    if (outputSchema !== undefined) assertObjectJsonSchema(outputSchema)
    const provider = params.provider ?? this.provider
    const model = params.model ?? this.model
    const maxTokens = params.maxTokens ?? this.maxTokens
    const reasoningEffort = params.reasoningEffort ?? this.reasoningEffort
    let structured: StructuredAttachment | undefined
    const setup = (agentCtx: Context): void => {
      if (params.systemPrompt !== undefined) {
        agentCtx.systemPrompt.section({
          name: PERSONA_SECTION,
          order: PERSONA_ORDER,
          text: params.systemPrompt,
          complete: true,
        })
      }
      if (params.allowedTools !== undefined) {
        // Restrictions name inherited/global capabilities only. The structured
        // capture is registered below in this agent's own scope and therefore
        // remains visible after any global allowlist without being named here.
        agentCtx.tools.restrict({ allow: params.allowedTools })
      }
      if (reasoningEffort !== undefined) {
        const selection: ModelSelectionRef = {
          current: { provider, model, reasoningEffort: ReasoningEffortId(reasoningEffort) },
          assembled: undefined,
        }
        installModelSelection(agentCtx, selection)
      }
      if (outputSchema !== undefined) {
        structured = attachStructuredRuntime(agentCtx, outputSchema)
      }
    }
    // No preset composition: this server's compositions keep the model-facing
    // rows in the host plane, so this agent reads them from the global layer. A
    // deployment that configures a roster has to join one here first
    // (@deepseek-ai/dsh-agent-presets README, "Composing a child agent").
    const agentOptions = {
      provider,
      model,
      ...maxTokens === undefined ? {} : { maxTokens },
    }
    const handle = params.resume === true
      ? await this.ctx.agents.resume({
        resumeSessionId: SessionId(sessionId),
        agentOptions,
        setup,
      })
      : await this.ctx.agents.create({
        sessionId: SessionId(sessionId),
        meta: { cwd: this.cwd },
        agentOptions,
        setup,
      })
    const rec: SessionRecord = { handle, ...structured === undefined ? {} : { structured } }
    this.sessions.set(sessionId, rec)
    return rec
  }

  private deliverInput(
    params: SessionInputParams,
    method: 'steer' | 'inject',
  ): Promise<SessionInputResult> {
    const rec = this.liveSession(params.sessionId)
    const message = createUserMessage({ content: params.contentBlocks, source: { kind: 'user' } })
    const wokeIdle = method === 'steer' && rec.handle.agent.status === 'idle'
    rec.handle.agent[method](message)
    return Promise.resolve({ messageId: message.id, ...wokeIdle ? { wokeIdle: true } : {} })
  }

  private liveSession(sessionId: string): SessionRecord {
    this.assertCanAddress(sessionId)
    const rec = this.sessions.get(sessionId)
    if (rec === undefined) throw new Error(`SDK session is not open: ${sessionId}`)
    if (this.ctx.agents.get(rec.handle.agent.id) !== rec.handle.agent) {
      throw new Error(`session agent was disposed outside the server: ${sessionId}`)
    }
    return rec
  }

  private assertCanAddress(sessionId: string): void {
    if (this.shuttingDown) throw new Error('SDK server is shutting down')
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new TypeError('SDK sessionId must be a non-empty string')
    }
  }

  private hasAdapterFor(provider: string): boolean {
    return this.ctx.get('llm')?.listProviders().some(entry => entry.id === provider) ?? false
  }
}

function assertMaxTokens(value: number | undefined, method: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError(`${method} maxTokens must be a positive safe integer`)
  }
}

function assertOptionalNonEmpty(value: string | undefined, field: string): void {
  if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
    throw new TypeError(`${field} must be a non-empty string`)
  }
}
