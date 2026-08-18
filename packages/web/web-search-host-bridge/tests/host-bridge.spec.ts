import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime, { WebError } from '@deepseek-ai/dsh-web'
import {
  apply,
  Config,
  HostBridgeSearchProvider,
  resolveHostWebBase,
} from '@deepseek-ai/dsh-web-search-host-bridge/src/index.ts'

const resolvedConfig = {
  baseUrl: 'http://127.0.0.1:8002',
  runToken: 'opaque-web-run',
  requestTimeoutMs: 30_000,
  maxResponseBytes: 4 * 1024 * 1024,
}

async function mountWeb(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, { searchProvider: 'host-bridge' })
  return ctx
}

describe('web-search-host-bridge config', () => {
  it('materializes bounded defaults and pins URLs to loopback', () => {
    expect(Config({ baseUrl: '', runToken: '' } as never)).toEqual({
      baseUrl: '',
      runToken: '',
      requestTimeoutMs: 30_000,
      maxResponseBytes: 4 * 1024 * 1024,
    })
    expect(resolveHostWebBase('http://localhost:8002/')).toBe('http://localhost:8002')
    expect(resolveHostWebBase('http://[::1]:8002')).toBe('http://[::1]:8002')
    expect(() => resolveHostWebBase('not a URL')).toThrow(/absolute loopback/)
    expect(() => resolveHostWebBase('https://localhost:8002')).toThrow(/unauthenticated HTTP/)
    expect(() => resolveHostWebBase('http://example.com')).toThrow(/unauthenticated HTTP/)
    expect(() => resolveHostWebBase('http://user@localhost:8002')).toThrow(/unauthenticated HTTP/)
    expect(() => resolveHostWebBase('http://:pass@localhost:8002')).toThrow(/unauthenticated HTTP/)
    expect(() => resolveHostWebBase('http://localhost:8002?token=x')).toThrow(/query or fragment/)
    expect(() => resolveHostWebBase('http://localhost:8002#token')).toThrow(/query or fragment/)
  })
})

describe('host search provider', () => {
  let ctx: Context
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    ctx = await mountWeb()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the opaque token and maps normalized sources', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      result: 'Current answer with sources.',
      results: [
        { title: 'DeepSeek Harness', url: 'https://example.test/dsh', snippet: 'Harness result.' },
        { title: '', url: 'https://example.test/second', snippet: '' },
      ],
    }), { status: 200 }))
    apply(ctx, resolvedConfig)

    const result = await ctx.web.search({ query: 'current harness', maxResults: 2 })

    expect(result).toEqual({
      content: 'Current answer with sources.',
      sources: [
        { title: 'DeepSeek Harness', url: 'https://example.test/dsh', snippet: 'Harness result.' },
        { url: 'https://example.test/second' },
      ],
      truncated: false,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8002/bridge/web/search',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          run_token: 'opaque-web-run',
          query: 'current harness',
          max_results: 2,
        }),
      }),
    )
  })

  it('supports the explicit empty disabled state and rejects partial config', async () => {
    expect(() => {
      apply(ctx, { ...resolvedConfig, baseUrl: '', runToken: '' })
    }).not.toThrow()
    expect(() => {
      apply(ctx, { ...resolvedConfig, runToken: '' })
    }).toThrow(/configured together/)
    await expect(ctx.web.search({ query: 'x' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
  })

  it('maps host denials, malformed results, HTTP errors, and size caps to WebError', async () => {
    apply(ctx, { ...resolvedConfig, maxResponseBytes: 64 })

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: 'budget exhausted' })))
    await expect(ctx.web.search({ query: 'one' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: 'budget exhausted',
    })

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, results: [{}] })))
    await expect(ctx.web.search({ query: 'two' })).rejects.toBeInstanceOf(WebError)

    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 503 }))
    await expect(ctx.web.search({ query: 'three' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })

    fetchMock.mockResolvedValueOnce(new Response('{}', {
      headers: { 'content-length': '1000' },
    }))
    await expect(ctx.web.search({ query: 'four' })).rejects.toThrow(/byte limit/)
  })

  it('covers provider availability, default result bounds, body caps, and malformed envelopes', async () => {
    const provider = new HostBridgeSearchProvider(resolvedConfig)
    expect(provider.available()).toBe(true)
    expect(new HostBridgeSearchProvider({ ...resolvedConfig, runToken: '' }).available()).toBe(false)

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, results: [] })))
    await expect(provider.search({ query: 'default-bound' })).resolves.toEqual({ sources: [], truncated: false })
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8002/bridge/web/search',
      expect.objectContaining({ body: JSON.stringify({ run_token: 'opaque-web-run', query: 'default-bound', max_results: 5 }) }),
    )

    const malformed: Array<{ response: Response; pattern: RegExp }> = [
      { response: new Response('x'.repeat(17)), pattern: /byte limit/ },
      { response: new Response('not-json'), pattern: /malformed JSON/ },
      { response: new Response('[]'), pattern: /invalid envelope/ },
      { response: new Response('{}'), pattern: /invalid envelope/ },
      { response: new Response(JSON.stringify({ ok: false })), pattern: /host web search failed/ },
      { response: new Response(JSON.stringify({ ok: true, results: {} })), pattern: /invalid results/ },
      { response: new Response(JSON.stringify({ ok: true, results: [null] })), pattern: /has no URL/ },
      { response: new Response(JSON.stringify({ ok: true, results: [{ url: '' }] })), pattern: /has no URL/ },
    ]
    const constrained = new HostBridgeSearchProvider({ ...resolvedConfig, maxResponseBytes: 16 })
    for (const { response, pattern } of malformed) {
      fetchMock.mockResolvedValueOnce(response)
      const selected = pattern.source.includes('byte limit') ? constrained : provider
      await expect(selected.search({ query: 'bad' })).rejects.toThrow(pattern)
    }
  })

  it('maps transport and body-read failures, preserving abort semantics', async () => {
    const provider = new HostBridgeSearchProvider(resolvedConfig)
    fetchMock.mockRejectedValueOnce(new Error('connect failed'))
    await expect(provider.search({ query: 'connect' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })

    const aborted = new AbortController()
    aborted.abort()
    fetchMock.mockRejectedValueOnce(new Error('aborted fetch'))
    await expect(provider.search({ query: 'abort-fetch' }, aborted.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })

    const unreadable = {
      ok: true,
      headers: new Headers(),
      text: () => Promise.reject(new Error('read failed')),
    } as Response
    fetchMock.mockResolvedValueOnce(unreadable)
    await expect(provider.search({ query: 'unreadable' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })

    const abortedRead = new AbortController()
    abortedRead.abort()
    fetchMock.mockResolvedValueOnce(unreadable)
    await expect(provider.search({ query: 'abort-read' }, abortedRead.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })
})
