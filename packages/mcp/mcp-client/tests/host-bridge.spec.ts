import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Config } from '@deepseek-ai/dsh-mcp-client'
import {
  apply,
  Config as ConfigSchema,
  resolveHostBridgeBase,
} from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { publicToolName } from '@deepseek-ai/dsh-mcp-client/src/tools.ts'

const signal = new AbortController().signal

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function manifest(...tools: Array<Record<string, unknown>>): Response {
  return jsonResponse({ tools })
}

const config: Config = {
  transport: 'host-bridge',
  baseUrl: 'http://127.0.0.1:8002',
  runToken: 'opaque-run-capability',
  requestTimeoutMs: 60_000,
  maxResponseBytes: 16 * 1024 * 1024,
  failOnStartupError: true,
}

describe('host-bridge config and URL boundary', () => {
  it('materializes host-bridge defaults', () => {
    expect(ConfigSchema({
      transport: 'host-bridge',
      baseUrl: '',
      runToken: '',
    } as never)).toEqual({
      transport: 'host-bridge',
      baseUrl: '',
      runToken: '',
      requestTimeoutMs: 60_000,
      maxResponseBytes: 16 * 1024 * 1024,
      failOnStartupError: false,
    })
  })

  it('accepts only unauthenticated loopback HTTP origins', () => {
    expect(resolveHostBridgeBase('http://localhost:8002/')).toBe('http://localhost:8002')
    expect(resolveHostBridgeBase('http://[::1]:8002')).toBe('http://[::1]:8002')
    expect(() => resolveHostBridgeBase('not a URL')).toThrow(/absolute loopback/)
    expect(() => resolveHostBridgeBase('https://127.0.0.1:8002')).toThrow(/unauthenticated HTTP/)
    expect(() => resolveHostBridgeBase('http://10.0.0.2:8002')).toThrow(/unauthenticated HTTP/)
    expect(() => resolveHostBridgeBase('http://user@localhost:8002')).toThrow(/unauthenticated/)
    expect(() => resolveHostBridgeBase('http://:pass@localhost:8002')).toThrow(/unauthenticated/)
    expect(() => resolveHostBridgeBase('http://localhost:8002?token=bad')).toThrow(/query/)
    expect(() => resolveHostBridgeBase('http://localhost:8002#token')).toThrow(/query/)
  })
})

describe('host-bridge lifecycle and execution', () => {
  let ctx: Context
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    ctx = await mountRegistry()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('treats an empty baseUrl and runToken as an explicit disabled state', async () => {
    await apply(ctx, { ...config, baseUrl: '', runToken: '' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a partially configured opaque capability', async () => {
    await expect(apply(ctx, { ...config, runToken: '' })).rejects.toThrow(/configured together/)
    await expect(apply(ctx, { ...config, baseUrl: '' })).rejects.toThrow(/configured together/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('registers the manifest atomically and invokes with the original host proxy name', async () => {
    fetchMock
      .mockResolvedValueOnce(manifest({
        name: 'mcp__memory__remember.fact',
        server: 'memory',
        tool: 'remember.fact',
        description: 'Store one durable fact',
        input_schema: {
          type: 'object',
          properties: { fact: { type: 'string' } },
          required: ['fact'],
        },
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { stored: true } }))

    await apply(ctx, config)

    const publicName = publicToolName('memory', 'remember.fact')
    expect(publicName).toMatch(/^mcp__memory__remember_fact_[0-9a-f]{12}$/)
    const result = await ctx.tools.execute({
      signal,
      callId: CallId('host-1'),
      name: publicName,
      arguments: { fact: 'Prefer append-only memory.' },
    })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: '{"stored":true}' }])

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:8002/bridge/mcp/manifest', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ run_token: 'opaque-run-capability' }),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:8002/bridge/mcp/invoke', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        run_token: 'opaque-run-capability',
        tool_name: 'mcp__memory__remember.fact',
        args: { fact: 'Prefer append-only memory.' },
      }),
    }))

    const tools = ctx.tools
    await ctx.fiber.dispose()
    expect(tools.get(publicName)).toBeUndefined()
  })

  it('retains async manifest registrations on the owning plugin fiber', async () => {
    const discovery = Promise.withResolvers<Response>()
    fetchMock.mockImplementationOnce(async () => discovery.promise)
    const fiber = ctx.plugin({
      name: 'mcp-client-host-bridge-lifecycle',
      inject: ['tools'],
      apply,
    }, config)
    let activated = false
    const activation = Promise.resolve(fiber).then(() => { activated = true })

    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledOnce() })
    expect(activated).toBe(false)
    expect(ctx.tools.get('mcp__memory__remember')).toBeUndefined()

    discovery.resolve(manifest({
      name: 'mcp__memory__remember',
      server: 'memory',
      tool: 'remember',
      input_schema: { type: 'object' },
    }))
    await activation
    expect(ctx.tools.get('mcp__memory__remember')).toBeDefined()

    await fiber.dispose()
    expect(ctx.tools.get('mcp__memory__remember')).toBeUndefined()
  })

  it('surfaces a host denial as a normal tool error', async () => {
    fetchMock
      .mockResolvedValueOnce(manifest({
        name: 'mcp__memory__remember',
        server: 'memory',
        tool: 'remember',
        input_schema: { type: 'object' },
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: 'tool is not permitted' }))
    await apply(ctx, config)

    const result = await ctx.tools.execute({
      signal,
      callId: CallId('host-2'),
      name: 'mcp__memory__remember',
      arguments: {},
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.type).toBe('text')
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toContain('tool is not permitted')
  })

  it('rolls back every registration when the manifest contains a collision', async () => {
    const duplicate = {
      name: 'mcp__memory__remember',
      server: 'memory',
      tool: 'remember',
      input_schema: { type: 'object' },
    }
    fetchMock.mockResolvedValueOnce(manifest(duplicate, duplicate))

    await expect(apply(ctx, config)).rejects.toThrow(/manifest discovery or tool registration failed/)
    expect(ctx.tools.get('mcp__memory__remember')).toBeUndefined()
  })

  it('contains startup failures when configured nonfatal and enforces the response cap', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"tools":[]}', {
      status: 200,
      headers: { 'content-length': '4096' },
    }))
    await expect(apply(ctx, {
      ...config,
      maxResponseBytes: 32,
      failOnStartupError: false,
    })).resolves.toBeUndefined()
    expect(ctx.tools.get('mcp__memory__remember')).toBeUndefined()
  })

  it('rejects inconsistent proxy identity before registering any tool', async () => {
    fetchMock.mockResolvedValueOnce(manifest({
      name: 'mcp__other__remember',
      server: 'memory',
      tool: 'remember',
      input_schema: { type: 'object' },
    }))
    await expect(apply(ctx, config)).rejects.toThrow(/manifest discovery or tool registration failed/)
    expect(ctx.tools.get('mcp__memory__remember')).toBeUndefined()
    expect(ctx.tools.get('mcp__other__remember')).toBeUndefined()
  })

  it('rejects every malformed manifest shape and bounded HTTP failure', async () => {
    const invalidResponses = [
      new Response('{}', { status: 503 }),
      new Response('{"tools":[]}', { headers: { 'content-length': '999' } }),
      new Response('x'.repeat(33)),
      new Response('not-json'),
      jsonResponse([]),
      jsonResponse({}),
      jsonResponse({ tools: [null] }),
      manifest({ name: 1, server: 's', tool: 't' }),
      manifest({ name: 'mcp__s__t', server: 1, tool: 't' }),
      manifest({ name: 'mcp__s__t', server: 's', tool: 1 }),
      manifest({ name: 'mcp____t', server: '', tool: 't' }),
      manifest({ name: 'mcp__s__', server: 's', tool: '' }),
      manifest({ name: 'mcp__s__t', server: 's', tool: 't', description: 1 }),
      manifest({ name: 'mcp__s__t', server: 's', tool: 't', input_schema: [] }),
    ]
    for (const [index, response] of invalidResponses.entries()) {
      fetchMock.mockResolvedValueOnce(response)
      try {
        await apply(ctx, {
          ...config,
          maxResponseBytes: index === 1 || index === 2 ? 32 : config.maxResponseBytes,
        })
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        expect(String(error)).toMatch(/manifest discovery or tool registration failed/)
        continue
      }
      throw new Error(`malformed response case ${index} unexpectedly resolved`)
    }
  })

  it('uses manifest defaults and validates every invocation envelope', async () => {
    let captured: ToolDefinition | undefined
    const original = ctx.tools.register.bind(ctx.tools)
    vi.spyOn(ctx.tools, 'register').mockImplementation((definition) => {
      captured = definition
      return original(definition)
    })
    fetchMock
      .mockResolvedValueOnce(manifest({ name: 'mcp__s__t', server: 's', tool: 't' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: null }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: 'plain text' }))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ ok: false }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
    await apply(ctx, config)
    if (captured === undefined) throw new Error('tool definition was not captured')
    await expect(captured.execute([], { signal } as never)).resolves.toEqual({ result: null })
    const invoke = (callId: string) => ctx.tools.execute({
      signal,
      callId: CallId(callId),
      name: 'mcp__s__t',
      arguments: {},
    })
    await expect(invoke('host-default-1')).resolves.toMatchObject({
      isError: false,
      content: [{ type: 'text', text: 'plain text' }],
    })
    await expect(invoke('host-default-2')).resolves.toMatchObject({ isError: true })
    await expect(invoke('host-default-3')).resolves.toMatchObject({ isError: true })
    const rejected = await invoke('host-default-4')
    expect(rejected.isError).toBe(true)
    expect(rejected.content[0]?.type === 'text' ? rejected.content[0].text : '').toContain('MCP host bridge rejected')
    await expect(invoke('host-default-5')).resolves.toMatchObject({
      isError: false,
      content: [{ type: 'text', text: 'null' }],
    })
  })

  it('rolls back prior tool registrations when registry insertion throws', async () => {
    fetchMock.mockResolvedValueOnce(manifest(
      { name: 'mcp__s__one', server: 's', tool: 'one' },
      { name: 'mcp__s__two', server: 's', tool: 'two' },
    ))
    const original = ctx.tools.register.bind(ctx.tools)
    vi.spyOn(ctx.tools, 'register')
      .mockImplementationOnce(definition => original(definition))
      .mockImplementationOnce(() => { throw new Error('registry insertion failed') })
    await expect(apply(ctx, config)).rejects.toThrow(/manifest discovery or tool registration failed/)
    expect(ctx.tools.get('mcp__s__one')).toBeUndefined()
  })
})
