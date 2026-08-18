import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import * as invariant from '@deepseek-ai/dsh-tool-subagent-profiles/src/invariant.ts'

const { applySubagent } = vi.hoisted(() => ({ applySubagent: vi.fn() }))
vi.mock('@deepseek-ai/dsh-tool-subagent', () => ({ apply: applySubagent }))

import {
  apply,
  Config,
  profileToolName,
} from '@deepseek-ai/dsh-tool-subagent-profiles/src/index.ts'

describe('tool-subagent-profiles', () => {
  beforeEach(() => vi.clearAllMocks())

  it('materializes defaults and normalizes names deterministically', () => {
    expect(Config({} as never)).toEqual({ provider: 'spawn', maxDepth: 3, profiles: [] })
    expect(profileToolName('reviewer')).toBe('subagent__reviewer')
    expect(profileToolName('security.reviewer')).toMatch(/^subagent__security_reviewer_[0-9a-f]{12}$/)
    expect(profileToolName('x'.repeat(100))).toHaveLength(64)
  })

  it('registers its package invariant companion', async () => {
    const dispose = vi.fn()
    const register = vi.fn((
      _packageName: string,
      _installer: InvariantInstaller,
    ) => dispose)
    const ctx = { invariants: { register } } as unknown as Context
    await expect(invariant.apply(ctx)).resolves.toBe(dispose)
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-tool-subagent-profiles', expect.any(Function))
    const install = register.mock.calls[0]![1]
    expect(install).toBeTypeOf('function')
    await install(new Context(), (message) => { throw new Error(message) })
  })

  it('projects fixed persona, purpose, tools, and depth into native delegates', () => {
    const ctx = new Context()
    apply(ctx, {
      provider: 'spawn',
      maxDepth: 2,
      profiles: [{
        id: 'reviewer',
        description: 'Review the proposed implementation.',
        persona: 'You are a strict code reviewer.',
        toolFilter: { allow: ['read', 'grep'] },
      }],
    })
    expect(applySubagent).toHaveBeenCalledWith(ctx, {
      provider: 'spawn',
      toolName: 'subagent__reviewer',
      delegationDescription: 'Delegate specifically to the reviewer agent. Review the proposed implementation.',
      enableRunInBackground: false,
      backgroundMode: 'one-shot',
      persona: 'You are a strict code reviewer.',
      toolFilter: { allow: ['read', 'grep'] },
      maxDepth: 2,
    })
  })

  it('rejects empty fields and duplicate identities before the second registration', () => {
    const ctx = new Context()
    expect(() => {
      apply(ctx, {
        provider: 'spawn',
        maxDepth: 3,
        profiles: [{ id: '', description: 'x', persona: 'y' }],
      })
    }).toThrow(/id must be non-empty/)
    expect(() => {
      apply(ctx, {
        provider: 'spawn',
        maxDepth: 3,
        profiles: [{ id: 'same', description: '  ', persona: 'y' }],
      })
    }).toThrow(/description must be non-empty/)
    expect(() => {
      apply(ctx, {
        provider: 'spawn',
        maxDepth: 3,
        profiles: [{ id: 'same', description: 'x', persona: '  ' }],
      })
    }).toThrow(/persona must be non-empty/)
    expect(() => {
      apply(ctx, {
        provider: 'spawn',
        maxDepth: 3,
        profiles: [
          { id: 'same', description: 'x', persona: 'y' },
          { id: 'same', description: 'x', persona: 'y' },
        ],
      })
    }).toThrow(/duplicate normalized tool name/)
  })
})
