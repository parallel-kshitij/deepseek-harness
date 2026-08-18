/**
 * Host-resident MCP bridge transport.
 *
 * A platform may own MCP clients that cannot or must not move into the harness
 * process (for example an in-process Python memory server or a credentialed
 * multi-tenant MCP connection). This transport receives only an opaque run
 * token, discovers the run's already-authorized tool manifest from a loopback
 * host bridge, and registers proxy tools on the normal ToolRuntime path.
 *
 * The bridge contract intentionally matches the ParallelLoop host seam:
 *
 * - `POST /bridge/mcp/manifest` with `{ run_token }`
 * - `POST /bridge/mcp/invoke` with `{ run_token, tool_name, args }`
 *
 * Server URLs, subprocess commands, bearer tokens, and in-process server
 * objects remain host-side. The opaque run token is itself a capability, so
 * this implementation refuses non-loopback bridge URLs.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { publicToolName } from './tools.ts'

/** Default bound for manifest and invocation HTTP requests. */
export const DEFAULT_HOST_BRIDGE_TIMEOUT_MS = 60_000

/** Default maximum decoded JSON response size (16 MiB). */
export const DEFAULT_HOST_BRIDGE_MAX_RESPONSE_BYTES = 16 * 1024 * 1024

/** Configuration for the opaque-token, loopback host bridge transport. */
export interface HostBridgeConfig {
  /** Selects the opaque-token platform-host transport. */
  transport: 'host-bridge'
  /** Loopback HTTP origin of the platform host. Empty together with runToken disables the transport. */
  baseUrl: string
  /** Opaque per-run capability registered by the platform host. */
  runToken: string
  /** Bound for manifest discovery and each invocation. */
  requestTimeoutMs: number
  /** Maximum accepted response body after UTF-8 decoding. */
  maxResponseBytes: number
  /** Reject plugin activation rather than activating without proxy tools. */
  failOnStartupError: boolean
}

interface ManifestEntry {
  name: string
  server: string
  tool: string
  description: string
  inputSchema: Record<string, unknown>
}

interface HostBridgeOptions {
  baseUrl: string
  runToken: string
  requestTimeoutMs: number
  maxResponseBytes: number
}

/** Narrow an untrusted JSON value to a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse and pin a bridge origin to loopback HTTP before sending the token.
 * @param raw - configured platform-host origin.
 * @returns normalized origin without trailing slashes.
 */
export function resolveHostBridgeBase(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('mcp-client(host-bridge): baseUrl must be an absolute loopback HTTP URL')
  }
  const hostname = url.hostname.toLowerCase()
  const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== '') {
    throw new Error('mcp-client(host-bridge): baseUrl must use unauthenticated HTTP on 127.0.0.1, localhost, or [::1]')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('mcp-client(host-bridge): baseUrl must not contain a query or fragment')
  }
  return url.toString().replace(/\/+$/, '')
}

/** Read bounded JSON from one host bridge endpoint. */
async function postJson(
  opts: HostBridgeOptions,
  path: '/bridge/mcp/manifest' | '/bridge/mcp/invoke',
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(opts.requestTimeoutMs)
  const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const response = await fetch(`${opts.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: requestSignal,
  })
  if (!response.ok) {
    throw new Error(`host bridge ${path} returned HTTP ${response.status}`)
  }
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > opts.maxResponseBytes) {
    throw new Error(`host bridge ${path} response exceeded ${opts.maxResponseBytes} bytes`)
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > opts.maxResponseBytes) {
    throw new Error(`host bridge ${path} response exceeded ${opts.maxResponseBytes} bytes`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`host bridge ${path} returned malformed JSON`)
  }
}

/** Validate the secret-free manifest and retain the host's original proxy name for invocation. */
function parseManifest(value: unknown): ManifestEntry[] {
  if (!isRecord(value) || !Array.isArray(value.tools)) {
    throw new Error('mcp-client(host-bridge): manifest response must contain a tools array')
  }
  return value.tools.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new Error(`mcp-client(host-bridge): manifest tool ${index} must be an object`)
    }
    const { name, server, tool, description, input_schema: inputSchema } = candidate
    if (typeof name !== 'string' || typeof server !== 'string' || typeof tool !== 'string'
      || server.length === 0 || tool.length === 0) {
      throw new Error(`mcp-client(host-bridge): manifest tool ${index} has invalid identity fields`)
    }
    if (name !== `mcp__${server}__${tool}`) {
      throw new Error(`mcp-client(host-bridge): manifest tool ${index} has an inconsistent proxy name`)
    }
    if (description !== undefined && typeof description !== 'string') {
      throw new Error(`mcp-client(host-bridge): manifest tool ${index} has a non-string description`)
    }
    if (inputSchema !== undefined && !isRecord(inputSchema)) {
      throw new Error(`mcp-client(host-bridge): manifest tool ${index} has an invalid input schema`)
    }
    return {
      name,
      server,
      tool,
      description: description ?? '',
      inputSchema: inputSchema ?? { type: 'object' },
    }
  })
}

/** Stable Native projection for the host's arbitrary JSON result. */
function renderResult(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** Build one normal ToolRuntime definition around a host bridge descriptor. */
function createHostDefinition(entry: ManifestEntry, opts: HostBridgeOptions): ToolDefinition {
  return {
    name: publicToolName(entry.server, entry.tool),
    description: entry.description,
    parameters: entry.inputSchema,
    output: {
      schema: {
        type: 'object',
        properties: { result: {} },
        required: ['result'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderResult((value as { [key: string]: JsonValue }).result as JsonValue),
      }],
    },
    async execute(args, exec) {
      const payload = await postJson(opts, '/bridge/mcp/invoke', {
        run_token: opts.runToken,
        tool_name: entry.name,
        args: isRecord(args) ? args : {},
      }, exec.signal)
      if (!isRecord(payload) || typeof payload.ok !== 'boolean') {
        throw new Error(`MCP host bridge returned an invalid response for ${entry.name}`)
      }
      if (!payload.ok) {
        throw new Error(typeof payload.error === 'string' ? payload.error : `MCP host bridge rejected ${entry.name}`)
      }
      return { result: (payload.result ?? null) as JsonValue }
    },
  }
}

/**
 * Discover and atomically register all tools for one host-owned run.
 *
 * Empty baseUrl + token is the explicit disabled state used by a static SDK
 * composition. A partial configuration is rejected because silently dropping
 * an opaque capability usually indicates a provider/runtime wiring bug.
 * @param ctx - Cordis context that owns the tool registrations.
 * @param config - opaque run capability and bounded bridge policy.
 */
export async function applyHostBridge(ctx: Context, config: HostBridgeConfig): Promise<void> {
  if (config.baseUrl === '' && config.runToken === '') return
  if (config.baseUrl === '' || config.runToken === '') {
    throw new Error('mcp-client(host-bridge): baseUrl and runToken must be configured together')
  }
  const opts: HostBridgeOptions = {
    baseUrl: resolveHostBridgeBase(config.baseUrl),
    runToken: config.runToken,
    requestTimeoutMs: config.requestTimeoutMs,
    maxResponseBytes: config.maxResponseBytes,
  }
  // Cordis only attributes effects created during the plugin's synchronous
  // activation phase to that plugin fiber. Establish the lifecycle owner
  // before the first await, then add registrations to the owned disposer set
  // after manifest discovery completes. Creating ctx.effect() after the fetch
  // can attach it to the ambient/root fiber, where plugin activation may
  // immediately roll it back and leave session/open unable to see the tools.
  const disposers: Array<() => void> = []
  const disposeRegistered = () => {
    while (disposers.length > 0) disposers.pop()?.()
  }
  ctx.effect(() => disposeRegistered, 'mcp-client.host-bridge.tools')
  try {
    const manifest = parseManifest(await postJson(opts, '/bridge/mcp/manifest', {
      run_token: opts.runToken,
    }))
    const definitions = new Map<string, ToolDefinition>()
    for (const entry of manifest) {
      const definition = createHostDefinition(entry, opts)
      if (definitions.has(definition.name)) {
        throw new Error(`mcp-client(host-bridge): manifest identities collide at public name "${definition.name}"`)
      }
      definitions.set(definition.name, definition)
    }
    for (const definition of definitions.values()) {
      disposers.push(ctx.tools.register(definition))
    }
  } catch (error) {
    disposeRegistered()
    ctx.logger.error(`mcp-client(host-bridge): startup failed, no proxy tools registered: ${String(error)}`)
    if (config.failOnStartupError) {
      throw new Error('mcp-client(host-bridge): manifest discovery or tool registration failed', { cause: error })
    }
  }
}
