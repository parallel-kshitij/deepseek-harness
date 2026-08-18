/**
 * Native ToolRuntime interception for a host-owned read-before-write policy.
 * The host retains Redis state and policy implementation; DSH translates its
 * write/edit/bash calls to the host's Claude-shaped check/refresh envelope.
 * This advisory guard deliberately fails open on bridge faults. Filesystem
 * isolation remains the sandbox's responsibility.
 * @module @deepseek-ai/dsh-read-gate-host-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PostToolDecision, PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

export const name = 'read-gate-host-bridge'
export const inject = ['tools']

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024

/** Configuration for the loopback, advisory read-before-write bridge. */
export interface Config {
  /** Unauthenticated loopback origin of the host read-gate API; empty disables interception. */
  baseUrl: string
  /** Absolute workspace directory included in host policy requests. */
  cwd: string
  /** Time limit for each host check or refresh request. */
  requestTimeoutMs: number
  /** Maximum accepted UTF-8 JSON response size. */
  maxResponseBytes: number
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().default(''),
  cwd: z.string().default(''),
  requestTimeoutMs: z.number().min(1).default(DEFAULT_TIMEOUT_MS),
  maxResponseBytes: z.number().step(1).min(1).max(1024 * 1024).default(DEFAULT_MAX_RESPONSE_BYTES),
})

interface HookShape {
  tool_name: 'Bash' | 'Write' | 'Edit'
  tool_input: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Pin the unauthenticated policy endpoint to loopback.
 * @param raw - configured bridge origin.
 * @returns normalized origin without trailing slashes.
 */
export function resolveReadGateBase(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('read-gate-host-bridge: baseUrl must be an absolute loopback HTTP URL')
  }
  const hostname = url.hostname.toLowerCase()
  const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== '') {
    throw new Error('read-gate-host-bridge: baseUrl must use unauthenticated HTTP on 127.0.0.1, localhost, or [::1]')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('read-gate-host-bridge: baseUrl must not contain a query or fragment')
  }
  return url.toString().replace(/\/+$/, '')
}

/**
 * Translate DSH native arguments into the unchanged host hook vocabulary.
 * @param exec - pending native DSH tool execution.
 * @returns host hook shape, or undefined for an unrelated tool.
 */
export function toReadGateShape(exec: Pick<ToolExecution, 'name' | 'arguments'>): HookShape | undefined {
  const args = isRecord(exec.arguments) ? exec.arguments : {}
  if (exec.name === 'bash') {
    return { tool_name: 'Bash', tool_input: { command: args.command ?? '' } }
  }
  if (exec.name === 'write') {
    return { tool_name: 'Write', tool_input: { file_path: args.path ?? '' } }
  }
  if (exec.name === 'edit' || exec.name === 'str_replace_editor') {
    return { tool_name: 'Edit', tool_input: { file_path: args.path ?? args.file_path ?? '' } }
  }
  return undefined
}

async function postJson(
  baseUrl: string,
  path: '/bridge/readgate/check' | '/bridge/readgate/refresh',
  body: Record<string, unknown>,
  config: Config,
  signal: AbortSignal,
): Promise<unknown> {
  const fused = AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeoutMs)])
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: fused,
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > config.maxResponseBytes) throw new Error('response too large')
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > config.maxResponseBytes) throw new Error('response too large')
  return JSON.parse(text) as unknown
}

/** Install pre-denial and post-refresh interception; empty baseUrl disables both. */
export function apply(ctx: Context, config: Config): void {
  if (config.baseUrl === '') return
  const baseUrl = resolveReadGateBase(config.baseUrl)
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const shaped = toReadGateShape(exec)
    if (shaped === undefined) return next()
    try {
      const response = await postJson(baseUrl, '/bridge/readgate/check', {
        ...shaped,
        cwd: config.cwd,
      }, config, exec.signal)
      if (isRecord(response) && response.block === true) {
        return {
          kind: 'deny',
          reason: typeof response.reason === 'string' && response.reason.length > 0
            ? response.reason
            : 'write blocked by read gate',
        }
      }
    } catch (error: unknown) {
      ctx.logger.warn(`read-gate-host-bridge: pre-check failed open for ${exec.name}: ${String(error)}`)
    }
    return next()
  })
  ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
    const shaped = toReadGateShape(exec)
    if (shaped !== undefined) {
      try {
        await postJson(baseUrl, '/bridge/readgate/refresh', {
          ...shaped,
          cwd: config.cwd,
        }, config, exec.signal)
      } catch (error: unknown) {
        ctx.logger.warn(`read-gate-host-bridge: post-refresh failed open for ${exec.name}: ${String(error)}`)
      }
    }
    return next()
  })
}
