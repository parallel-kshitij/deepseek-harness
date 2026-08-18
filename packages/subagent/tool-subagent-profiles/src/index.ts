/**
 * Materialize a deployment- or run-supplied roster of named delegates as
 * native `tool-subagent` instances. Every profile fixes a child persona and
 * optional global-tool filter while retaining the in-process provider's depth,
 * cancellation, persistence, sandbox, and result contracts.
 * @module @deepseek-ai/dsh-tool-subagent-profiles
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { apply as applySubagent } from '@deepseek-ai/dsh-tool-subagent'

export const name = 'tool-subagent-profiles'
export const inject = ['tools', 'subagents', 'systemPrompt']

/** One fixed named child profile. */
export interface SubagentProfile {
  /** Stable roster identity shown in the model-facing tool name. */
  id: string
  /** Short purpose prepended to the ordinary delegation contract. */
  description: string
  /** Complete child-specific identity/instructions scoped to the child. */
  persona: string
  /** Optional global-tool filter applied only inside this child. */
  toolFilter?: {
    /** Global DSH tool names the child may use. */
    allow?: string[]
    /** Global DSH tool names removed from the child. */
    deny?: string[]
  }
}

/** Roster configuration. */
export interface Config {
  /** Registered subagent provider used by every named profile. */
  provider: string
  /** Absolute child delegation-depth cap, or provider-owned depth policy. */
  maxDepth: number | 'provider-managed'
  /** Fixed delegates materialized as distinctly named foreground tools. */
  profiles: SubagentProfile[]
}

export const Config: z<Config> = z.object({
  provider: z.string().default('spawn'),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed' as const)]).default(3),
  profiles: z.array(z.object({
    id: z.string().required(),
    description: z.string().required(),
    persona: z.string().required(),
    toolFilter: z.object({
      allow: z.array(z.string()).default(undefined as unknown as string[]),
      deny: z.array(z.string()).default(undefined as unknown as string[]),
    }).default(undefined as unknown as { allow: string[]; deny: string[] }),
  })).default([]),
})

const INVALID_TOOL_CHARS = /[^A-Za-z0-9_-]/g
const MAX_TOOL_NAME = 64
const HASH_LENGTH = 12

/**
 * Deterministic DeepSeek-safe tool name for one roster identity.
 * @param id - stable host profile identity.
 * @returns normalized model-facing tool name.
 */
export function profileToolName(id: string): string {
  const joined = `subagent__${id}`
  const normalized = joined.replace(INVALID_TOOL_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_TOOL_NAME) return normalized
  const hash = createHash('sha256').update(id).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_TOOL_NAME - HASH_LENGTH - 1)}_${hash}`
}

/** Register every profile as a foreground native subagent tool. */
export function apply(ctx: Context, config: Config): void {
  const names = new Set<string>()
  for (const profile of config.profiles) {
    const id = profile.id.trim()
    if (id.length === 0) throw new Error('tool-subagent-profiles: profile id must be non-empty')
    if (profile.description.trim().length === 0) {
      throw new Error(`tool-subagent-profiles: profile ${JSON.stringify(id)} description must be non-empty`)
    }
    if (profile.persona.trim().length === 0) {
      throw new Error(`tool-subagent-profiles: profile ${JSON.stringify(id)} persona must be non-empty`)
    }
    const toolName = profileToolName(id)
    if (names.has(toolName)) {
      throw new Error(`tool-subagent-profiles: duplicate normalized tool name ${JSON.stringify(toolName)}`)
    }
    names.add(toolName)
    applySubagent(ctx, {
      provider: config.provider,
      toolName,
      delegationDescription: `Delegate specifically to the ${id} agent. ${profile.description.trim()}`,
      enableRunInBackground: false,
      backgroundMode: 'one-shot',
      persona: profile.persona,
      ...profile.toolFilter !== undefined ? { toolFilter: profile.toolFilter } : {},
      maxDepth: config.maxDepth,
    })
  }
}
