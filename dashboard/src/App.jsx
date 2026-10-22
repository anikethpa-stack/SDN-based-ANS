import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  LineChart, Line, AreaChart, Area, XAxis, YAxis, Tooltip, Legend,
  CartesianGrid, ResponsiveContainer, ReferenceLine,
} from 'recharts'

const API = `http://${window.location.hostname}:5000`
const PATHS = ['A', 'B', 'C']
const PCOLOR = { A: '#22d3ee', B: '#f1f5f9', C: '#a78bfa' }
const GRID = '#1f3266'
const DEFAULT_PROFILES = {
  A: { name: 'Home Wi-Fi', kind: 'Wi-Fi', delay_ms: 15, bw_mbps: 10, penalty: 0 },
  B: { name: 'Mobile data', kind: 'Cellular, metered', delay_ms: 45, bw_mbps: 6, penalty: 15 },
  C: { name: 'College network', kind: 'Campus LAN', delay_ms: 5, bw_mbps: 10, penalty: 0 },
}

/* ---------------------------------------------------------------- helpers */
async function api(path, opts) {
  const r = await fetch(API + path, opts)
  return r.json()
}
const post = (path, body) =>
  api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  })

function download(url) {
  const a = document.createElement('a')
  a.href = API + url
  a.download = ''
  document.body.appendChild(a)
  a.click()
  a.remove()
}

function health(m, prof, inj) {
  if (!m) return 'unknown'
  if (inj?.away) return 'away'
  if (!m.up) return 'down'
  const base = (prof?.delay_ms ?? 5) + 3
  const lat = m.latency_ms ?? base
  if (lat > base + 120 || m.loss_pct > 10) return 'critical'
  if (lat > base + 40 || m.loss_pct > 3) return 'degraded'
  return 'good'
}
const HLABEL = {
  good: 'Healthy', degraded: 'Degraded', critical: 'Critical',
  down: 'Link down', away: 'Out of range', unknown: 'No data',
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

function fmtDur(s) {
  s = Math.max(0, Math.floor(s))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60
  const mm = String(m).padStart(2, '0'), ss = String(x).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/* ------------------------------------------------------------------ sound */
// All sounds are generated with the Web Audio API, so no audio files are needed.
let audioCtx = null
function audio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return null
    audioCtx = new AC()
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
  return audioCtx
}
function tone(c, { freq, to, dur, type = 'sine', gain = 0.1, start = 0 }) {
  const t0 = c.currentTime + start
  const o = c.createOscillator()
  const g = c.createGain()
  o.type = type
  o.frequency.setValueAtTime(freq, t0)
  if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur)
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(Math.max(gain, 0.0002), t0 + 0.015)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  o.connect(g)
  g.connect(c.destination)
  o.start(t0)
  o.stop(t0 + dur + 0.05)
}
const SOUNDS = {
  // two short beeps, repeated once a second while a network is in trouble
  alarm: (c, v) => {
    tone(c, { freq: 880, dur: 0.16, type: 'square', gain: 0.16 * v })
    tone(c, { freq: 660, dur: 0.16, type: 'square', gain: 0.16 * v, start: 0.2 })
  },
  // lower, longer tones when no network is reachable at all
  nonet: (c, v) => {
    tone(c, { freq: 440, dur: 0.3, type: 'sawtooth', gain: 0.18 * v })
    tone(c, { freq: 330, dur: 0.3, type: 'sawtooth', gain: 0.18 * v, start: 0.35 })
  },
  // a rising sweep at the moment the controller moves the traffic
  switch: (c, v) => tone(c, { freq: 280, to: 1100, dur: 0.3, type: 'sawtooth', gain: 0.12 * v }),
  // three rising notes when a healthy network is connected
  connected: (c, v) => [523.25, 659.25, 783.99].forEach((f, i) =>
    tone(c, { freq: f, dur: 0.4, gain: 0.22 * v, start: i * 0.13 })),
}
const volumeOf = (level) => (level / 100) ** 2
function playSound(name, level) {
  const v = volumeOf(level)
  const c = v > 0 ? audio() : null
  if (c) SOUNDS[name](c, v)
}

/* ------------------------------------------------- live packet animation */
const LINK_COLOR = {
  good: 'rgba(74,222,128,0.65)', degraded: 'rgba(251,113,133,0.8)',
  critical: 'rgba(239,68,68,0.9)', down: 'rgba(127,29,29,0.9)',
  away: 'rgba(100,116,139,0.45)', unknown: 'rgba(100,116,139,0.5)',
}
const HOST_SEG = 0.22 // seconds a packet needs for the short host-to-switch links

// Position of a packet that has travelled t seconds along a route whose
// segments take durs[i] seconds each.
function posOn(pts, durs, t) {
  for (let i = 0; i < durs.length; i++) {
    if (t <= durs[i]) {
      const k = durs[i] ? t / durs[i] : 1
      const a = pts[i], b = pts[i + 1]
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }
    }
    t -= durs[i]
  }
  return pts[pts.length - 1]
}

function PacketFlow({ status, slow, profiles }) {
  const canvasRef = useRef(null)
  const stRef = useRef(status)
  const slowRef = useRef(slow)
  const profRef = useRef(profiles)
  useEffect(() => { stRef.current = status }, [status])
  useEffect(() => { slowRef.current = slow }, [slow])
  useEffect(() => { profRef.current = profiles }, [profiles])

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    let W = 0, H = 0, raf = 0, last = performance.now()
    let packets = [], bursts = [], dataAcc = 0, probeAcc = 0

    const resize = () => {
      const r = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      W = r.width; H = r.height
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    const geo = () => {
      const yc = H * 0.58
      const ys = { A: H * 0.31, B: yc, C: H * 0.87 }
      const g = {
        h1: { x: W * 0.07, y: yc }, s1: { x: W * 0.25, y: yc },
        s2: { x: W * 0.75, y: yc }, h2: { x: W * 0.93, y: yc },
        ctl: { x: W * 0.5, y: H * 0.07 }, mid: {},
      }
      PATHS.forEach((p) => { g.mid[p] = { x: W * 0.5, y: ys[p] } })
      return g
    }
    const route = (g, kind, p) =>
      kind === 'data' ? [g.h1, g.s1, g.mid[p], g.s2, g.h2] : [g.s1, g.mid[p], g.s2]

    // The time a packet spends on a network is the measured latency stretched
    // by the slow-motion factor, so a 48 ms network really looks slower than a
    // 5 ms one instead of everything moving at the same speed.
    const spawn = (kind, p, m) => {
      const prof = profRef.current[p]
      const lat = m.latency_ms ?? ((prof?.delay_ms ?? 5) + 3)
      const half = clamp((lat / 1000) * slowRef.current / 2, 0.15, 7)
      const durs = kind === 'data' ? [HOST_SEG, half, half, HOST_SEG] : [half, half]
      const lead = kind === 'data' ? HOST_SEG : 0
      let dropT = null
      if (!m.up) dropT = lead + half * 0.9
      else if (Math.random() * 100 < (m.loss_pct || 0)) dropT = lead + half * 2 * (0.15 + Math.random() * 0.7)
      if (packets.length < 500) packets.push({ kind, p, durs, t: 0, dropT, total: durs.reduce((a, b) => a + b, 0) })
    }

    const drawLink = (a, b, color, width, dash, glow) => {
      ctx.save()
      ctx.strokeStyle = color; ctx.lineWidth = width
      ctx.setLineDash(dash || [])
      if (glow) { ctx.shadowColor = color; ctx.shadowBlur = 12 }
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
      ctx.restore()
    }
    const label = (txt, x, y, color, size, align, weight) => {
      ctx.fillStyle = color
      ctx.font = `${weight || 500} ${size || 12}px Barlow, system-ui, sans-serif`
      ctx.textAlign = align || 'center'
      ctx.fillText(txt, x, y)
    }
    const node = (pt, w, h, fill, stroke, round) => {
      ctx.fillStyle = fill; ctx.strokeStyle = stroke; ctx.lineWidth = 2
      ctx.beginPath()
      if (round) ctx.arc(pt.x, pt.y, w / 2, 0, Math.PI * 2)
      else ctx.roundRect(pt.x - w / 2, pt.y - h / 2, w, h, 6)
      ctx.fill(); ctx.stroke()
    }

    const frame = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const st = stRef.current
      const profs = profRef.current
      const g = geo()
      const live = st && !st.stale && st.paths
      const active = live ? st.active : null
      const dec = live ? st.decision : null
      const injOf = (p) => st?.impair?.[p]

      if (live && active && st.paths[active]) {
        const m = st.paths[active]
        const cap = profs[active]?.bw_mbps ?? 10
        dataAcc += (1.2 + Math.min(m.tx_mbps || 0, cap) * 1.6) * dt
        while (dataAcc >= 1) { dataAcc -= 1; spawn('data', active, m) }
      }
      if (live) {
        probeAcc += dt
        if (probeAcc >= 0.5) {
          probeAcc = 0
          PATHS.forEach((p) => {
            const m = st.paths[p]
            if (m && !injOf(p)?.away) spawn('probe', p, m)
          })
        }
      }

      ctx.clearRect(0, 0, W, H)

      // controller and control channel
      const ctlCol = 'rgba(148,163,184,0.45)'
      drawLink(g.ctl, g.s1, ctlCol, 1.5, [5, 5])
      drawLink(g.ctl, g.s2, ctlCol, 1.5, [5, 5])
      node(g.ctl, 150, 26, '#0d1737', '#4ade80')
      label('OS-Ken controller', g.ctl.x, g.ctl.y + 4, '#e8eefc', 12, 'center', 600)

      // links
      const edge = 'rgba(226,232,240,0.45)'
      drawLink(g.h1, g.s1, edge, 3)
      drawLink(g.s2, g.h2, edge, 3)
      PATHS.forEach((p) => {
        const m = live ? st.paths[p] : null
        const h = health(m, profs[p], injOf(p))
        const col = LINK_COLOR[h]
        const dash = h === 'down' ? [7, 6] : h === 'away' ? [3, 7] : null
        const w = p === active ? 4.5 : 2.5
        const glow = p === active && h !== 'down' && h !== 'away'
        drawLink(g.s1, g.mid[p], col, w, dash, glow)
        drawLink(g.mid[p], g.s2, col, w, dash, glow)
        if (h === 'down') {
          const x = (g.s1.x + g.mid[p].x) / 2, y = (g.s1.y + g.mid[p].y) / 2
          ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 3
          ctx.beginPath()
          ctx.moveTo(x - 7, y - 7); ctx.lineTo(x + 7, y + 7)
          ctx.moveTo(x + 7, y - 7); ctx.lineTo(x - 7, y + 7)
          ctx.stroke()
        }
      })

      // nodes
      node(g.h1, 30, 30, '#0d1737', '#e2e8f0', true)
      node(g.h2, 30, 30, '#0d1737', '#e2e8f0', true)
      label('h1', g.h1.x, g.h1.y + 4, '#e8eefc', 12)
      label('h2', g.h2.x, g.h2.y + 4, '#e8eefc', 12)
      node(g.s1, 34, 34, '#0d1737', '#e2e8f0')
      node(g.s2, 34, 34, '#0d1737', '#e2e8f0')
      label('s1', g.s1.x, g.s1.y + 4, '#e8eefc', 12)
      label('s2', g.s2.x, g.s2.y + 4, '#e8eefc', 12)
      PATHS.forEach((p) => {
        const m = live ? st.paths[p] : null
        const prof = profs[p]
        const h = health(m, prof, injOf(p))
        const mid = g.mid[p]
        const stroke = h === 'down' ? '#ef4444' : h === 'away' ? '#475569' : p === active ? '#4ade80' : '#e2e8f0'
        node(mid, 34, 34, h === 'down' ? '#000' : '#0d1737', stroke)
        label(p, mid.x, mid.y + 5, h === 'away' ? '#64748b' : PCOLOR[p], 14, 'center', 700)
        label(`${prof.name}${p === active ? '  (active)' : ''}`, mid.x, mid.y - 28, h === 'away' ? '#64748b' : '#e8eefc', 12, 'center', 600)
        let line1 = 'no data', line2 = ''
        if (h === 'away') line1 = 'out of range here'
        else if (m && !m.up) line1 = 'link down'
        else if (m) {
          line1 = `${m.latency_ms ?? '--'} ms   ${m.loss_pct}% loss   ${m.tx_mbps} Mbps`
          const lat = m.latency_ms ?? 0
          line2 = `a packet takes ${((lat / 1000) * slowRef.current).toFixed(1)} s here on screen`
        }
        label(line1, mid.x, mid.y + 34, h === 'down' ? '#ef4444' : h === 'away' ? '#64748b' : '#9fb3e0', 11)
        if (line2) label(line2, mid.x, mid.y + 48, '#6f84b5', 10.5)

        // the network the controller is thinking of switching to
        if (dec && dec.challenger === p && (dec.state === 'challenger' || dec.state === 'cooldown')) {
          const pulse = 3 * Math.sin(now / 180)
          ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 2
          ctx.setLineDash([4, 4])
          ctx.beginPath(); ctx.arc(mid.x, mid.y, 27 + pulse, 0, Math.PI * 2); ctx.stroke()
          ctx.setLineDash([])
          label(`taking over ${dec.streak}/${dec.need}`, mid.x + 36, mid.y + 4, '#ffffff', 12, 'left', 700)
        }
      })

      // packets
      const next = []
      for (const k of packets) {
        k.t += dt
        const pts = route(g, k.kind, k.p)
        if (k.dropT != null && k.t >= k.dropT) {
          const pos = posOn(pts, k.durs, k.dropT)
          bursts.push({ x: pos.x, y: pos.y, age: 0 })
          continue
        }
        if (k.t >= k.total) continue
        const pos = posOn(pts, k.durs, k.t)
        ctx.save()
        if (k.kind === 'data') {
          ctx.fillStyle = '#4ade80'; ctx.shadowColor = '#4ade80'; ctx.shadowBlur = 10
          ctx.beginPath(); ctx.arc(pos.x, pos.y, 4.2, 0, Math.PI * 2); ctx.fill()
        } else {
          ctx.fillStyle = '#ffffff'
          ctx.beginPath(); ctx.arc(pos.x, pos.y, 2.2, 0, Math.PI * 2); ctx.fill()
        }
        ctx.restore()
        next.push(k)
      }
      packets = next

      bursts = bursts.filter((b) => (b.age += dt) < 0.6)
      bursts.forEach((b) => {
        const t = b.age / 0.6
        ctx.strokeStyle = `rgba(239,68,68,${1 - t})`
        ctx.lineWidth = 2
        ctx.beginPath(); ctx.arc(b.x, b.y, 4 + t * 14, 0, Math.PI * 2); ctx.stroke()
      })

      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [])

  return <canvas ref={canvasRef} className="flow-canvas" />
}

/* ------------------------------------------------------------- card parts */
function Meter({ label, value, unit, pct, tone, flow }) {
  return (
    <div className="meter">
      <div className="meter-top">
        <span>{label}</span>
        <b>{value} <small>{unit}</small></b>
      </div>
      <div className="track">
        <div
          className={`fill ${tone}${flow ? ' flow' : ''}`}
          style={{ width: `${clamp(pct, 2, 100)}%`, ...(flow ? { animationDuration: `${flow}s` } : {}) }}
        />
      </div>
    </div>
  )
}

function Slider({ label, min, max, step, value, unit, onChange }) {
  return (
    <label className="slider">
      <span className="slider-top"><span>{label}</span><b>{value} {unit}</b></span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}

function PathCard({ p, prof, m, inj, active, flash, draft, onEdit, onPreset, onLink, onReset }) {
  const h = health(m, prof, inj)
  const away = h === 'away'
  const lat = m?.latency_ms
  const loss = m?.loss_pct ?? 0
  const tx = m?.tx_mbps ?? 0
  const base = prof.delay_ms + 3
  const latTone = lat == null ? 'bad' : lat > base + 120 ? 'bad' : lat > base + 40 ? 'warn' : 'good'
  const lossTone = loss > 10 ? 'bad' : loss > 3 ? 'warn' : 'good'
  const pulse = clamp(0.35 + (lat ?? 300) / 110, 0.35, 3.2)
  const chips = []
  if (away) chips.push(['mute', 'Not reachable from this location'])
  else {
    if (inj?.down) chips.push(['bad', 'Link down'])
    if (inj?.delay_ms > 0) chips.push(['bad', `+${inj.delay_ms} ms delay`])
    if (inj?.loss_pct > 0) chips.push(['bad', `${inj.loss_pct}% loss`])
    if (inj && inj.bw_mbps < prof.bw_mbps) chips.push(['bad', `${inj.bw_mbps} Mbps cap`])
  }

  return (
    <div className={`card h-${h}${active ? ' active' : ''}${flash ? ' flash' : ''}`}>
      <div className="card-head">
        <span className={`beat b-${h}`} style={{ animationDuration: `${pulse}s` }} />
        <h2>{prof.name}</h2>
        {active && <span className="badge">Active path</span>}
        <span className={`state s-${h}`}>{HLABEL[h]}</span>
      </div>
      <div className="kind">
        Network {p} · {prof.kind} · {prof.delay_ms} ms base · up to {prof.bw_mbps} Mbps
        {prof.penalty > 0 ? ` · cost +${prof.penalty}` : ''}
      </div>

      {away ? (
        <p className="away-note">
          This network cannot be reached from the current location, so the controller ignores it.
          Change the location, or press Make reachable to simulate arriving in range.
        </p>
      ) : (
        <>
          <Meter label="Latency" value={lat == null ? '--' : lat.toFixed(1)} unit="ms"
            pct={((lat ?? 300) / 250) * 100} tone={latTone} />
          <Meter label="Packet loss" value={loss} unit="%" pct={loss} tone={lossTone} />
          <Meter label="Bandwidth in use" value={tx.toFixed(2)} unit="Mbps" pct={(tx / prof.bw_mbps) * 100}
            tone={m && m.up ? 'good' : 'bad'} flow={m && m.up && tx > 0.05 ? clamp(2.6 - tx * 0.3, 0.45, 2.6) : null} />
        </>
      )}

      <div className="chips">
        {chips.length === 0
          ? <span className="chip ok">No problem injected</span>
          : chips.map(([t, txt]) => <span key={txt} className={`chip ${t}`}>{txt}</span>)}
      </div>

      <div className="ctl">
        {away ? (
          <div className="btn-row">
            <button className="btn go" onClick={() => onLink(p, true)}>Make reachable</button>
          </div>
        ) : (
          <>
            <Slider label="Extra delay" min={0} max={500} step={10} unit="ms"
              value={draft.delay} onChange={(v) => onEdit(p, 'delay', v)} />
            <Slider label="Packet loss" min={0} max={100} step={1} unit="%"
              value={draft.loss} onChange={(v) => onEdit(p, 'loss', v)} />
            <Slider label="Bandwidth cap" min={0.5} max={prof.bw_mbps} step={0.5} unit="Mbps"
              value={draft.bw} onChange={(v) => onEdit(p, 'bw', v)} />
            <div className="btn-row">
              <button className={inj?.down ? 'btn go' : 'btn stop'} onClick={() => onLink(p, !!inj?.down)}>
                {inj?.down ? 'Bring link up' : 'Take link down'}
              </button>
              <button className="btn" onClick={() => onPreset(p, 200, 20, prof.bw_mbps)}>Degrade</button>
              <button className="btn ghost" onClick={() => onReset(p)}>Reset</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------ adaptive decision panel */
const nameOf = (profiles, p) => profiles[p]?.name || `Network ${p}`

function explainSwitch(last, profiles) {
  const f = nameOf(profiles, last.from), t = nameOf(profiles, last.to)
  if (last.why === 'unavailable') return `Switched from ${f} to ${t} because ${f} became unavailable.`
  if (last.why === 'better') {
    return `Switched from ${f} to ${t}. ${t} scored ${last.new_score} against ${last.old_score} for ${f} (lower is better), on 3 checks in a row.`
  }
  return `Active network changed from ${f} to ${t} (set by hand).`
}

function narrate(d, profiles) {
  const n = (p) => nameOf(profiles, p)
  const sc = d.scores || {}
  const cur = sc[d.active]
  switch (d.state) {
    case 'static':
      return { tone: 'info', label: 'Static mode', head: 'Automatic switching is off',
        body: `Traffic stays on ${n(d.active)} however the networks behave.` }
    case 'warmup':
      return { tone: 'info', label: 'Measuring', head: 'Collecting measurements',
        body: 'The controller needs about 4 seconds of probe results from every network before it decides.' }
    case 'active_down':
      return { tone: 'bad', label: 'Failover', head: `${n(d.last?.from)} became unavailable`,
        body: `Switched to ${n(d.active)} immediately. Failures skip the 3-check rule and the cooldown.` }
    case 'switched':
      return { tone: 'good', label: 'Switched', head: `Moved to ${n(d.active)}`,
        body: explainSwitch(d.last, profiles) }
    case 'no_alternative':
      return { tone: 'bad', label: 'No network', head: `${n(d.active)} is unavailable and nothing else is reachable`,
        body: 'Traffic cannot be delivered until a network comes back.' }
    case 'challenger':
      return { tone: 'warn', label: 'Evaluating', head: `${n(d.challenger)} is beating ${n(d.active)}`,
        body: `Better for ${d.streak} of ${d.need} checks in a row. It must stay better so that a brief spike does not cause a switch.` }
    case 'cooldown':
      return { tone: 'warn', label: 'Waiting', head: `${n(d.challenger)} has earned the switch`,
        body: `The controller waits ${Math.ceil(d.cooldown_left)} more seconds so it does not flip back and forth.` }
    default: {
      if (d.best === d.active) {
        return { tone: 'good', label: 'Stable', head: `Staying on ${n(d.active)}`,
          body: `It has the lowest score (${cur}). Lower is better.` }
      }
      const need = Math.round(Math.min(d.ratio * cur, cur - d.min_gain))
      return { tone: 'good', label: 'Stable', head: `Staying on ${n(d.active)}`,
        body: `${n(d.best)} scores ${sc[d.best]}, but it would need to drop below ${need} (at least 20% and 20 points lower than ${cur}) to justify a switch.` }
    }
  }
}

function DecisionPanel({ d, profiles, inj }) {
  if (!d || !d.scores) {
    return (
      <section className="panel decide">
        <h3>Adaptive decision engine</h3>
        <p className="hint">Waiting for decision data from the controller. If this stays empty, restart
          the controller after installing the new controller.py.</p>
      </section>
    )
  }
  const n = narrate(d, profiles)
  const maxScore = 300
  return (
    <section className="panel decide">
      <div className="panel-head">
        <h3>Adaptive decision engine</h3>
        <span className={`dstate ds-${n.tone}`}>{n.label}</span>
      </div>
      <div className="decide-grid">
        <div>
          <div className={`headline tone-${n.tone}`}>
            <b>{n.head}</b>
            <p>{n.body}</p>
          </div>
          <div className="gauges">
            <div>
              <span>Challenger streak</span>
              <div className="dots">
                {Array.from({ length: d.need }).map((_, i) => (
                  <i key={i} className={i < d.streak ? 'on' : ''} />
                ))}
                <b>{d.streak} of {d.need}</b>
              </div>
            </div>
            <div>
              <span>Next switch allowed</span>
              <b>{d.cooldown_left > 0 ? `in ${Math.ceil(d.cooldown_left)} s` : 'now'}</b>
            </div>
          </div>
          {d.last && (
            <p className="lastsw">
              <b>Last switch,</b> {new Date(d.last.ts * 1000).toLocaleTimeString([], { hour12: false })}: {explainSwitch(d.last, profiles)}
            </p>
          )}
        </div>

        <div>
          <div className="formula">Score = latency (ms) + 10 × packet loss (%) + cost. The lowest score wins.</div>
          <table className="scoretable">
            <thead>
              <tr><th>Network</th><th>Latency</th><th>Loss ×10</th><th>Cost</th><th>Score</th><th></th></tr>
            </thead>
            <tbody>
              {PATHS.map((p) => {
                const part = d.parts?.[p] || {}
                const score = d.scores[p]
                const away = inj?.[p]?.away
                const tag = away ? ['mute', 'Out of range']
                  : score == null ? ['bad', 'Unavailable']
                  : p === d.active ? ['good', 'Active']
                  : p === d.challenger ? ['warn', 'Challenger']
                  : p === d.best ? ['info', 'Best'] : null
                return (
                  <tr key={p} className={p === d.active ? 'row-active' : ''}>
                    <td>
                      <span className="swatch" style={{ background: PCOLOR[p] }} />
                      {nameOf(profiles, p)}
                      <div className="sbar"><div style={{ width: `${score == null ? 0 : clamp((score / maxScore) * 100, 4, 100)}%`,
                        background: score == null ? 'transparent' : p === d.best ? '#22c55e' : score > 150 ? '#ef4444' : '#5b7bd6' }} /></div>
                    </td>
                    <td>{part.latency == null ? '--' : `${part.latency} ms`}</td>
                    <td>{part.loss_pts ?? '--'}</td>
                    <td>{part.penalty ? `+${part.penalty}` : '0'}</td>
                    <td><b>{score ?? '--'}</b></td>
                    <td>{tag && <span className={`tag t-${tag[0]}`}>{tag[1]}</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="how">
        <div><b>What it measures.</b> Latency and loss come from a probe sent over every network twice a second.
          Throughput comes from the switch port counters. Link state comes from OpenFlow port events.</div>
        <div><b>When it switches.</b> Another network must score at least 20% and 20 points lower, for 3 checks in a row,
          and 10 seconds after the last switch. If the active network is unavailable it switches at once.</div>
        <div><b>Why mobile data waits.</b> Metered data carries a cost of +15, so it only wins when the home Wi-Fi is clearly worse
          or gone. Bandwidth shows up in the score indirectly: a network that is squeezed below the traffic it carries
          builds queues, which raises its latency and loss.</div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------ alert message */
function alertMessage({ dec, profiles, active, activeH, activeM, holding, hold, mode }) {
  const n = (p) => nameOf(profiles, p)
  if (dec?.state === 'no_alternative') {
    return { title: 'No network available', sub: `${n(active)} is down and no other network can be reached.` }
  }
  if (holding) return { title: `${n(hold.from)} switching to ${n(hold.to)}`, sub: hold.text }
  if (dec && (dec.state === 'challenger' || dec.state === 'cooldown') && dec.challenger) {
    return {
      title: `${n(active)} switching to ${n(dec.challenger)}`,
      sub: `${n(active)} is having problems. ${n(dec.challenger)} has been better for ${dec.streak} of ${dec.need} checks.`,
    }
  }
  const why = activeH === 'down' ? 'The link is down.'
    : `Latency ${activeM?.latency_ms ?? '--'} ms, packet loss ${activeM?.loss_pct ?? '--'}%.`
  return {
    title: `${n(active)} has a problem`,
    sub: mode === 'static' ? `${why} Static mode: the controller is not switching.` : why,
  }
}

/* -------------------------------------------------------------------- app */
const WINDOWS = [
  ['10', 'Last 10 seconds'], ['30', 'Last 30 seconds'], ['60', 'Last 1 minute'],
  ['300', 'Last 5 minutes'], ['900', 'Last 15 minutes'], ['1800', 'Last 30 minutes'],
  ['all', 'Whole study'],
]
const defaultDraft = (profiles) => {
  const d = {}
  PATHS.forEach((p) => { d[p] = { delay: 0, loss: 0, bw: profiles[p].bw_mbps } })
  return d
}

export default function App() {
  const [status, setStatus] = useState(null)
  const [events, setEvents] = useState([])
  const [history, setHistory] = useState([])
  const [results, setResults] = useState([])
  const [offline, setOffline] = useState(false)
  const [draft, setDraft] = useState(() => defaultDraft(DEFAULT_PROFILES))
  const [win, setWin] = useState('60')
  const [fmt, setFmt] = useState('html')
  const [slow, setSlow] = useState(60)
  const [hold, setHold] = useState(null)
  const [okUntil, setOkUntil] = useState(0)
  const [toast, setToast] = useState(null)
  const draftRef = useRef(draft)
  const timers = useRef({})
  const draftInit = useRef(false)
  const autoSeen = useRef(null)
  const seenSwitch = useRef(null)
  const prevAlert = useRef(false)
  const [sound, setSound] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('sdn-sound'))
      if (saved) return { on: !!saved.on, level: clamp(Number(saved.level) || 70, 0, 100) }
    } catch { /* ignore */ }
    return { on: false, level: 70 }
  })
  const soundRef = useRef(sound)
  useEffect(() => {
    soundRef.current = sound
    try { localStorage.setItem('sdn-sound', JSON.stringify(sound)) } catch { /* ignore */ }
  }, [sound])
  const beep = useCallback((name) => {
    if (soundRef.current.on) playSound(name, soundRef.current.level)
  }, [])

  const profiles = status?.profiles ?? DEFAULT_PROFILES

  const notify = useCallback((msg, kind = 'ok') => {
    setToast({ msg, kind })
    setTimeout(() => setToast((t) => (t && t.msg === msg ? null : t)), 4500)
  }, [])

  const tick = useCallback(async () => {
    try {
      const [s, e, h] = await Promise.all([api('/api/status'), api('/api/events'), api('/api/history')])
      // remember the switch that was already there when the page opened, so only new ones get a banner
      if (seenSwitch.current === null) seenSwitch.current = s.decision?.last?.ts ?? 0
      setStatus(s); setEvents(e); setHistory(h); setOffline(false)
      if (!draftInit.current && s.impair) {
        draftInit.current = true
        const d = {}
        PATHS.forEach((p) => {
          const i = s.impair[p]
          d[p] = { delay: i.delay_ms, loss: i.loss_pct, bw: i.bw_mbps }
        })
        draftRef.current = d
        setDraft(d)
      }
      if (s.auto) {
        if (autoSeen.current === null) autoSeen.current = s.auto.count
        else if (s.auto.count > autoSeen.current) {
          autoSeen.current = s.auto.count
          download(`/api/report/file/${s.auto.latest}`)
          notify(`Automatic report downloaded: ${s.auto.latest}`, 'ok')
        }
      }
    } catch {
      setOffline(true)
    }
  }, [notify])

  useEffect(() => {
    api('/api/results').then(setResults).catch(() => {})
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [tick])

  // announce every switch the controller makes
  const lastTs = status?.decision?.last?.ts
  useEffect(() => {
    if (lastTs == null || lastTs === seenSwitch.current) return undefined
    seenSwitch.current = lastTs
    const last = status.decision.last
    setHold({
      from: last.from, to: last.to, why: last.why,
      text: explainSwitch(last, status.profiles ?? DEFAULT_PROFILES),
      until: Date.now() + 4000,
    })
    beep('switch')
    return undefined
  }, [lastTs])

  const doPost = async (path, body, okMsg) => {
    try {
      const r = await post(path, body)
      if (r.ok === false || r.error) notify(r.error || 'The action failed', 'bad')
      else if (okMsg) notify(okMsg, 'ok')
    } catch {
      notify('Cannot reach the Flask API on port 5000', 'bad')
    }
    tick()
  }

  const applyDraft = (p) => {
    const d = draftRef.current[p]
    return doPost(`/api/impair/${p}`, { delay_ms: d.delay, loss_pct: d.loss, bw_mbps: d.bw })
  }
  const setDraftFor = (p, vals) => {
    const next = { ...draftRef.current, [p]: vals }
    draftRef.current = next
    setDraft(next)
  }
  const edit = (p, key, val) => {
    setDraftFor(p, { ...draftRef.current[p], [key]: val })
    clearTimeout(timers.current[p])
    timers.current[p] = setTimeout(() => applyDraft(p), 300)
  }
  const preset = (p, delay, loss, bw) => {
    setDraftFor(p, { delay, loss, bw })
    applyDraft(p)
  }
  const linkToggle = (p, up) =>
    doPost(`/api/link/${p}`, { up }, `${nameOf(profiles, p)} link ${up ? 'brought up' : 'taken down'}`)
  const resetPath = (p) => {
    setDraftFor(p, { delay: 0, loss: 0, bw: profiles[p].bw_mbps })
    doPost(`/api/reset/${p}`, {}, `${nameOf(profiles, p)} reset to normal`)
  }
  const resetAll = () => {
    const d = defaultDraft(profiles)
    draftRef.current = d; setDraft(d)
    doPost('/api/reset-all', {}, 'All networks restored for this location')
  }
  const setLocation = (name) => {
    const d = defaultDraft(profiles)
    draftRef.current = d; setDraft(d)
    doPost('/api/scenario', { name }, `Location changed: ${status?.scenarios?.[name] ?? name}`)
  }
  const active = status?.active
  const newStudy = () => {
    if (window.confirm('Start a new study? The collected samples will be cleared.')) {
      doPost('/api/study/reset', {}, 'New study started')
    }
  }

  const rows = useMemo(() => history.map((h) => {
    const r = { time: new Date(h.t * 1000).toLocaleTimeString([], { hour12: false }) }
    PATHS.forEach((p) => {
      r[`${p}_lat`] = h.paths[p]?.lat ?? null
      r[`${p}_tx`] = h.paths[p]?.tx ?? 0
    })
    return r
  }), [history])

  const live = !offline && status && !status.stale
  const dec = status?.decision
  const activeM = active ? status?.paths?.[active] : null
  const activeH = active ? health(activeM, profiles[active], status?.impair?.[active]) : 'unknown'
  const holding = !!hold && Date.now() < hold.until
  const st = dec?.state
  // red while the active network is in trouble or the controller is switching
  const trouble = !!live && !!active && (
    st === 'active_down' || st === 'no_alternative' ||
    activeH === 'critical' || activeH === 'down' || activeH === 'away' ||
    ((st === 'challenger' || st === 'cooldown') && activeH !== 'good'))
  const alertOn = trouble || (!!live && holding)
  const alertMsg = alertOn
    ? alertMessage({ dec, profiles, active, activeH, activeM, holding, hold, mode: status?.mode })
    : null
  const connectedBar = !alertOn && !!active && Date.now() < okUntil

  useEffect(() => {
    document.body.classList.toggle('alert-mode', alertOn)
    if (prevAlert.current && !alertOn) {
      setOkUntil(Date.now() + 4500)
      beep('connected')
    }
    prevAlert.current = alertOn
  }, [alertOn, beep])

  // the alarm repeats once a second, in step with the blinking light
  const alarmName = st === 'no_alternative' ? 'nonet' : 'alarm'
  useEffect(() => {
    if (!alertOn || !sound.on) return undefined
    beep(alarmName)
    const id = setInterval(() => beep(alarmName), 1000)
    return () => clearInterval(id)
  }, [alertOn, sound.on, alarmName, beep])

  // browsers only allow audio after a click; if sound was left on, unlock it on the first click
  useEffect(() => {
    if (!sound.on) return undefined
    const unlock = () => audio()
    window.addEventListener('pointerdown', unlock, { once: true })
    return () => window.removeEventListener('pointerdown', unlock)
  }, [sound.on])

  const toggleSound = () => {
    const next = { ...sound, on: !sound.on }
    setSound(next)
    if (next.on) playSound('connected', next.level) // this click also unlocks the browser's audio
  }
  const tipStyle = { background: '#0b1330', border: '1px solid #1f3266', borderRadius: 8, color: '#e8eefc' }

  return (
    <>
    <div className={`alert-bg${alertOn ? ' on' : ''}`} aria-hidden="true" />
    <div className="page">
      <header>
        <div>
          <h1>Adaptive traffic switching</h1>
          <p className="sub">Live view of three networks between h1 and h2, controlled by OS-Ken over OpenFlow</p>
        </div>
        <div className="head-right">
          <div className="sound" title="Alarm while a network has trouble, a sweep when the controller switches, a chime when connected">
            <button className={`btn${sound.on ? ' on' : ''}`} onClick={toggleSound} aria-pressed={sound.on}>
              {sound.on ? 'Sound on' : 'Sound off'}
            </button>
            {sound.on && (
              <input type="range" min={0} max={100} step={5} value={sound.level} aria-label="Volume"
                onChange={(e) => setSound({ ...sound, level: Number(e.target.value) })}
                onPointerUp={() => playSound('switch', sound.level)} />
            )}
          </div>
          {status?.scenarios && <span className="mode-tag">Location: {status.scenarios[status.scenario]}</span>}
          {status && <span className="mode-tag">Mode: {status.mode}</span>}
          <span className={`pill ${live ? 'ok' : 'bad'}`}>
            <i />{live ? 'Live' : offline ? 'API offline' : 'Controller offline'}
          </span>
        </div>
      </header>

      {status && status.root === false && (
        <div className="banner bad">
          The controls are disabled because Flask is not running as root. Stop it and start it again with
          <code>sudo venv/bin/python app.py</code>
        </div>
      )}

      {alertOn && alertMsg && (
        <div className="alertbar" role="alert">
          <span className="light" />
          <div>
            <h2>{alertMsg.title}</h2>
            <p>{alertMsg.sub}</p>
          </div>
        </div>
      )}
      {connectedBar && (
        <div className="alertbar ok" role="status">
          <span className="light steady" />
          <div>
            <h2>Connected: {nameOf(profiles, active)}</h2>
            <p>{hold && Date.now() < hold.until + 12000 ? hold.text : 'The network is healthy again.'}</p>
          </div>
        </div>
      )}

      <section className="panel map">
        <div className="panel-head">
          <h3>Packet flow</h3>
          <div className="legend">
            <span><i className="dot g" />Data packet</span>
            <span><i className="dot w" />Monitoring probe</span>
            <span><i className="dot r" />Dropped packet</span>
          </div>
        </div>
        <PacketFlow status={status} slow={slow} profiles={profiles} />
        <label className="speed">
          <span>Slow motion: {slow}× slower than real time</span>
          <input type="range" min={10} max={200} step={10} value={slow} onChange={(e) => setSlow(Number(e.target.value))} />
          <span className="speed-note">A packet takes as long on screen as the measured latency times {slow}.
            Slower networks look slower, and the rate of packets follows the throughput.</span>
        </label>
      </section>

      <DecisionPanel d={status?.decision} profiles={profiles} inj={status?.impair} />

      <section className="grid3">
        {PATHS.map((p) => (
          <PathCard key={p} p={p} prof={profiles[p]} m={status?.paths?.[p]} inj={status?.impair?.[p]}
            active={active === p} flash={holding && hold.to === p && active === p}
            draft={draft[p]} onEdit={edit} onPreset={preset} onLink={linkToggle} onReset={resetPath} />
        ))}
      </section>

      <section className="grid2">
        <div className="panel">
          <h3>Location, controller and scenarios</h3>
          <div className="row">
            <span className="lbl">Location</span>
            {Object.entries(status?.scenarios ?? {}).map(([k, t]) => (
              <button key={k} className={`btn${status?.scenario === k ? ' on' : ''}`} onClick={() => setLocation(k)}>{t}</button>
            ))}
          </div>
          <div className="row">
            <span className="lbl">Mode</span>
            {['adaptive', 'static'].map((m) => (
              <button key={m} className={`btn${status?.mode === m ? ' on' : ''}`}
                onClick={() => doPost('/api/mode', { mode: m })}>{m}</button>
            ))}
          </div>
          <div className="row">
            <span className="lbl">Force network</span>
            {PATHS.map((p) => (
              <button key={p} className={`btn${active === p ? ' on' : ''}`}
                onClick={() => doPost('/api/path', { path: p })}>{nameOf(profiles, p)}</button>
            ))}
          </div>
          <div className="row">
            <span className="lbl">Scenarios</span>
            <button className="btn" disabled={!active} onClick={() => preset(active, 200, 20, profiles[active].bw_mbps)}>Degrade active network</button>
            <button className="btn stop" disabled={!active} onClick={() => linkToggle(active, false)}>Fail active network</button>
            <button className="btn go" onClick={resetAll}>Restore all</button>
          </div>
          <p className="hint">Location decides which networks can be reached. At home the college network is out of range,
            so only Home Wi-Fi and Mobile data compete. Try failing Home Wi-Fi and watch the controller move to Mobile data.
            After restarting the Mininet topology, press Restore all.</p>
        </div>

        <div className="panel">
          <h3>Reports</h3>
          <div className="row">
            <span className="lbl">Download</span>
            <select value={win} onChange={(e) => setWin(e.target.value)}>
              {WINDOWS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
            </select>
            <select value={fmt} onChange={(e) => setFmt(e.target.value)}>
              <option value="html">Report (.html)</option>
              <option value="csv">Raw data (.csv)</option>
            </select>
            <button className="btn go" onClick={() => download(`/api/report?window=${win}&fmt=${fmt}`)}>Download report</button>
          </div>
          <div className="stats">
            <div><span>Study running</span><b>{status ? fmtDur(Date.now() / 1000 - status.study_started) : '--'}</b></div>
            <div><span>Next automatic report</span><b>{status ? fmtDur(status.next_report_in) : '--'}</b></div>
            <div><span>Samples collected</span><b>{status?.samples ?? '--'}</b></div>
          </div>
          <div className="row">
            <button className="btn ghost" onClick={newStudy}>Start a new study</button>
          </div>
          <p className="hint">A report is created automatically every {status ? Math.round(status.report_every / 60) : 30} minutes
            and saved in the reports folder. This page also downloads it while it is open (the browser may ask once to allow
            automatic downloads).</p>
        </div>
      </section>

      <section className="grid2">
        <div className="panel">
          <h3>Latency per network</h3>
          <div className="chart">
            <ResponsiveContainer>
              <LineChart data={rows}>
                <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
                <XAxis dataKey="time" stroke="#8fa3cf" minTickGap={50} tick={{ fontSize: 11 }} />
                <YAxis stroke="#8fa3cf" unit=" ms" width={62} tick={{ fontSize: 11 }} />
                <Tooltip contentStyle={tipStyle} />
                <Legend />
                <ReferenceLine y={150} stroke="#ef4444" strokeDasharray="5 4"
                  label={{ value: 'critical', fill: '#ef4444', fontSize: 11, position: 'insideTopRight' }} />
                {PATHS.map((p) => (
                  <Line key={p} type="monotone" dataKey={`${p}_lat`} name={nameOf(profiles, p)} stroke={PCOLOR[p]}
                    strokeWidth={p === active ? 3 : 1.6} dot={false} connectNulls isAnimationActive={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="panel">
          <h3>Bandwidth in use</h3>
          <div className="chart">
            <ResponsiveContainer>
              <AreaChart data={rows}>
                <defs>
                  {PATHS.map((p) => (
                    <linearGradient key={p} id={`g${p}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={PCOLOR[p]} stopOpacity={0.55} />
                      <stop offset="100%" stopColor={PCOLOR[p]} stopOpacity={0.02} />
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
                <XAxis dataKey="time" stroke="#8fa3cf" minTickGap={50} tick={{ fontSize: 11 }} />
                <YAxis stroke="#8fa3cf" unit=" Mbps" width={74} tick={{ fontSize: 11 }} />
                <Tooltip contentStyle={tipStyle} />
                <Legend />
                {PATHS.map((p) => (
                  <Area key={p} type="monotone" dataKey={`${p}_tx`} name={nameOf(profiles, p)} stroke={PCOLOR[p]}
                    fill={`url(#g${p})`} strokeWidth={2} isAnimationActive={false} />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      <section className="panel">
        <h3>Events and operator actions</h3>
        <div className="events">
          {events.length === 0 && <div className="empty">Nothing has happened yet.</div>}
          {[...events].reverse().map((e, i) => {
            const bad = e.kind === 'link' && e.detail === 'DOWN'
            const good = (e.kind === 'link' && e.detail === 'UP') || e.kind === 'switch'
            const who = e.path === 'all' ? 'All networks' : nameOf(profiles, e.path)
            return (
              <div className="ev" key={i}>
                <span className="t">{new Date(e.ts * 1000).toLocaleTimeString([], { hour12: false })}</span>
                <span className={`k ${bad ? 'k-bad' : good ? 'k-good' : e.kind === 'operator' ? 'k-op' : 'k-plain'}`}>
                  {e.kind === 'operator' ? 'You' : e.kind}
                </span>
                <span>{e.kind === 'operator' ? e.detail : `${who} (${e.detail})`}</span>
              </div>
            )
          })}
        </div>
      </section>

      <section className="panel">
        <h3>Experiment results: static vs adaptive (average of 3 runs)</h3>
        {results.length === 0 ? (
          <div className="empty">No results yet. Run run_experiment.py, then average.py.</div>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Mode</th><th>Ping loss</th><th>UDP loss</th><th>Avg RTT</th><th>p95 RTT</th>
                  <th>Goodput</th><th>Switches</th><th>First switch</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.mode} className={r.mode === 'adaptive' ? 'win' : ''}>
                    <td>{r.mode}</td>
                    <td>{r.ping_loss_pct}%</td>
                    <td>{r.udp_loss_pct ?? '-'}%</td>
                    <td>{r.avg_rtt_ms} ms</td>
                    <td>{r.p95_rtt_ms} ms</td>
                    <td>{r.goodput_mbps} Mbps</td>
                    <td>{Math.round(r.switches)}</td>
                    <td>{r.first_switch_after_degrade_s == null || r.first_switch_after_degrade_s === '' ? '-' : `${r.first_switch_after_degrade_s} s`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {toast && <div className={`toast ${toast.kind}`}>{toast.msg}</div>}
    </div>
    </>
  )
}
