/**
 * Opaque-token, loopback search provider for platform-hosted web backends.
 * Search credentials and budgets remain in the host process; the harness gets
 * only a per-run capability token and normalized search results.
 * @module @deepseek-ai/dsh-web-search-host-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'

/** Stable provider id registered in the web seam. */
export const HOST_BRIDGE_PROVIDER_ID = 'host-bridge'

/** Default hosted-search request timeout. */
export const DEFAULT_HOST_WEB_TIMEOUT_MS = 30_000
/** Default maximum decoded hosted-search response size. */
export const DEFAULT_HOST_WEB_MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** Plugin configuration. Empty baseUrl + runToken disables registration. */
export interface Config {
  /** Unauthenticated loopback origin of the platform web bridge; empty with runToken disables registration. */
  baseUrl: string
  /** Opaque per-run capability registered by the platform host. */
  runToken: string
  /** Time limit for one hosted search request. */
  requestTimeoutMs: number
  /** Maximum accepted UTF-8 JSON response size. */
  maxResponseBytes: number
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().default(''),
  runToken: z.string().default(''),
  requestTimeoutMs: z.number().min(1).default(DEFAULT_HOST_WEB_TIMEOUT_MS),
  maxResponseBytes: z.number().step(1).min(1).max(16 * 1024 * 1024).default(DEFAULT_HOST_WEB_MAX_RESPONSE_BYTES),
})

/** Cordis namespace plugin metadata. */
export const name = 'web-search-host-bridge'
export const inject = ['web']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Pin the opaque capability to an unauthenticated loopback HTTP origin.
 * @param raw - configured platform-host origin.
 * @returns normalized origin without trailing slashes.
 */
export function resolveHostWebBase(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('web-search-host-bridge: baseUrl must be an absolute loopback HTTP URL')
  }
  const hostname = url.hostname.toLowerCase()
  const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== '') {
    throw new Error('web-search-host-bridge: baseUrl must use unauthenticated HTTP on 127.0.0.1, localhost, or [::1]')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('web-search-host-bridge: baseUrl must not contain a query or fragment')
  }
  return url.toString().replace(/\/+$/, '')
}

/** Provider implementation for `POST /bridge/web/search`. */
export class HostBridgeSearchProvider implements WebSearchProvider {
  readonly id = HOST_BRIDGE_PROVIDER_ID
  private readonly baseUrl: string

  constructor(private readonly config: Config) {
    this.baseUrl = resolveHostWebBase(config.baseUrl)
  }

  available(): boolean {
    return this.config.runToken.length > 0
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs)
    const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/bridge/web/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          run_token: this.config.runToken,
          query: request.query,
          max_results: request.maxResults ?? 5,
        }),
        signal: requestSignal,
      })
    } catch (error: unknown) {
      if (requestSignal.aborted) throw new WebError('host web search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`host web-search bridge request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (!response.ok) {
      throw new WebError(`host web-search bridge returned HTTP ${response.status}`, 'WEB_PROVIDER_ERROR')
    }
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > this.config.maxResponseBytes) {
      throw new WebError('host web-search bridge response exceeded the configured byte limit', 'WEB_PROVIDER_ERROR')
    }
    let text: string
    try {
      text = await response.text()
    } catch (error: unknown) {
      if (requestSignal.aborted) throw new WebError('host web search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError('host web-search bridge response could not be read', 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (Buffer.byteLength(text, 'utf8') > this.config.maxResponseBytes) {
      throw new WebError('host web-search bridge response exceeded the configured byte limit', 'WEB_PROVIDER_ERROR')
    }
    let payload: unknown
    try {
      payload = JSON.parse(text) as unknown
    } catch (error: unknown) {
      throw new WebError('host web-search bridge returned malformed JSON', 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (!isRecord(payload) || typeof payload.ok !== 'boolean') {
      throw new WebError('host web-search bridge returned an invalid envelope', 'WEB_PROVIDER_ERROR')
    }
    if (!payload.ok) {
      throw new WebError(
        typeof payload.error === 'string' ? payload.error : 'host web search failed',
        'WEB_PROVIDER_ERROR',
      )
    }
    if (!Array.isArray(payload.results)) {
      throw new WebError('host web-search bridge returned invalid results', 'WEB_PROVIDER_ERROR')
    }
    const sources: WebSearchSource[] = payload.results.map((candidate, index) => {
      if (!isRecord(candidate) || typeof candidate.url !== 'string' || candidate.url.length === 0) {
        throw new WebError(`host web-search bridge result ${index} has no URL`, 'WEB_PROVIDER_ERROR')
      }
      return {
        url: candidate.url,
        ...typeof candidate.title === 'string' && candidate.title.length > 0 ? { title: candidate.title } : {},
        ...typeof candidate.snippet === 'string' && candidate.snippet.length > 0 ? { snippet: candidate.snippet } : {},
      }
    })
    return {
      ...typeof payload.result === 'string' && payload.result.length > 0 ? { content: payload.result } : {},
      sources,
      truncated: false,
    }
  }
}

/** Register the host provider, or no-op for the explicit empty disabled state. */
export function apply(ctx: Context, config: Config): void {
  if (config.baseUrl === '' && config.runToken === '') return
  if (config.baseUrl === '' || config.runToken === '') {
    throw new Error('web-search-host-bridge: baseUrl and runToken must be configured together')
  }
  ctx.web.registerSearchProvider(new HostBridgeSearchProvider(config))
}
