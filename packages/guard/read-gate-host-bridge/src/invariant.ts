/** Package-owned invariant companion. @module @deepseek-ai/dsh-read-gate-host-bridge/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-read-gate-host-bridge'
export const name = 'read-gate-host-bridge-invariant'
export const inject = ['invariants']
/** No runtime invariant: hook ordering and fail-open behavior are covered by package tests. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
