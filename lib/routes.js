/**
 * HTTP routes for dsh-fnos-upgrader's web panel. GETs are read-only scans;
 * the mutating routes are POST /update (plugins) and POST /update-core
 * (the harness itself, gated — see docs/adr/0001). Both require same origin
 * and the same trusted socket transport scheme,
 * funnels through the allowlisted executors in update.js, and answers as a
 * Server-Sent Events stream so the panel can render a live progress bar
 * (progress / retry / phase events, then a final `done` event carrying the
 * same outcome object the agent tool returns). Scans are package-centric —
 * plugins are merged across profiles — and /update without a `profile` body
 * field targets only the package's eligible independently owned profiles.
 */
import { PROFILE_RE } from './update.js'

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(body)
}

/** Send one SSE `data:` frame; JSON payload so the client parses uniformly. */
function sendSse(response, event) {
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}

export function sameOrigin(request) {
  const origin = request.headers?.origin
  if (typeof origin !== 'string' || origin === 'null') return false
  const configured = process.env.DSH_FNOS_UPGRADER_PUBLIC_ORIGIN
  if (configured !== undefined) {
    try {
      const publicOrigin = new URL(configured)
      if (publicOrigin.protocol !== 'http:' && publicOrigin.protocol !== 'https:') return false
      return origin === publicOrigin.origin
    } catch {
      return false
    }
  }
  try {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    // fnOS terminates TLS in front of this process: the gateway forwards plain
    // HTTP on loopback, so the browser's https origin can never match the
    // socket transport. The host comparison is the CSRF defence (a cross-site
    // page cannot forge the Host header it addresses), so accept a loopback
    // request whose Origin host is exactly the host the browser used.
    if (loopbackSocket(request) && parsed.host === request.headers?.host) return true
    const transport = request.socket?.encrypted === true ? 'https:' : 'http:'
    return parsed.host === request.headers?.host && parsed.protocol === transport
  } catch {
    return false
  }
}

/** Whether the TCP peer is this machine (the fnOS gateway proxy). */
function loopbackSocket(request) {
  const address = request.socket?.remoteAddress
  if (typeof address !== 'string') return false
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address
  return normalized === '::1' || normalized === '127.0.0.1' || /^127\./.test(normalized)
}

async function readJsonBody(request, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  let body
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const error = new Error('invalid JSON body')
    error.statusCode = 400
    throw error
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('JSON body must be an object')
    error.statusCode = 400
    throw error
  }
  return body
}

export function statusForce(url) {
  return new URL(url ?? '/', 'http://localhost').searchParams.get('force') === '1'
}

/**
 * Register every copilot route on the webServer service.
 * @returns {() => void} disposer removing all routes.
 */
export function mountCopilotRoutes(host) {
  const disposers = []

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: '/fnos-upgrader/status',
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      try {
        const { scanAll } = await import('./scan.js')
        const force = statusForce(request.url)
        sendJson(response, 200, await scanAll(force))
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: '/fnos-upgrader/update',
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: 'untrusted origin' })
        return
      }
      try {
        const body = await readJsonBody(request)
        const name = typeof body.name === 'string' ? body.name : ''
        const hasProfile = Object.prototype.hasOwnProperty.call(body, 'profile')
        const hasProfiles = Object.prototype.hasOwnProperty.call(body, 'profiles')
        if (hasProfile && typeof body.profile !== 'string') {
          sendJson(response, 400, { error: 'profile must be a valid profile name' })
          return
        }
        const profile = hasProfile ? body.profile : ''
        if (hasProfile && profile !== '' && !PROFILE_RE.test(profile)) {
          sendJson(response, 400, { error: 'profile must be a valid profile name' })
          return
        }
        if (hasProfile && hasProfiles) {
          sendJson(response, 400, { error: 'profile and profiles cannot be used together' })
          return
        }
        let profiles
        if (hasProfiles) {
          if (!Array.isArray(body.profiles)
            || body.profiles.some((p) => typeof p !== 'string' || !PROFILE_RE.test(p))
            || new Set(body.profiles).size !== body.profiles.length) {
            sendJson(response, 400, { error: 'profiles must be a list of unique valid profile names' })
            return
          }
          profiles = body.profiles
        }
        const confirm = body.confirm === true
        // Explicit update target (rollback path): validated against the
        // package inside the executor — the route only checks the shape.
        const hasTarget = Object.prototype.hasOwnProperty.call(body, 'target')
        if (hasTarget && (typeof body.target !== 'string' || body.target === '')) {
          sendJson(response, 400, { error: 'target must be a non-empty string' })
          return
        }
        const target = hasTarget ? body.target : undefined
        // Force: overrides a preflight hard block — the executor still
        // records the evidence on the outcome. Anything non-true is absent.
        const force = body.force === true ? true : undefined
        if (name === '') {
          sendJson(response, 400, { error: 'name is required (profile is optional)' })
          return
        }
        if (!confirm) {
          sendJson(response, 400, { error: 'confirm=true is required — updates run only after an explicit decision' })
          return
        }
        const { updatePlugin, updatePluginAll, subscribeProgress } = await import('./update.js')

        // SSE handshake first, then subscribe — progress events only start
        // flowing after the subscription slot is taken (updates are serialized,
        // so a single slot is the whole bus).
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        })
        response.write(':ok\n\n')
        const sub = subscribeProgress((event) => sendSse(response, event))
        response.on('close', () => sub.cancel())

        const outcome = profile === ''
          ? await updatePluginAll(name, {}, { profiles, ...(hasTarget ? { target } : {}), ...(force !== undefined ? { force } : {}) })
          : await updatePlugin(profile, name, {}, { ...(hasTarget ? { target } : {}), ...(force !== undefined ? { force } : {}) })
        sendSse(response, { type: 'done', outcome })
        response.end()
      } catch (error) {
        // Stream may already be open with progress events sent — then the
        // failure is reported as a final `done` frame instead of plain JSON.
        if (!response.headersSent) {
          sendJson(response, error?.statusCode === 400 ? 400 : 500, { error: error instanceof Error ? error.message : String(error) })
        } else {
          try {
            sendSse(response, { type: 'done', outcome: { ok: false, error: error instanceof Error ? error.message : String(error) } })
            response.end()
          } catch { /* response already gone */ }
        }
      }
    },
  }))

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: '/fnos-upgrader/update-core',
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: 'untrusted origin' })
        return
      }
      try {
        const body = await readJsonBody(request)
        const confirm = body.confirm === true
        // Explicit version (rollback/downgrade path): shape-checked here,
        // validated to semver-ish characters inside the executor.
        const hasTarget = Object.prototype.hasOwnProperty.call(body, 'target')
        if (hasTarget && (typeof body.target !== 'string' || body.target === '')) {
          sendJson(response, 400, { error: 'target must be a non-empty string' })
          return
        }
        const force = body.force === true ? true : undefined
        if (!confirm) {
          sendJson(response, 400, { error: 'confirm=true is required — the core update runs only after an explicit decision' })
          return
        }
        const { updateCore, subscribeProgress } = await import('./update.js')

        // fnOS: never install a core the profile cannot boot. Unless the caller
        // pinned a version itself (rollback path), target the newest core that
        // the profile's plugin releases accept, not the absolute newest.
        let pinnedTarget = hasTarget ? body.target : undefined
        let plan = null
        if (!hasTarget) {
          try {
            const { computePlan } = await import('./fnos.js')
            plan = await computePlan(typeof body.profile === 'string' && body.profile !== '' ? body.profile : 'web')
            pinnedTarget = plan.core.target ?? undefined
            if (pinnedTarget !== undefined && pinnedTarget === plan.core.current) {
              // The newest published core is ahead of every plugin release:
              // installing it would leave a profile that cannot boot. Answer on
              // the same SSE contract as a real run so the panel renders it.
              const blockers = (plan.core.blockingForNewest ?? []).map((row) => {
                const version = row.latest ?? row.installed ?? ''
                const supports = row.supports === '' ? '' : `（声明支持 ${row.supports}）`
                return `${row.name}${version === '' ? '' : `@${version}`}${supports}`
              })
              const detail = blockers.length === 0
                ? ''
                : `尚未适配的是：${blockers.slice(0, 4).join('；')}${blockers.length > 4 ? ` 等 ${blockers.length} 个` : ''}。`
              const outcome = {
                ok: false,
                code: 'core_no_compatible_target',
                changed: false,
                upToDate: true,
                current: plan.core.current,
                newestPublished: plan.core.newestPublished,
                blockingPlugins: plan.core.blockingForNewest ?? [],
                plan,
                error: plan.core.newerIncompatible
                  ? `${plan.core.newestPublished} 已发布，但插件还没跟上，因此停在兼容版本 ${plan.core.current}。${detail}强行安装会让 DSH 启动时拒绝这些插件（不是失败，是护栏）。`
                  : `已是最新的兼容版本 ${plan.core.current}`,
              }
              response.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-store',
                connection: 'keep-alive',
              })
              response.write(':ok\n\n')
              sendSse(response, { type: 'done', outcome })
              response.end()
              return
            }
          } catch (error) {
            sendJson(response, 500, { error: `兼容版本计算失败：${error instanceof Error ? error.message : String(error)}` })
            return
          }
        }

        // Same SSE contract as /update: progress events stream, one final
        // `done` frame carries the full outcome object.
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        })
        response.write(':ok\n\n')
        const sub = subscribeProgress((event) => sendSse(response, event))
        response.on('close', () => sub.cancel())

        const outcome = await updateCore({
          ...(pinnedTarget !== undefined ? { target: pinnedTarget } : {}),
          ...(force !== undefined ? { force } : {}),
        })
        // A core install replaces the attachment package; restore the fnOS fix
        // so the next start can still store images.
        if (outcome?.ok === true) {
          import('./fnos-patch.js')
            .then((mod) => mod.ensureAttachmentPatch())
            .catch(() => {})
        }
        const enriched = plan === null ? outcome : { ...outcome, fnosPlan: plan }
        sendSse(response, { type: 'done', outcome: enriched })
        response.end()
      } catch (error) {
        if (!response.headersSent) {
          sendJson(response, error?.statusCode === 400 ? 400 : 500, { error: error instanceof Error ? error.message : String(error) })
        } else {
          try {
            sendSse(response, { type: 'done', outcome: { ok: false, error: error instanceof Error ? error.message : String(error) } })
            response.end()
          } catch { /* response already gone */ }
        }
      }
    },
  }))

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: '/fnos-upgrader/update-status',
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      try {
        // Cheap in-process read (no upstream IO): tells any web seat whether
        // an update is executing right now and which package/profile/target
        // and stage it is on — including updates started by the agent tools
        // or another browser tab, which never stream SSE to this page.
        const { updateStatus } = await import('./update.js')
        sendJson(response, 200, updateStatus())
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: '/fnos-upgrader/logs',
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      const { recentOps } = await import('./util.js')
      sendJson(response, 200, { ops: recentOps() })
    },
  }))

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: '/fnos-upgrader/restart-status',
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      try {
        const { fnosAvailable, fnosGatewayPrefix } = await import('./fnos.js')
        sendJson(response, 200, { available: fnosAvailable(), prefix: fnosGatewayPrefix() })
      } catch (error) {
        sendJson(response, 200, { available: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: '/fnos-upgrader/plan',
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      try {
        const { computePlan } = await import('./fnos.js')
        const url = new URL(request.url ?? '/', 'http://localhost')
        const profile = url.searchParams.get('profile') ?? 'web'
        if (!PROFILE_RE.test(profile)) {
          sendJson(response, 400, { error: 'invalid profile name' })
          return
        }
        sendJson(response, 200, await computePlan(profile, { force: url.searchParams.get('force') === '1' }))
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: '/fnos-upgrader/restart',
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: 'untrusted origin' })
        return
      }
      try {
        const body = await readJsonBody(request)
        if (body.confirm !== true) {
          sendJson(response, 400, { error: 'confirm=true is required' })
          return
        }
        const { fnosAvailable } = await import('./fnos.js')
        if (!fnosAvailable()) {
          sendJson(response, 501, { error: 'not supervised by the fnOS gateway — restart dsh manually' })
          return
        }
        // Answer first, restart after the response is flushed: the gateway
        // kills this process, so anything unflushed would be lost.
        sendJson(response, 200, { ok: true, restarting: true })
        setTimeout(() => {
          import('./fnos.js')
            .then((mod) => mod.restartViaFnosGateway())
            .then((result) => {
              if (!result.ok) console.error('[dsh-fnos-upgrader] gateway restart failed:', result.error ?? result.status)
            })
            .catch((error) => console.error('[dsh-fnos-upgrader] gateway restart failed:', error))
        }, 800).unref?.()
      } catch (error) {
        sendJson(response, error?.statusCode === 400 ? 400 : 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  return () => { for (const dispose of disposers) dispose() }
}
