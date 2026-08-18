/** Package-owned invariant companion. @module @deepseek-ai/dsh-web-search-host-bridge/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-web-search-host-bridge'

export const name = 'web-search-host-bridge-invariant'
export const inject = ['invariants']

/** No runtime invariant: the provider owns no durable state or cross-plugin event stream. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
