/** Package-owned invariant companion. @module @deepseek-ai/dsh-tool-subagent-profiles/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-subagent-profiles'
export const name = 'tool-subagent-profiles-invariant'
export const inject = ['invariants']
/** No runtime invariant: profile validation is complete before any tool registration. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
