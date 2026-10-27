/**
 * dsh-fnos-upgrader host entry.
 *
 * Contributes, all optional so the bundle never blocks a profile boot:
 *  - four agent tools (scan / preflight / update / update-core) when a `tools`
 *    service exists;
 *  - five HTTP routes for the web panel when a `webServer` service exists.
 *
 * Nothing here publishes a service, so the row is safe loose in any profile.
 */

import { startBackgroundScanWhenReady } from './background-scan.js'
import { scanAll } from './scan.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ensureAttachmentPatch } from './fnos-patch.js'

export const name = 'dsh-fnos-upgrader'

/**
 * fnOS ships a PATH git without `git-remote-https`, so any `github:` plugin
 * spec dies in pnpm's `git ls-remote` before it reaches the registry. When the
 * operator has dropped a working git shim under `$DSH_HOME/tools/bin`, put it
 * first for this process and every child it spawns.
 */
function ensureWorkingGit() {
  const home = process.env.DSH_HOME
  if (typeof home !== 'string' || home === '') return
  const shim = join(home, 'tools', 'bin')
  if (!existsSync(join(shim, 'git'))) return
  const path = process.env.PATH ?? ''
  if (path.split(':').includes(shim)) return
  process.env.PATH = `${shim}:${path}`
}

export function apply(ctx) {
  ensureWorkingGit()
  // fnOS: keep image attachments storable (the /vol* mount roots are mode 000,
  // so DSH's ancestor-fsync walk fails with EACCES). Idempotent; reapplied after
  // every core update, and effective from the next host start.
  ensureAttachmentPatch()
    .then((result) => {
      if (result.status === 'patched') ctx.logger?.info?.(`[dsh-fnos-upgrader] patched attachment durability (${result.file}) — restart to apply`)
      else if (result.status !== 'already') ctx.logger?.warn?.(`[dsh-fnos-upgrader] attachment patch ${result.status}: ${result.error ?? ''}`)
    })
    .catch(() => {})
  const disposers = []
  let disposed = false
  const stopBackgroundScan = startBackgroundScanWhenReady({
    inject: ctx.inject.bind(ctx),
    scan: scanAll,
    logger: ctx.logger,
  })

  // Agent tools. Callback-form inject: fires when the tools service registers
  // (the Loader mounts entries concurrently, so a synchronous ctx.get at apply
  // time races and usually loses); never blocks this fiber when absent.
  const uninjectTools = ctx.inject(['tools'], (toolsCtx) => {
    import('./tools.js')
      .then((mod) => mod.registerCopilotTools(toolsCtx.tools))
      .then((dispose) => {
        if (dispose === null) {
          ctx.logger?.warn('[dsh-fnos-upgrader] @deepseek-ai/dsh-tools not locatable — agent tools skipped (web routes unaffected)')
          return
        }
        if (disposed) {
          dispose()
        } else {
          disposers.push(dispose)
          ctx.logger?.info?.('[dsh-fnos-upgrader] agent tools registered')
        }
      })
      .catch((error) => {
        ctx.logger?.warn(`[dsh-fnos-upgrader] tools unavailable: ${error instanceof Error ? error.message : String(error)}`)
      })
  })

  // Web panel routes — mount only when the profile composes a webServer.
  const uninjectRoutes = ctx.inject(['webServer'], (webCtx) => {
    import('./routes.js')
      .then((mod) => {
        if (disposed) return undefined
        const dispose = mod.mountCopilotRoutes(webCtx)
        disposers.push(dispose)
        ctx.logger?.info?.('[dsh-fnos-upgrader] web routes mounted')
        return dispose
      })
      .then((dispose) => {
        // Race: disposed while the dynamic import was in flight.
        if (disposed && dispose !== undefined) dispose()
      })
      .catch((error) => {
        ctx.logger?.warn(`[dsh-fnos-upgrader] routes unavailable: ${error instanceof Error ? error.message : String(error)}`)
      })
  })

  return () => {
    disposed = true
    for (const dispose of disposers) {
      try { dispose() } catch { /* best effort */ }
    }
    stopBackgroundScan()
    uninjectTools?.()
    uninjectRoutes?.()
  }
}
