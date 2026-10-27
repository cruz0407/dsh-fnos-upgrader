/**
 * fnOS host integration for dsh-fnos-upgrader.
 *
 * Three jobs, all fnOS-specific:
 *  1. Detect the fnOS app gateway (`app.sock` + `ui/config`) that supervises
 *     this dsh web process, and restart it through the gateway's own control
 *     endpoint — the only restart path that actually brings dsh back on fnOS
 *     (dsh itself is not under systemd/pm2 here).
 *  2. Resolve the newest DSH core version that the installed (or latest
 *     published) profile plugins actually accept, so "更新本体" can never
 *     install a core the profile cannot boot.
 *  3. Turn that into a plan the panel and the routes can show.
 *
 * Removed plugins' peer ranges are read from disk (`profiles/<name>/node_modules`)
 * because a plugin's declared peers are the compatibility contract DSH enforces
 * at boot.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'

const REGISTRY_FALLBACK = 'https://registry.npmmirror.com'
const CACHE_TTL_MS = 5 * 60 * 1000

/** The fnOS app directory that supervises this process. */
export function fnosAppDir() {
  const fromEnv = process.env.DSH_CWD
  if (typeof fromEnv === 'string' && fromEnv !== '' && existsSync(join(fromEnv, 'app.sock'))) return fromEnv
  const candidates = [
    '/vol2/@appcenter/fn-deepseek-harness',
    '/var/apps/fn-deepseek-harness',
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'app.sock'))) return dir
  }
  return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : null
}

/** Gateway prefix declared by the fnOS app (`/app/<appname>`), or ''. */
export function fnosGatewayPrefix(appDir = fnosAppDir()) {
  if (appDir === null) return ''
  const fromEnv = process.env.DSH_FNOS_GATEWAY_PREFIX
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  try {
    const config = JSON.parse(readFileSync(join(appDir, 'ui', 'config'), 'utf8'))
    const entries = Object.values(config['.url'] ?? {})
    const prefix = entries[0]?.gatewayPrefix
    if (typeof prefix === 'string') return prefix
  } catch { /* not an fnOS layout */ }
  return ''
}

/** Whether this process is supervised by the fnOS gateway. */
export function fnosAvailable() {
  const appDir = fnosAppDir()
  return appDir !== null && existsSync(join(appDir, 'app.sock'))
}

/** Restart dsh web through the fnOS gateway control endpoint. */
export function restartViaFnosGateway() {
  const appDir = fnosAppDir()
  if (appDir === null) return Promise.resolve({ ok: false, error: 'not an fnOS deployment (no app.sock)' })
  const socketPath = process.env.DSH_FNOS_APP_SOCKET || join(appDir, 'app.sock')
  const prefix = fnosGatewayPrefix(appDir)
  const path = `${prefix}/__fnos-gateway/control/web/restart`
  return new Promise((resolve) => {
    const req = request({
      socketPath,
      path,
      method: 'POST',
      headers: {
        // The gateway expects the fnOS panel's own admin fetch headers.
        // The socket is only reachable by the app's runtime user.
        'x-requested-with': 'fetch',
        'x-trim-isadmin': 'true',
        'content-length': '0',
      },
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        let parsed = null
        try { parsed = JSON.parse(body) } catch { /* plain text */ }
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          result: parsed ?? body.slice(0, 300),
        })
      })
    })
    req.setTimeout(15000, () => req.destroy(new Error('gateway restart timed out')))
    req.on('error', (error) => resolve({ ok: false, error: error.message }))
    req.end()
  })
}

// ---------------------------------------------------------------------------
// Registry + semver (includePrerelease semantics: the ecosystem pins exact
// `0.2.1-rc.N` peers and ranges like `>=0.2.1-rc.1`, so prereleases compare
// plainly here).
// ---------------------------------------------------------------------------

/** Registry base URL from the environment, falling back to the npmmirror. */
export function registryBase() {
  const configured = process.env.DSH_FNOS_UPGRADER_REGISTRY
    || process.env.NPM_CONFIG_REGISTRY
  if (typeof configured === 'string' && /^https?:\/\//.test(configured)) return configured.replace(/\/+$/, '')
  try {
    const npmrc = process.env.NPM_CONFIG_USERCONFIG
    if (typeof npmrc === 'string' && existsSync(npmrc)) {
      const line = readFileSync(npmrc, 'utf8').split('\n').find((l) => /^\s*registry\s*=/.test(l))
      const value = line?.split('=')[1]?.trim()
      if (value && /^https?:\/\//.test(value)) return value.replace(/\/+$/, '')
    }
  } catch { /* ignore */ }
  return REGISTRY_FALLBACK
}

const metaCache = new Map()

/** Fetch a package's registry metadata (cached briefly). */
export async function packageMeta(name, { force = false } = {}) {
  const key = `${registryBase()}|${name}`
  const hit = metaCache.get(key)
  if (!force && hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.value
  const response = await fetch(`${registryBase()}/${name}`, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`registry ${response.status} for ${name}`)
  const value = await response.json()
  metaCache.set(key, { at: Date.now(), value })
  return value
}

function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text).trim())
  if (match === null) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ?? '' }
}

function comparePre(a, b) {
  if (a === b) return 0
  if (a === '') return 1
  if (b === '') return -1
  const left = a.split('.')
  const right = b.split('.')
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i]
    const y = right[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const diff = Number(x) - Number(y)
      if (diff !== 0) return diff < 0 ? -1 : 1
      continue
    }
    if (xn) return -1
    if (yn) return 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** Compare two semver strings; null when either is unparseable. */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return null
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  return comparePre(left.pre, right.pre)
}

function nextMajor(version) {
  return `${version.major + 1}.0.0`
}

function bumpMinor(version) {
  return `${version.major}.${version.minor + 1}.0`
}

function bumpPatch(version) {
  return `${version.major}.${version.minor}.${version.patch + 1}`
}

function satisfiesComparator(version, token) {
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token.trim())
  if (match === null) return true
  const operator = match[1] ?? '='
  const raw = match[2].trim()
  if (raw === '' || raw === '*' || raw === 'x') return true
  const target = parseVersion(raw.replace(/^v/, ''))
  const value = parseVersion(version)
  if (target === null || value === null) return false
  const order = compareVersions(version, raw.replace(/^v/, ''))
  if (order === null) return false
  switch (operator) {
    case '>=': return order >= 0
    case '<=': return order <= 0
    case '>': return order > 0
    case '<': return order < 0
    case '=': return order === 0
    case '^': {
      if (order < 0) return false
      const upper = target.major > 0
        ? nextMajor(target)
        : target.minor > 0
          ? `0.${target.minor + 1}.0`
          : bumpPatch(target)
      return compareVersions(version, upper) < 0
    }
    case '~': {
      if (order < 0) return false
      return compareVersions(version, bumpMinor(target)) < 0
    }
    default: return true
  }
}

/** Semver range check supporting exact, ^, ~, >=, <=, >, <, = and `||`. */
export function satisfies(version, range) {
  if (typeof range !== 'string' || range.trim() === '') return true
  return range.split('||').some((alternative) => {
    const tokens = alternative.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return true
    return tokens.every((token) => satisfiesComparator(version, token))
  })
}

// ---------------------------------------------------------------------------
// Profile scanning
// ---------------------------------------------------------------------------

/** Every profile directory under DSH_HOME. */
export function listProfiles(dshHome = process.env.DSH_HOME) {
  if (typeof dshHome !== 'string' || dshHome === '') return []
  const root = join(dshHome, 'profiles')
  try {
    return readdirSync(root).filter((name) => {
      try { return statSync(join(root, name)).isDirectory() } catch { return false }
    })
  } catch {
    return []
  }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/** Installed plugin packages of one profile, with their declared peers. */
export function profilePlugins(profile, dshHome = process.env.DSH_HOME) {
  const dir = join(dshHome, 'profiles', profile)
  const manifest = readJson(join(dir, 'package.json'))
  if (manifest === null) return []
  const rows = []
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const installed = readJson(join(dir, 'node_modules', ...name.split('/'), 'package.json'))
    rows.push({
      name,
      requested: manifest.dependencies[name],
      installed: installed?.version ?? null,
      peers: installed?.peerDependencies ?? null,
    })
  }
  return rows
}

/** Peer ranges that pin a DSH host package version (the boot-time contract). */
function dshPeerRanges(peers) {
  if (peers === null || typeof peers !== 'object') return []
  return Object.entries(peers)
    .filter(([name, range]) => /^@deepseek-ai\/dsh-/.test(name) && typeof range === 'string' && /\d\.\d/.test(range))
    .map(([name, range]) => ({ name, range }))
}

/** Does `version` satisfy every DSH peer range of a plugin manifest? */
function pluginAccepts(peers, version) {
  const ranges = dshPeerRanges(peers)
  if (ranges.length === 0) return true
  return ranges.every((entry) => satisfies(version, entry.range))
}

/**
 * Compute the upgrade plan for a profile:
 *  - `plugins`: installed vs latest, and whether the latest accepts `core`.
 *  - `core`: current, newest published, and the newest version that every
 *    plugin's *latest* release (falling back to the installed release when
 *    there is no newer one) accepts.
 */
export async function computePlan(profile, { force = false } = {}) {
  const coreMeta = await packageMeta('@deepseek-ai/dsh', { force })
  const versions = Object.keys(coreMeta.versions ?? {})
    .filter((v) => /^\d+\.\d+\.\d+/.test(v))
    .sort((a, b) => -(compareVersions(a, b) ?? 0))
  const current = readJson(join(process.env.DSH_HOME ?? '', '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))?.version
    ?? coreMeta['dist-tags']?.latest
    ?? null

  const plugins = []
  for (const row of profilePlugins(profile)) {
    if (row.name.startsWith('@deepseek-ai/') && !row.name.startsWith('@deepseek-ai/dsh-experimental')) continue
    if (row.name === 'dsh-fnos-upgrader') continue
    let latest = null
    let latestPeers = null
    try {
      const meta = await packageMeta(row.name, { force })
      latest = meta['dist-tags']?.latest ?? null
      latestPeers = meta.versions?.[latest]?.peerDependencies ?? null
    } catch { /* unlisted package (git/file spec) */ }
    const targetPeers = latestPeers ?? row.peers
    const supported = [...new Set(dshPeerRanges(targetPeers).map((entry) => entry.range))]
    plugins.push({
      name: row.name,
      installed: row.installed,
      latest,
      updateAvailable: latest !== null && row.installed !== null
        && (compareVersions(latest, row.installed) ?? 0) > 0,
      supports: supported.join(' '),
      acceptsCore: (version) => pluginAccepts(targetPeers, version),
    })
  }

  const newestPublished = versions[0] ?? null
  const compatibleCore = versions.find((version) =>
    current === null || (compareVersions(version, current) ?? 0) > 0
      ? plugins.every((plugin) => plugin.acceptsCore(version))
      : false) ?? null

  const pickCore = compatibleCore ?? current
  const blocked = plugins
    .filter((plugin) => !plugin.acceptsCore(pickCore ?? ''))
    .map((plugin) => plugin.name)

  // Which plugins keep the newest published core out: that is the answer a
  // user needs when "更新本体" refuses, so carry the release they are on and
  // the host range they declare.
  const blockingForNewest = newestPublished === null ? [] : plugins
    .filter((plugin) => !plugin.acceptsCore(newestPublished))
    .map((plugin) => ({
      name: plugin.name,
      installed: plugin.installed,
      latest: plugin.latest,
      supports: plugin.supports,
    }))

  return {
    profile,
    core: {
      current,
      newestPublished,
      target: pickCore,
      // A newer core exists but no plugin version accepts it yet.
      newerIncompatible: newestPublished !== null && pickCore !== null
        && (compareVersions(newestPublished, pickCore) ?? 0) > 0,
      blockedBy: blocked,
      blockingForNewest,
    },
    plugins: plugins.map(({ acceptsCore, supports, ...rest }) => rest),
    fnos: { available: fnosAvailable(), gatewayPrefix: fnosGatewayPrefix() },
    generatedAt: new Date().toISOString(),
  }
}
