/**
 * Standalone updater page served by the host at /fnos-upgrader/.
 *
 * The React panel (client/client.js) needs the host's client-module graph and a
 * specific slot to render; this page needs neither. It talks to the same JSON /
 * SSE routes, so a host whose plugin-page slot moved or a browser on a stale
 * bundle still has a working entry point at an ordinary URL.
 */
export function renderUpgraderPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 更新助手</title>
<style>
  :root { color-scheme: dark; --bg:#141518; --card:#1c1e22; --line:#2b2e34; --fg:#e6e7ea; --dim:#9aa0aa; --accent:#6aa4ff; --ok:#3fb950; --warn:#d29922; --bad:#f85149; }
  * { box-sizing: border-box; }
  body { margin:0; padding:20px; background:var(--bg); color:var(--fg); font:14px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; }
  h1 { font-size:16px; margin:0 0 14px; font-weight:600; }
  h2 { font-size:13px; margin:0 0 10px; color:var(--dim); font-weight:600; letter-spacing:.02em; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px; margin-bottom:14px; }
  .row { display:flex; align-items:center; gap:10px; margin:6px 0; }
  .grow { flex:1; min-width:0; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  select, button { font:inherit; color:var(--fg); background:#23262c; border:1px solid var(--line); border-radius:7px; padding:6px 10px; }
  button { cursor:pointer; }
  button:hover:not(:disabled) { border-color:#4a5160; }
  button:disabled { opacity:.45; cursor:default; }
  button.primary { background:#2b4a7a; border-color:#365d99; }
  button.danger { background:#5a2a2a; border-color:#8a3b3b; }
  .note { color:var(--dim); font-size:12px; margin:6px 0; white-space:pre-wrap; }
  .bad { color:var(--bad); }
  .ok { color:var(--ok); }
  .warn { color:var(--warn); }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  td, th { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); }
  th { color:var(--dim); font-weight:500; font-size:12px; }
  pre { margin:0; max-height:220px; overflow:auto; font-family:ui-monospace,monospace; font-size:12px; color:var(--dim); white-space:pre-wrap; }
  .tag { display:inline-block; padding:0 6px; border-radius:999px; font-size:11px; border:1px solid var(--line); color:var(--dim); }
</style>
</head>
<body>
<h1>DSH 更新助手 <span class="tag" id="origin"></span></h1>

<div class="card">
  <h2>本体</h2>
  <div class="row"><span class="grow">当前运行</span><b class="mono" id="core-cur">—</b></div>
  <div class="row"><span class="grow">目标版本</span><select id="core-target" style="min-width:280px"></select></div>
  <div class="note" id="core-note"></div>
  <div class="row">
    <button class="primary" id="core-install">安装所选版本</button>
    <button id="restart">重启 DSH</button>
    <button id="reload">刷新状态</button>
  </div>
</div>

<div class="card">
  <h2>插件</h2>
  <table><thead><tr><th>插件</th><th>已装</th><th>最新</th><th></th></tr></thead><tbody id="plugins"></tbody></table>
</div>

<div class="card"><h2>日志</h2><pre id="log">等待操作…</pre></div>

<script>
const base = new URL('.', location.href)
const el = (id) => document.getElementById(id)
const log = (line) => { const p = el('log'); p.textContent += (p.textContent === '等待操作…' ? '' : '\\n') + line; p.scrollTop = p.scrollHeight }
document.getElementById('origin').textContent = location.host

let state = { plan: null, choices: null, chosen: null }

async function get(path) {
  const res = await fetch(new URL(path.replace(/^\\/+/, ''), base), { cache: 'no-store', credentials: 'same-origin' })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status))
  return body
}

function renderCore() {
  const plan = state.plan, choices = state.choices
  if (plan) el('core-cur').textContent = plan.core.current + (plan.core.newestPublished ? '（最新发布 ' + plan.core.newestPublished + '）' : '')
  const sel = el('core-target')
  if (choices) {
    sel.innerHTML = ''
    for (const v of choices.versions) {
      const mark = v.compatible ? '✓' : (v.compatibleAfterUpdate ? '⚠ 需先更新插件' : '✖ 不兼容')
      const opt = document.createElement('option')
      opt.value = v.version
      opt.textContent = v.version + '  ' + mark + (v.relation === 'same' ? ' · 当前' : '')
      sel.appendChild(opt)
    }
    if (state.chosen) sel.value = state.chosen
    else if (choices.recommended) sel.value = choices.recommended
    state.chosen = sel.value
  }
  const row = choices?.versions.find((v) => v.version === sel.value)
  if (row && !row.compatible) {
    const names = (row.blocking || []).map((b) => b.name + (b.supports ? '（' + b.supports + '）' : '')).join('；')
    el('core-note').innerHTML = '<span class="bad">这些插件不接受该版本：' + names + '</span>'
      + (row.compatibleAfterUpdate ? '\\n<span class="warn">先把上面的插件更新到最新版，再装这个版本即可。</span>' : '')
  } else if (row) {
    el('core-note').textContent = row.relation === 'same' ? '就是当前版本' : '该版本会被这些插件接受。'
  }
}

function renderPlugins() {
  const body = el('plugins')
  body.innerHTML = ''
  const rows = state.plan?.plugins || []
  if (rows.length === 0) { body.innerHTML = '<tr><td colspan="4" class="note">没有可管理的插件</td></tr>'; return }
  for (const p of rows) {
    const tr = document.createElement('tr')
    tr.innerHTML = '<td class="mono"></td><td class="mono"></td><td class="mono"></td><td></td>'
    tr.children[0].textContent = p.name
    tr.children[1].textContent = p.installed || '—'
    tr.children[2].textContent = p.latest || '—'
    if (p.updateAvailable) {
      const btn = document.createElement('button')
      btn.textContent = '更新'
      btn.onclick = () => updatePlugin(p.name, btn)
      tr.children[3].appendChild(btn)
    } else {
      tr.children[3].innerHTML = '<span class="note">已最新</span>'
    }
    body.appendChild(tr)
  }
}

async function stream(path, body, onEvent) {
  const res = await fetch(new URL(path.replace(/^\\/+/, ''), base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}))
    throw new Error(payload.error || ('HTTP ' + res.status))
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let outcome = null
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let cut
    while ((cut = buffer.indexOf('\\n\\n')) !== -1) {
      const frame = buffer.slice(0, cut); buffer = buffer.slice(cut + 2)
      for (const line of frame.split('\\n')) {
        if (!line.startsWith('data: ')) continue
        let event
        try { event = JSON.parse(line.slice(6)) } catch { continue }
        if (event.type === 'done') outcome = event.outcome
        else onEvent?.(event)
      }
    }
  }
  return outcome
}

async function refresh() {
  el('reload').disabled = true
  try {
    const [plan, choices] = await Promise.all([get('plan?profile=web'), get('core-versions?profile=web')])
    state.plan = plan; state.choices = choices
    renderCore(); renderPlugins()
  } catch (e) { log('刷新失败: ' + e.message) }
  finally { el('reload').disabled = false }
}

el('core-target').onchange = () => { state.chosen = el('core-target').value; renderCore() }

el('core-install').onclick = async () => {
  const row = state.choices?.versions.find((v) => v.version === state.chosen)
  if (!row) return
  if (row.relation === 'same') { log('已经是当前版本'); return }
  const force = row.relation === 'downgrade' || !row.compatible
  if (!confirm((force ? '⚠️ 该版本与已装插件不完全兼容（或为降级），继续会以 force 越过闸门。\\n\\n' : '') + '安装 @deepseek-ai/dsh@' + row.version + ' ？')) return
  el('core-install').disabled = true
  log('开始安装本体 ' + row.version + (force ? '（force）' : ''))
  try {
    const outcome = await stream('update-core', { confirm: true, target: row.version, ...(force ? { force: true } : {}) }, (ev) => {
      if (ev.type === 'progress' && ev.percent !== undefined) log('  进度 ' + ev.percent + '%')
      else if (ev.type === 'phase') log('  阶段 ' + ev.phase)
    })
    log(outcome?.ok ? '✓ 已安装 ' + (outcome.after || row.version) + '，重启后生效' : '✗ ' + (outcome?.error || '失败'))
    if (outcome?.ok) await refresh()
  } catch (e) { log('✗ ' + e.message) }
  finally { el('core-install').disabled = false }
}

async function updatePlugin(name, btn) {
  btn.disabled = true
  log('更新 ' + name + ' …')
  try {
    const outcome = await stream('update', { name, profile: 'web' }, (ev) => {
      if (ev.type === 'progress') log('  ' + (ev.phase || ev.type))
    })
    const item = outcome?.items?.find((i) => i.profile === 'web') || outcome
    log(item?.ok ? '✓ ' + name + ' → ' + (item.after?.version || '已更新') : '✗ ' + name + ' ' + (item?.error || outcome?.error || '失败'))
    await refresh()
  } catch (e) { log('✗ ' + e.message) }
  finally { btn.disabled = false }
}

el('restart').onclick = async () => {
  if (!confirm('重启 DSH Web？页面会短暂断开。')) return
  el('restart').disabled = true
  try {
    await fetch(new URL('restart', base), { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ confirm: true }) })
    log('重启中，等待服务恢复…')
    const deadline = Date.now() + 90000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500))
      try { const probe = await fetch(base, { cache: 'no-store' }); if (probe.ok) { location.reload(); return } } catch {}
    }
    log('重启超时，请到飞牛应用页检查')
  } catch (e) { log('重启失败: ' + e.message) }
  finally { el('restart').disabled = false }
}

el('reload').onclick = refresh
refresh()
</script>
</body>
</html>`
}
