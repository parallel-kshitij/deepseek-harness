import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  apply,
  Config,
  resolveReadGateBase,
  toReadGateShape,
} from '@deepseek-ai/dsh-read-gate-host-bridge/src/index.ts'

const signal = new AbortController().signal
const config = {
  baseUrl: 'http://127.0.0.1:8002',
  cwd: '/workspace',
  requestTimeoutMs: 5_000,
  maxResponseBytes: 256 * 1024,
}

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

function registerWrite(ctx: Context, executed: string[]): void {
  ctx.tools.register({
    name: 'write',
    description: 'write',
    parameters: { type: 'object' },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    execute: async () => {
      executed.push('write')
      return 'written'
    },
  })
}

describe('read-gate host bridge', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('materializes defaults, pins loopback, and translates native tools', () => {
    expect(Config({} as never)).toEqual({
      baseUrl: '',
      cwd: '',
      requestTimeoutMs: 5_000,
      maxResponseBytes: 256 * 1024,
    })
    expect(resolveReadGateBase('http://localhost:8002/')).toBe('http://localhost:8002')
    expect(resolveReadGateBase('http://[::1]:8002')).toBe('http://[::1]:8002')
    expect(() => resolveReadGateBase('not a URL')).toThrow(/absolute loopback/)
    expect(() => resolveReadGateBase('https://localhost:8002')).toThrow(/unauthenticated HTTP/)
    expect(() => resolveReadGateBase('http://example.com')).toThrow(/unauthenticated HTTP/)
    expect(() => resolveReadGateBase('http://user@localhost:8002')).toThrow(/unauthenticated HTTP/)
    expect(() => resolveReadGateBase('http://:pass@localhost:8002')).toThrow(/unauthenticated HTTP/)
    expect(() => resolveReadGateBase('http://localhost:8002?x=1')).toThrow(/query or fragment/)
    expect(() => resolveReadGateBase('http://localhost:8002#x')).toThrow(/query or fragment/)
    expect(toReadGateShape({ name: 'write', arguments: { path: 'a.txt' } })).toEqual({
      tool_name: 'Write',
      tool_input: { file_path: 'a.txt' },
    })
    expect(toReadGateShape({ name: 'str_replace_editor', arguments: { file_path: 'b.txt' } })).toEqual({
      tool_name: 'Edit',
      tool_input: { file_path: 'b.txt' },
    })
    expect(toReadGateShape({ name: 'bash', arguments: { command: 'touch x' } })).toEqual({
      tool_name: 'Bash',
      tool_input: { command: 'touch x' },
    })
    expect(toReadGateShape({ name: 'bash', arguments: null })).toEqual({
      tool_name: 'Bash',
      tool_input: { command: '' },
    })
    expect(toReadGateShape({ name: 'write', arguments: {} })).toEqual({
      tool_name: 'Write',
      tool_input: { file_path: '' },
    })
    expect(toReadGateShape({ name: 'edit', arguments: { path: 'c.txt', file_path: 'ignored' } })).toEqual({
      tool_name: 'Edit',
      tool_input: { file_path: 'c.txt' },
    })
    expect(toReadGateShape({ name: 'edit', arguments: {} })).toEqual({
      tool_name: 'Edit',
      tool_input: { file_path: '' },
    })
    expect(toReadGateShape({ name: 'read', arguments: {} })).toBeUndefined()
  })

  it('denies before the tool body with the host reason', async () => {
    const ctx = await harness()
    const executed: string[] = []
    registerWrite(ctx, executed)
    apply(ctx, config)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ block: true, reason: 'Read this file first.' })))

    const result = await ctx.tools.execute({
      signal,
      callId: CallId('gate-1'),
      name: 'write',
      arguments: { path: 'a.txt' },
    })

    expect(result.isError).toBe(true)
    expect(result.content[0]?.type).toBe('text')
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toContain('Read this file first.')
    expect(executed).toEqual([])
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8002/bridge/readgate/check',
      expect.objectContaining({
        body: JSON.stringify({
          tool_name: 'Write',
          tool_input: { file_path: 'a.txt' },
          cwd: '/workspace',
        }),
      }),
    )
  })

  it('refreshes after an allowed write and fails open on bridge faults', async () => {
    const ctx = await harness()
    const executed: string[] = []
    registerWrite(ctx, executed)
    apply(ctx, config)
    fetchMock
      .mockRejectedValueOnce(new Error('bridge down'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))

    const result = await ctx.tools.execute({
      signal,
      callId: CallId('gate-2'),
      name: 'write',
      arguments: { path: 'a.txt' },
    })

    expect(result.isError).toBe(false)
    expect(executed).toEqual(['write'])
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:8002/bridge/readgate/refresh',
      expect.any(Object),
    )
  })

  it('uses the fallback denial reason and contains post-refresh faults', async () => {
    const denied = await harness()
    registerWrite(denied, [])
    apply(denied, config)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ block: true, reason: '' })))
    const deniedResult = await denied.tools.execute({
      signal,
      callId: CallId('gate-fallback'),
      name: 'write',
      arguments: { path: 'a.txt' },
    })
    expect(deniedResult.content[0]?.type === 'text' ? deniedResult.content[0].text : '').toContain('write blocked by read gate')

    const allowed = await harness()
    registerWrite(allowed, [])
    apply(allowed, config)
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ block: false })))
      .mockRejectedValueOnce(new Error('refresh down'))
    await expect(allowed.tools.execute({
      signal,
      callId: CallId('gate-refresh-fault'),
      name: 'write',
      arguments: { path: 'a.txt' },
    })).resolves.toMatchObject({ isError: false })
  })

  it('fails open for every malformed or oversized host response', async () => {
    const responses = [
      new Response('{}', { status: 503 }),
      new Response('{}', { headers: { 'content-length': '999999' } }),
      new Response('12345'),
      new Response('not-json'),
    ]
    for (const [index, response] of responses.entries()) {
      const ctx = await harness()
      registerWrite(ctx, [])
      apply(ctx, { ...config, maxResponseBytes: index === 2 ? 2 : config.maxResponseBytes })
      fetchMock.mockResolvedValue(response)
      await expect(ctx.tools.execute({
        signal,
        callId: CallId(`gate-malformed-${index}`),
        name: 'write',
        arguments: { path: 'a.txt' },
      })).resolves.toMatchObject({ isError: false })
      await ctx.fiber.dispose()
    }
  })

  it('bypasses unrelated tools before and after execution', async () => {
    const ctx = await harness()
    ctx.tools.register({
      name: 'read',
      description: 'read',
      parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute: () => Promise.resolve('read'),
    })
    apply(ctx, config)
    await expect(ctx.tools.execute({ signal, callId: CallId('gate-unrelated'), name: 'read', arguments: {} }))
      .resolves.toMatchObject({ isError: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does nothing when disabled', async () => {
    const ctx = await harness()
    const executed: string[] = []
    registerWrite(ctx, executed)
    apply(ctx, { ...config, baseUrl: '' })
    await ctx.tools.execute({ signal, callId: CallId('gate-3'), name: 'write', arguments: {} })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
