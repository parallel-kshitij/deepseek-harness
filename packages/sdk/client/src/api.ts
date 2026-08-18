/**
 * High-level run API over {@link HarnessClient}: `DeepSeekHarness` owns one
 * runtime subprocess across many sessions; `HarnessSession.run` sends a
 * prompt and settles when the whole agent next becomes idle.
 * Mirrors the Python SDK's `DeepSeekHarness`/`Session` pair.
 *
 * @module @deepseek-ai/dsh-sdk-client/api
 */

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionOpenParams, SessionOutputResult } from '@deepseek-ai/dsh-sdk-protocol'
import { HarnessClient, isRecord, SdkProtocolError } from './client.ts'
import type { ContentBlock, DeepSeekHarnessOptions, HarnessClientOptions, HarnessNotification, RunResult } from './types.ts'

/**
 * Reusable SDK for running DeepSeek Harness agent turns in a runtime
 * subprocess. The subprocess starts lazily on first use and stays owned by
 * this instance until {@link close}; always close (or `await using`) so the
 * child is reaped.
 */
export class DeepSeekHarness implements AsyncDisposable {
  private clientInstance: HarnessClient
  private readonly launch: HarnessClientOptions
  private readonly cwd: string
  private readonly provider: string
  private readonly model: string
  private readonly maxTokens: number | undefined
  private readonly reasoningEffort: string | undefined
  private initialized: Promise<void> | undefined
  private closed = false

  /** @param options - runtime launch spec plus the session route (cwd/provider/model). */
  constructor(options: DeepSeekHarnessOptions) {
    this.launch = options.launch
    this.clientInstance = new HarnessClient(options.launch)
    // Absolute before the handshake: the child spawns relative to THIS
    // process's cwd, but the wire cwd is resolved again inside the child — a
    // relative value would double-resolve (e.g. `worker` → `worker/worker`).
    this.cwd = resolve(options.cwd ?? options.launch.cwd ?? process.cwd())
    this.provider = options.provider ?? 'deepseek-official'
    this.model = options.model ?? 'deepseek-v4-flash'
    this.maxTokens = options.maxTokens
    this.reasoningEffort = options.reasoningEffort
  }

  /**
   * The underlying JSON-RPC client (exposed for low-level access). A failed
   * handshake reaps its runtime and swaps in a fresh instance, so do not
   * cache this across a failed {@link start}.
   * @returns the client currently owning the runtime subprocess.
   */
  get client(): HarnessClient {
    return this.clientInstance
  }

  /**
   * Start the subprocess and perform the `initialize` handshake once. On
   * failure the runtime is reaped and a fresh client replaces it
   * (`HarnessClient.close` is permanent), so a later call retries with a new
   * subprocess — unless {@link close} already ended this harness.
   * @returns settlement of the (memoized) handshake.
   */
  start(): Promise<void> {
    this.initialized ??= (async () => {
      try {
        this.clientInstance.start()
        await this.clientInstance.initialize({
          cwd: this.cwd,
          provider: this.provider,
          model: this.model,
          ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens },
          ...this.reasoningEffort === undefined ? {} : { reasoningEffort: this.reasoningEffort },
        })
      } catch (error) {
        this.initialized = undefined
        await this.clientInstance.close()
        if (!this.closed) this.clientInstance = new HarnessClient(this.launch)
        throw error
      }
    })()
    return this.initialized
  }

  /**
   * Open a session handle (no immediate wire traffic). A handle with explicit
   * options publishes that composition before its first prompt; an unconfigured
   * handle keeps the runtime's lazy default-session behavior.
   * @param sessionId - explicit id to reuse; omitted mints a fresh one.
   * @param options - optional explicit route and scoped session composition.
   * @returns the session handle.
   */
  session(sessionId?: string, options?: SessionOptions): HarnessSession {
    return new HarnessSession(this, sessionId ?? `session-${randomUUID().replaceAll('-', '')}`, options)
  }

  /**
   * Run one prompt on a fresh (or named) session.
   * @param input - prompt text, or content blocks sent verbatim.
   * @param options - optional session id and per-notification observer.
   * @returns the owned activity interval.
   */
  run(input: string | ContentBlock[], options?: RunOptions): Promise<RunResult> {
    return this.session(options?.sessionId, options?.session).run(input, options)
  }

  /**
   * Shut down and reap the runtime subprocess. Idempotent and terminal —
   * a closed harness no longer retries a failed handshake.
   * @returns settlement of the complete teardown.
   */
  close(): Promise<void> {
    this.closed = true
    return this.clientInstance.close()
  }

  /**
   * `await using` support: {@link close}.
   * @returns settlement of the teardown.
   */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }
}

/** Per-run options: target session and streaming observer. */
export interface RunOptions {
  /** Session id to run on; omitted mints a fresh session per call. */
  sessionId?: string
  /** Observer invoked with every notification for this session tree, in wire order. */
  onNotification?: (notification: HarnessNotification) => void
  /** Optional explicit session composition applied before the first prompt. */
  session?: SessionOptions
}

/** Explicit per-session route and scoped composition. */
export type SessionOptions = Omit<SessionOpenParams, 'sessionId'>

/**
 * One SDK session: a stable id plus owned activity intervals.
 */
export class HarnessSession {
  private readonly options: SessionOptions | undefined
  private opened: Promise<void> | undefined
  /**
   * @param harness - the owning harness (supplies the client and handshake).
   * @param id - the wire session id this handle runs on.
   */
  constructor(readonly harness: DeepSeekHarness, readonly id: string, options?: SessionOptions) {
    this.options = options
  }

  /**
   * Publish this session with explicit composition. Idempotent on this handle.
   * @param options - explicit route and scoped composition.
   * @returns settlement after the session is open.
   */
  open(options: SessionOptions = this.options ?? {}): Promise<void> {
    this.opened ??= (async () => {
      await this.harness.start()
      await this.harness.client.openSession({ sessionId: this.id, ...options })
    })()
    return this.opened
  }

  /**
   * Queue next-step steering and wake this session.
   * @param input - steering text or content blocks.
   * @returns durable queued-message identity.
   */
  async steer(input: string | ContentBlock[]): Promise<string> {
    await this.harness.start()
    return this.harness.client.steer(this.id, normalizeInput(input))
  }

  /**
   * Queue next-step context without waking an idle session.
   * @param input - injected text or content blocks.
   * @returns durable queued-message identity.
   */
  async inject(input: string | ContentBlock[]): Promise<string> {
    await this.harness.start()
    return this.harness.client.inject(this.id, normalizeInput(input))
  }

  /**
   * Cancel this session's active activity without stopping the runtime.
   * @param keepInbox - preserve queued follow-ups when true.
   * @returns settlement after cancellation is accepted.
   */
  async cancel(keepInbox = false): Promise<void> {
    await this.harness.start()
    await this.harness.client.cancelSession(this.id, keepInbox)
  }

  /**
   * Read the session's current structured-output capture.
   * @returns current capture availability and value.
   */
  async output(): Promise<SessionOutputResult> {
    await this.harness.start()
    return this.harness.client.sessionOutput(this.id)
  }

  /**
   * Dispose this session while preserving the owning runtime.
   * @returns whether a live session was closed.
   */
  async close(): Promise<boolean> {
    await this.harness.start()
    return (await this.harness.client.closeSession(this.id)).closed
  }

  /**
   * Queue one prompt, then observe the whole session through its next idle.
   * @param input - prompt text, or content blocks sent verbatim.
   * @param options - optional per-notification observer.
   * @returns the owned activity interval; rejects on transport loss, timeout,
   * or a protocol error.
   */
  async run(input: string | ContentBlock[], options?: Pick<RunOptions, 'onNotification'>): Promise<RunResult> {
    await this.harness.start()
    if (this.options !== undefined) await this.open()
    const client = this.harness.client
    const contentBlocks = normalizeInput(input)
    const events: SessionEvent[] = []
    const notifications: HarnessNotification[] = []

    const subscription = client.subscribeSessionTree(this.id)
    const collect = (notification: HarnessNotification): void => {
      if (notification.method === 'session.event' && notification.params.sessionId === this.id) {
        // Wire boundary: the envelope feeds the typed RunResult, so a
        // malformed runtime surfaces as a protocol error, not as type-invalid
        // data (or a TypeError out of finalResponse).
        const event = validatedSessionEvent(notification.params.event)
        notifications.push(notification)
        options?.onNotification?.(notification)
        events.push(event)
        return
      }
      notifications.push(notification)
      options?.onNotification?.(notification)
    }
    try {
      const messageId = await client.prompt(this.id, contentBlocks)
      let received = false
      while (true) {
        const notification = await subscription.next()
        if (!received) {
          if (notification.method !== 'session.event'
            || notification.params.sessionId !== this.id
            || !isInboxReceipt(notification.params.event, messageId)) continue
          received = true
        }
        collect(notification)
        if (notification.method === 'session.status'
          && notification.params.sessionId === this.id
          && notification.params.status === 'idle') break
      }
    } finally {
      subscription.close()
    }

    const reason = finishReason(events)
    const output = this.options?.outputSchema === undefined
      ? undefined
      : await client.sessionOutput(this.id)
    return {
      sessionId: this.id,
      finalResponse: finalResponse(events),
      ...reason === undefined ? {} : { finishReason: reason },
      ...output?.available === true ? { structuredOutput: output.structuredOutput } : {},
      events,
      notifications,
    }
  }
}

/**
 * Normalize run input: a string becomes one text block; blocks pass verbatim.
 * @param input - prompt text or content blocks.
 * @returns the content blocks to send.
 */
export function normalizeInput(input: string | ContentBlock[]): ContentBlock[] {
  return typeof input === 'string' ? [{ type: 'text', text: input }] : input
}

/** Validate the fields in a wire `session.event` envelope before returning the typed result. */
function validatedSessionEvent(value: unknown): SessionEvent {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new SdkProtocolError(`session.event carried no event envelope: ${JSON.stringify(value)}`)
  }
  // The one variant this module reads into (finalResponse) must carry
  // kind-tagged content blocks; other variants pass through under their
  // envelope shape.
  if (value.type === 'assistant/message') {
    const message = isRecord(value.data) ? value.data.message : undefined
    const content = isRecord(message) ? message.content : undefined
    if (!Array.isArray(content) || !content.every(block => isRecord(block) && typeof block.type === 'string')) {
      throw new SdkProtocolError(`assistant/message event carried malformed content: ${JSON.stringify(value)}`)
    }
  }
  return value as unknown as SessionEvent
}

/** Whether a raw session event is the durable enqueue receipt for `messageId`. */
function isInboxReceipt(value: unknown, messageId: string): boolean {
  if (!isRecord(value) || value.type !== 'agent/inbox/spliced' || !isRecord(value.data)) return false
  const inserted = value.data.inserted
  return Array.isArray(inserted) && inserted.some(message => isRecord(message) && message.id === messageId)
}

/**
 * Extract the concatenated text of the last assistant message.
 * @param events - the activity interval's `session.event` payloads in wire order.
 * @returns the final response text, or `''` when no assistant message exists.
 */
export function finalResponse(events: SessionEvent[]): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    return event.data.message.content
      .filter((block): block is ContentBlock & { type: 'text' } => block.type === 'text')
      .map(block => block.text)
      .join('')
  }
  return ''
}

/**
 * Extract the kind of the last root turn ending in an owned activity interval.
 * @param events - the activity interval's `session.event` payloads in wire order.
 * @returns the final reason kind, or `undefined` when no turn ended.
 */
export function finishReason(events: SessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'turn/end') continue
    const reason = event.data.reason
    if (!isRecord(reason) || typeof reason.kind !== 'string') {
      throw new SdkProtocolError('turn/end event requires a string data.reason.kind')
    }
    return reason.kind
  }
  return undefined
}
