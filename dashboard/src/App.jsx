import { useEffect, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid, ResponsiveContainer } from 'recharts'

const API = `http://${window.location.hostname}:5000`
const PATHS = ['A', 'B', 'C']
const COLORS = { A: '#2563eb', B: '#16a34a', C: '#d97706' }

async function get(p) {
  const r = await fetch(API + p)
  return r.json()
}
async function post(p, body) {
  await fetch(API + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export default function App() {
  const [status, setStatus] = useState(null)
  const [events, setEvents] = useState([])
  const [history, setHistory] = useState([])
  const [results, setResults] = useState([])
  const [mode, setMode] = useState('adaptive')
  const [err, setErr] = useState(false)

  useEffect(() => {
    get('/api/results').then(setResults).catch(() => {})
    const tick = async () => {
      try {
        const [s, e, h] = await Promise.all([
          get('/api/status'), get('/api/events'), get('/api/history'),
        ])
        setStatus(s); setEvents(e); setHistory(h); setErr(false)
      } catch {
        setErr(true)
      }
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  const offline = err || !status || status.stale
  const chartData = history.map((h) => ({
    time: new Date(h.t * 1000).toLocaleTimeString(),
    A: h.latency.A, B: h.latency.B, C: h.latency.C,
  }))

  const changeMode = async (m) => { await post('/api/mode', { mode: m }); setMode(m) }
  const pickPath = (p) => post('/api/path', { path: p })

  return (
    <div className="page">
      <header>
        <h1>Adaptive Traffic Switching with SDN</h1>
        <span className={'pill ' + (offline ? 'bad' : 'ok')}>
          {offline ? 'Controller offline' : 'Live'}
        </span>
      </header>

      <div className="grid">
        {PATHS.map((p) => {
          const m = status?.paths?.[p]
          const isActive = status?.active === p
          const isDown = m && !m.up
          return (
            <div key={p} className={'card' + (isActive ? ' active' : '') + (isDown ? ' down' : '')}>
              <div className="card-head">
                <h2>Network {p}</h2>
                {isActive && <span className="badge">ACTIVE</span>}
              </div>
              <div className={'status ' + (m ? (m.up ? 'up' : 'down') : '')}>
                {m ? (m.up ? 'UP' : 'DOWN') : '--'}
              </div>
              <dl>
                <dt>Latency</dt><dd>{m?.latency_ms ?? '--'} ms</dd>
                <dt>Packet loss</dt><dd>{m?.loss_pct ?? '--'} %</dd>
                <dt>Throughput</dt><dd>{m?.tx_mbps ?? '--'} Mbps</dd>
              </dl>
            </div>
          )
        })}
      </div>

      <div className="panel">
        <h3>Controls</h3>
        <div className="row">
          <span className="label">Mode</span>
          {['adaptive', 'static'].map((m) => (
            <button key={m} className={mode === m ? 'on' : ''} onClick={() => changeMode(m)}>{m}</button>
          ))}
        </div>
        <div className="row">
          <span className="label">Force path</span>
          {PATHS.map((p) => (
            <button key={p} className={status?.active === p ? 'on' : ''} onClick={() => pickPath(p)}>{p}</button>
          ))}
        </div>
        <div className="hint">In adaptive mode the controller may switch the path again on its own. Use static mode to hold a forced path.</div>
      </div>

      <div className="panel">
        <h3>Latency per network (ms)</h3>
        <div style={{ width: '100%', height: 260 }}>
          <ResponsiveContainer>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="time" minTickGap={40} />
              <YAxis />
              <Tooltip />
              <Legend />
              {PATHS.map((p) => (
                <Line key={p} type="monotone" dataKey={p} stroke={COLORS[p]} dot={false} isAnimationActive={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="panel">
        <h3>Switching events</h3>
        <div className="events">
          {events.length === 0 && <div className="empty">No events yet.</div>}
          {[...events].reverse().map((e, i) => (
            <div className="ev" key={i}>
              <span className="t">{new Date(e.ts * 1000).toLocaleTimeString()}</span>
              <span className={'k-' + e.kind}>{e.kind}</span> to path {e.path} ({e.detail})
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <h3>Experiment results: static vs adaptive</h3>
        {results.length === 0 ? (
          <div className="empty">No results yet. Run run_experiment.py.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Mode</th><th>Loss %</th><th>Avg RTT</th><th>p95 RTT</th>
                <th>Goodput</th><th>Switches</th><th>First switch</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.mode}>
                  <td>{r.mode}</td>
                  <td>{r.ping_loss_pct}</td>
                  <td>{r.avg_rtt_ms} ms</td>
                  <td>{r.p95_rtt_ms} ms</td>
                  <td>{r.goodput_mbps} Mbps</td>
                  <td>{r.switches}</td>
                  <td>{r.first_switch_after_degrade_s === '' ? '-' : r.first_switch_after_degrade_s + ' s'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
