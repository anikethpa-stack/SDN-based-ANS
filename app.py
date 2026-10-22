#!/usr/bin/env python3
"""Flask API for the SDN adaptive switching project (v2).

Run it with sudo (through the venv python) so the dashboard can change the
network with tc / ip:

    sudo venv/bin/python app.py          # automatic report every 30 minutes
    sudo venv/bin/python app.py 60       # automatic report every 60 s (testing)

It listens on 127.0.0.1 only, because it can change network settings as root.
"""
import csv
import html
import io
import json
import os
import re
import subprocess
import sys
import threading
import time
from collections import deque
from datetime import datetime

from flask import Flask, Response, abort, jsonify, request, send_from_directory
from flask_cors import CORS

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = '/tmp/sdn_state.json'
MODE_FILE = '/tmp/mode.txt'
PATH_FILE = '/tmp/active_path.txt'
REPORT_DIR = os.path.join(HERE, 'reports')

PATHS = ['A', 'B', 'C']
IFACE = {'A': 's1-eth2', 'B': 's1-eth3', 'C': 's1-eth4'}
POLICY_FILE = '/tmp/net_policy.json'

# What each virtual network pretends to be. delay_ms and bw_mbps are applied
# with tc as the healthy baseline. penalty is a cost the controller adds to the
# score (metered mobile data is only used when Wi-Fi is clearly worse).
NETWORKS = {
    'A': {'name': 'Home Wi-Fi', 'kind': 'Wi-Fi', 'delay_ms': 15, 'bw_mbps': 10.0, 'penalty': 0},
    'B': {'name': 'Mobile data', 'kind': 'Cellular, metered', 'delay_ms': 45, 'bw_mbps': 6.0, 'penalty': 15},
    'C': {'name': 'College network', 'kind': 'Campus LAN', 'delay_ms': 5, 'bw_mbps': 10.0, 'penalty': 0},
}
# Which networks can be reached from each location.
SCENARIOS = {
    'home': {'label': 'At home', 'reach': {'A': True, 'B': True, 'C': False}},
    'college': {'label': 'At college', 'reach': {'A': False, 'B': True, 'C': True}},
    'travelling': {'label': 'Travelling', 'reach': {'A': False, 'B': True, 'C': False}},
    'all': {'label': 'All online', 'reach': {'A': True, 'B': True, 'C': True}},
}
scenario = {'name': 'home'}
REPORT_EVERY = int(sys.argv[1]) if len(sys.argv) > 1 else 30 * 60

app = Flask(__name__)
CORS(app)
lock = threading.Lock()

# ---------------------------------------------------------------- study data
samples = deque(maxlen=43200)       # one sample per second, about 12 hours
ctrl_events = []                    # events reported by the controller
actions = []                        # changes made from the dashboard
seen_events = set()
now0 = time.time()
study = {'start': now0, 'next_auto': now0 + REPORT_EVERY}
auto = {'count': 0, 'latest': None}


def new_state(p):
    return {'delay_ms': 0, 'loss_pct': 0.0, 'bw_mbps': NETWORKS[p]['bw_mbps'],
            'down': False, 'away': False}


impair = {p: new_state(p) for p in PATHS}


def nm(p):
    return NETWORKS[p]['name'] if p in NETWORKS else 'all networks'


# ------------------------------------------------------------------- helpers
def read_state():
    try:
        with open(STATE) as f:
            s = json.load(f)
        s['stale'] = (time.time() - s['ts']) > 5
        return s
    except Exception:
        return {'stale': True, 'active': None, 'paths': {}, 'events': [], 'ts': 0}


def read_mode():
    try:
        with open(MODE_FILE) as f:
            m = f.read().strip().lower()
        return m if m in ('adaptive', 'static') else 'adaptive'
    except OSError:
        return 'adaptive'


def put(path, text):
    """Write a small /tmp file. /tmp is sticky and root may not re-create a
    file owned by another user (protected_regular), so open without O_CREAT
    first and only create the file if it does not exist."""
    try:
        fd = os.open(path, os.O_WRONLY | os.O_TRUNC)
        os.write(fd, text.encode())
        os.close(fd)
    except FileNotFoundError:
        with open(path, 'w') as f:
            f.write(text)
        os.chmod(path, 0o666)


def own(path):
    """Give files created under sudo back to the normal user."""
    user = os.environ.get('SUDO_USER')
    if not user:
        return
    try:
        import pwd
        pw = pwd.getpwnam(user)
        os.chown(path, pw.pw_uid, pw.pw_gid)
    except Exception:
        pass


def run(cmd):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
    except FileNotFoundError:
        return False, cmd[0] + ' is not installed'
    except subprocess.TimeoutExpired:
        return False, 'the command timed out'
    if r.returncode != 0:
        msg = (r.stderr or r.stdout).strip() or 'the command failed'
        if 'Cannot find device' in msg or 'No such device' in msg:
            msg = 'interface not found: is the Mininet topology running?'
        return False, msg
    return True, ''


def need_root():
    if os.geteuid() != 0:
        return 'Controls need root. Restart Flask with: sudo venv/bin/python app.py'
    return None


def log_action(path, detail):
    with lock:
        actions.append({'ts': time.time(), 'kind': 'operator', 'path': path,
                        'detail': detail})
        del actions[:-500]


def apply_shaping(p):
    s = impair[p]
    dev = IFACE[p]
    ok, err = run(['tc', 'qdisc', 'replace', 'dev', dev, 'parent', '5:1',
                   'handle', '10:', 'netem',
                   'delay', '%dms' % (NETWORKS[p]['delay_ms'] + s['delay_ms']),
                   'loss', '%s%%' % s['loss_pct']])
    if not ok:
        return ok, err
    return run(['tc', 'class', 'change', 'dev', dev, 'parent', '5:0',
                'classid', '5:1', 'htb', 'rate', '%sMbit' % s['bw_mbps'],
                'burst', '15k'])


def set_link(p, up):
    return run(['ip', 'link', 'set', 'dev', IFACE[p], 'up' if up else 'down'])


def num(body, key, lo, hi, default):
    try:
        v = float(body.get(key, default))
    except (TypeError, ValueError):
        v = default
    return max(lo, min(hi, v))


def check_path(p):
    p = p.upper()
    if p not in IFACE:
        abort(404)
    return p


def fail(msg, code=400):
    return jsonify({'ok': False, 'error': msg}), code


# ------------------------------------------------------------------ sampling
def sampler():
    while True:
        s = read_state()
        if not s['stale']:
            with lock:
                samples.append({
                    't': s['ts'], 'active': s['active'],
                    'paths': {p: {'lat': m['latency_ms'], 'loss': m['loss_pct'],
                                  'tx': m['tx_mbps'], 'up': m['up']}
                              for p, m in s['paths'].items()}})
                for e in s['events']:
                    key = (round(e['ts'], 3), e['kind'], e['path'], e['detail'])
                    if key not in seen_events and e['ts'] >= study['start']:
                        seen_events.add(key)
                        ctrl_events.append(e)
        time.sleep(1)


def auto_reporter():
    while True:
        time.sleep(1)
        if time.time() < study['next_auto']:
            continue
        study['next_auto'] += REPORT_EVERY
        try:
            data, _, _ = build_report(REPORT_EVERY, 'html')
            os.makedirs(REPORT_DIR, exist_ok=True)
            own(REPORT_DIR)
            name = 'auto_report_%03d_%s.html' % (
                auto['count'] + 1, datetime.now().strftime('%Y%m%d_%H%M%S'))
            path = os.path.join(REPORT_DIR, name)
            with open(path, 'wb') as f:
                f.write(data)
            own(path)
            auto['count'] += 1
            auto['latest'] = name
            print('Automatic report saved:', path)
        except Exception as exc:
            print('Automatic report failed:', exc)


# ------------------------------------------------------------------- reports
def fmt_ts(t):
    return datetime.fromtimestamp(t).strftime('%Y-%m-%d %H:%M:%S')


def avg(v):
    return sum(v) / len(v) if v else None


def pctl(v, q):
    if not v:
        return None
    v = sorted(v)
    return v[int(q * (len(v) - 1))]


def f1(x, unit=''):
    return '-' if x is None else '%.1f%s' % (x, unit)


def window_data(window):
    now = time.time()
    with lock:
        smp = list(samples)
        ev = list(ctrl_events)
        act = list(actions)
    lo = study['start'] if window is None else max(study['start'], now - window)
    smp = [x for x in smp if x['t'] >= lo]
    ev = [e for e in ev if e['ts'] >= lo]
    act = [a for a in act if a['ts'] >= lo]
    return lo, now, smp, ev, act


def path_stats(smp, p):
    rows = [x['paths'][p] for x in smp if p in x['paths']]
    lat = [r['lat'] for r in rows if r['lat'] is not None]
    loss = [r['loss'] for r in rows]
    tx = [r['tx'] for r in rows]
    down = sum(1 for r in rows if not r['up'])
    n = len(rows)
    on = sum(1 for x in smp if x['active'] == p)
    return {
        'n': n,
        'lat_avg': avg(lat), 'lat_min': min(lat) if lat else None,
        'lat_max': max(lat) if lat else None, 'lat_p95': pctl(lat, 0.95),
        'loss_avg': avg(loss), 'loss_max': max(loss) if loss else None,
        'tx_avg': avg(tx), 'tx_max': max(tx) if tx else None,
        'down_s': down,
        'uptime': 100.0 * (n - down) / n if n else None,
        'active_pct': 100.0 * on / len(smp) if smp else None,
    }


REPORT_CSS = """
body{font-family:Arial,Helvetica,sans-serif;color:#0f172a;margin:0;background:#f1f5f9}
.wrap{max-width:980px;margin:0 auto;padding:28px}
.head{background:#0a1128;color:#fff;padding:22px 28px;border-radius:10px}
.head h1{margin:0 0 6px;font-size:24px}
.head p{margin:0;color:#9fb3e0;font-size:14px}
h2{font-size:17px;margin:26px 0 10px;color:#0a1128}
table{width:100%;border-collapse:collapse;background:#fff;font-size:13px}
th,td{padding:7px 9px;border-bottom:1px solid #e2e8f0;text-align:left}
th{background:#0f1b3d;color:#fff;font-weight:600}
.good{color:#15803d;font-weight:700}
.bad{color:#b91c1c;font-weight:700}
.box{background:#fff;border-radius:8px;padding:12px 16px;border-left:5px solid #16a34a}
.box.bad{border-left-color:#dc2626}
.box li{margin:5px 0;font-size:14px}
.small{font-size:12px;color:#64748b;margin-top:22px}
"""

COL = {'A': '#0891b2', 'B': '#0f172a', 'C': '#7c3aed'}


def svg_chart(smp):
    if len(smp) < 2:
        return ''
    step = max(1, len(smp) // 240)
    pts = smp[::step]
    vals = [x['paths'][p]['lat'] for x in pts for p in PATHS
            if p in x['paths'] and x['paths'][p]['lat'] is not None]
    if not vals:
        return ''
    ymax = max(60.0, max(vals) * 1.1)
    w, h, pad = 800, 180, 34
    t0, t1 = pts[0]['t'], pts[-1]['t']
    span = max(1e-6, t1 - t0)
    out = ['<svg viewBox="0 0 %d %d" width="100%%" style="background:#fff">'
           % (w + pad + 10, h + 40)]
    out.append('<line x1="%d" y1="10" x2="%d" y2="10" stroke="#fca5a5" stroke-dasharray="4"/>'
               % (pad, w + pad)) if ymax > 150 else None
    out.append('<text x="2" y="14" font-size="10" fill="#64748b">%d ms</text>' % ymax)
    out.append('<text x="2" y="%d" font-size="10" fill="#64748b">0</text>' % (h + 10))
    for p in PATHS:
        coords = ['%.1f,%.1f' % (pad + (x['t'] - t0) / span * w,
                                 10 + h - x['paths'][p]['lat'] / ymax * h)
                  for x in pts if p in x['paths'] and x['paths'][p]['lat'] is not None]
        if coords:
            out.append('<polyline fill="none" stroke="%s" stroke-width="1.6" points="%s"/>'
                       % (COL[p], ' '.join(coords)))
    for i, p in enumerate(PATHS):
        out.append('<text x="%d" y="%d" font-size="12" fill="%s">%s</text>'
                   % (pad + i * 150, h + 32, COL[p], nm(p)))
    out.append('</svg>')
    return ''.join(x for x in out if x)


def describe(e):
    k, p, d = e['kind'], e['path'], e['detail']
    if k == 'switch':
        return 'Path switch', 'Traffic moved to %s (%s)' % (nm(p), d.replace('from ', 'from network '))
    if k == 'decision':
        return 'Controller decision', 'Use %s (%s)' % (nm(p), d)
    if k == 'link':
        return 'Link event', '%s link %s' % (nm(p), d)
    return 'Operator action', d


def build_report(window, fmt):
    lo, now, smp, ev, act = window_data(window)
    stamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    label = 'whole-study' if window is None else 'last-%ds' % window
    if fmt == 'csv':
        buf = io.StringIO()
        w = csv.writer(buf)
        head = ['time', 'active_path']
        for p in PATHS:
            head += ['%s_latency_ms' % p, '%s_loss_pct' % p,
                     '%s_tx_mbps' % p, '%s_up' % p]
        w.writerow(head)
        for x in smp:
            row = [fmt_ts(x['t']), x['active']]
            for p in PATHS:
                m = x['paths'].get(p)
                row += ([m['lat'], m['loss'], m['tx'], int(m['up'])]
                        if m else ['', '', '', ''])
            w.writerow(row)
        name = 'network_data_%s_%s.csv' % (label, stamp)
        return buf.getvalue().encode(), 'text/csv', name

    st = {p: path_stats(smp, p) for p in PATHS}
    obs = []
    for p in PATHS:
        s = st[p]
        if not s['n']:
            continue
        if s['down_s']:
            obs.append('%s was unavailable for about %d s (%.1f%% of the window).'
                       % (nm(p), s['down_s'], 100 - s['uptime']))
        if s['lat_max'] is not None and s['lat_max'] > 100:
            obs.append('%s latency peaked at %.0f ms (average %.1f ms).'
                       % (nm(p), s['lat_max'], s['lat_avg']))
        if s['loss_max'] is not None and s['loss_max'] > 5:
            obs.append('%s packet loss peaked at %.0f%%.' % (nm(p), s['loss_max']))
    sw = [e for e in ev if e['kind'] == 'switch']
    if sw:
        obs.append('The controller switched the active path %d time(s).' % len(sw))
    if act:
        obs.append('%d change(s) were made from the dashboard.' % len(act))
    healthy = not obs
    if healthy:
        obs.append('No degradation, failure or switching was observed in this window.')

    rows = ''
    for p in PATHS:
        s = st[p]
        bad_up = s['uptime'] is not None and s['uptime'] < 100
        bad_loss = s['loss_avg'] is not None and s['loss_avg'] > 1
        rows += (
            '<tr><td><b>%s</b></td><td>%s</td><td>%s</td><td>%s</td>'
            '<td class="%s">%s</td><td>%s</td><td>%s</td><td class="%s">%s</td><td>%s</td></tr>'
            % (nm(p), f1(s['lat_avg'], ' ms'), f1(s['lat_p95'], ' ms'), f1(s['lat_max'], ' ms'),
               'bad' if bad_loss else 'good', f1(s['loss_avg'], '%'),
               f1(s['tx_avg'], ' Mbps'), f1(s['tx_max'], ' Mbps'),
               'bad' if bad_up else 'good', f1(s['uptime'], '%'),
               f1(s['active_pct'], '%')))

    items = [(e['ts'],) + describe(e) for e in ev] + [(a['ts'],) + describe(a) for a in act]
    items.sort()
    tl = ''.join('<tr><td>%s</td><td>%s</td><td>%s</td></tr>'
                 % (fmt_ts(t), html.escape(k), html.escape(d)) for t, k, d in items[-300:])
    if not tl:
        tl = '<tr><td colspan="3">No events in this window.</td></tr>'

    covered = (smp[-1]['t'] - smp[0]['t']) if len(smp) > 1 else 0
    body = (
        '<div class="wrap"><div class="head"><h1>Network study report</h1>'
        '<p>Adaptive traffic switching with SDN | generated %s</p></div>'
        '<h2>Study window</h2><table><tr><th>Window requested</th><th>Data covered</th>'
        '<th>Samples</th><th>Mode</th><th>Active path now</th></tr>'
        '<tr><td>%s to %s</td><td>%d s</td><td>%d</td><td>%s</td><td>%s</td></tr></table>'
        '<h2>What happened</h2><div class="box%s"><ul>%s</ul></div>'
        '<h2>Per-network summary</h2><table><tr><th>Network</th><th>Avg latency</th>'
        '<th>p95 latency</th><th>Max latency</th><th>Avg loss</th><th>Avg throughput</th>'
        '<th>Peak throughput</th><th>Uptime</th><th>Time as active</th></tr>%s</table>'
        '<h2>Latency over time</h2>%s'
        '<h2>Timeline of events and operator actions</h2><table><tr><th>Time</th>'
        '<th>Type</th><th>Detail</th></tr>%s</table>'
        '<p class="small">Samples are taken once per second while the controller is running. '
        'Download the CSV version from the dashboard for the raw per-second data.</p></div>'
        % (fmt_ts(now), fmt_ts(lo), fmt_ts(now), covered, len(smp), read_mode(),
           read_state().get('active') or '-', '' if healthy else ' bad',
           ''.join('<li>%s</li>' % html.escape(o) for o in obs), rows, svg_chart(smp), tl))
    page = ('<!doctype html><html><head><meta charset="utf-8"><title>Network study report'
            '</title><style>%s</style></head><body>%s</body></html>' % (REPORT_CSS, body))
    name = 'network_report_%s_%s.html' % (label, stamp)
    return page.encode(), 'text/html', name


# ----------------------------------------------------------------- endpoints
@app.get('/api/status')
def status():
    s = read_state()
    s.pop('events', None)
    s['impair'] = impair
    s['profiles'] = NETWORKS
    s['scenario'] = scenario['name']
    s['scenarios'] = {k: v['label'] for k, v in SCENARIOS.items()}
    s['mode'] = read_mode()
    s['root'] = os.geteuid() == 0
    s['study_started'] = study['start']
    s['report_every'] = REPORT_EVERY
    s['next_report_in'] = max(0.0, study['next_auto'] - time.time())
    s['auto'] = auto
    s['samples'] = len(samples)
    return jsonify(s)


@app.get('/api/events')
def events():
    with lock:
        merged = list(ctrl_events) + list(actions)
    merged.sort(key=lambda e: e['ts'])
    return jsonify(merged[-40:])


@app.get('/api/history')
def history():
    with lock:
        tail = list(samples)[-150:]
    return jsonify(tail)


@app.get('/api/results')
def results():
    try:
        with open(os.path.join(HERE, 'results_average.json')) as f:
            return jsonify([dict(v, mode=m) for m, v in json.load(f).items()])
    except Exception:
        pass
    try:
        with open(os.path.join(HERE, 'results', 'summary.json')) as f:
            return jsonify(json.load(f))
    except Exception:
        return jsonify([])


@app.post('/api/mode')
def set_mode():
    mode = (request.get_json(silent=True) or {}).get('mode', '')
    if mode not in ('adaptive', 'static'):
        return fail('mode must be adaptive or static')
    put(MODE_FILE, mode)
    return jsonify({'ok': True, 'mode': mode})


@app.post('/api/path')
def set_path():
    path = (request.get_json(silent=True) or {}).get('path', '').upper()
    if path not in PATHS:
        return fail('path must be A, B or C')
    put(PATH_FILE, path)
    log_action(path, 'active path forced to %s' % path)
    return jsonify({'ok': True, 'path': path})


@app.post('/api/impair/<p>')
def api_impair(p):
    p = check_path(p)
    err = need_root()
    if err:
        return fail(err, 403)
    body = request.get_json(silent=True) or {}
    cur = impair[p]
    old = dict(cur)
    cur['delay_ms'] = int(num(body, 'delay_ms', 0, 1000, cur['delay_ms']))
    cur['loss_pct'] = round(num(body, 'loss_pct', 0, 100, cur['loss_pct']), 1)
    cur['bw_mbps'] = round(num(body, 'bw_mbps', 0.1, NETWORKS[p]['bw_mbps'], cur['bw_mbps']), 1)
    ok, msg = apply_shaping(p)
    if not ok:
        impair[p] = old
        return fail('%s: %s' % (nm(p), msg), 500)
    log_action(p, '%s: +%d ms delay, %s%% loss, %s Mbps cap'
               % (nm(p), cur['delay_ms'], cur['loss_pct'], cur['bw_mbps']))
    return jsonify({'ok': True, 'impair': impair[p]})


@app.post('/api/link/<p>')
def api_link(p):
    p = check_path(p)
    err = need_root()
    if err:
        return fail(err, 403)
    up = bool((request.get_json(silent=True) or {}).get('up', True))
    ok, msg = set_link(p, up)
    if not ok:
        return fail('%s: %s' % (nm(p), msg), 500)
    impair[p]['down'] = not up
    if up:
        impair[p]['away'] = False
    log_action(p, '%s link brought UP' % nm(p) if up else '%s link taken DOWN' % nm(p))
    return jsonify({'ok': True, 'impair': impair[p]})


def reset_path(p):
    """Back to the healthy baseline for the current location."""
    reachable = SCENARIOS[scenario['name']]['reach'][p]
    impair[p] = new_state(p)
    impair[p]['down'] = not reachable
    impair[p]['away'] = not reachable
    ok, msg = apply_shaping(p)
    ok2, msg2 = set_link(p, reachable)
    return (ok and ok2), (msg or msg2)


@app.post('/api/reset/<p>')
def api_reset(p):
    p = check_path(p)
    err = need_root()
    if err:
        return fail(err, 403)
    ok, msg = reset_path(p)
    if not ok:
        return fail('%s: %s' % (nm(p), msg), 500)
    log_action(p, '%s reset to normal' % nm(p))
    return jsonify({'ok': True, 'impair': impair[p]})


@app.post('/api/reset-all')
def api_reset_all():
    err = need_root()
    if err:
        return fail(err, 403)
    problems = []
    for p in PATHS:
        ok, msg = reset_path(p)
        if not ok:
            problems.append('%s: %s' % (nm(p), msg))
    log_action('all', 'all networks reset to normal')
    if problems:
        return fail('; '.join(problems), 500)
    return jsonify({'ok': True})


@app.post('/api/scenario')
def api_scenario():
    err = need_root()
    if err:
        return fail(err, 403)
    name = (request.get_json(silent=True) or {}).get('name', '')
    if name not in SCENARIOS:
        return fail('unknown location')
    scenario['name'] = name
    problems = []
    for p in PATHS:
        ok, msg = reset_path(p)
        if not ok:
            problems.append('%s: %s' % (nm(p), msg))
    reach = SCENARIOS[name]['reach']
    log_action('all', 'location: %s (reachable: %s)' % (
        SCENARIOS[name]['label'],
        ', '.join(nm(p) for p in PATHS if reach[p]) or 'none'))
    if problems:
        return fail('; '.join(problems), 500)
    return jsonify({'ok': True, 'scenario': name})


@app.post('/api/study/reset')
def api_study_reset():
    now = time.time()
    with lock:
        samples.clear()
        ctrl_events.clear()
        actions.clear()
    study['start'] = now
    study['next_auto'] = now + REPORT_EVERY
    return jsonify({'ok': True})


@app.get('/api/report')
def api_report():
    w = request.args.get('window', 'all')
    fmt = 'csv' if request.args.get('fmt') == 'csv' else 'html'
    try:
        window = None if w == 'all' else max(1, min(int(float(w)), 7 * 86400))
    except ValueError:
        return fail('window must be a number of seconds or all')
    data, mime, name = build_report(window, fmt)
    return Response(data, mimetype=mime,
                    headers={'Content-Disposition': 'attachment; filename="%s"' % name})


@app.get('/api/report/file/<name>')
def api_report_file(name):
    if not re.fullmatch(r'[\w.\-]+\.html', name):
        abort(404)
    return send_from_directory(REPORT_DIR, name, as_attachment=True)


def policy_heartbeat():
    """Tell the controller each network's cost penalty. The file is refreshed
    every 2 s; the controller ignores it when it is older than 8 s."""
    while True:
        try:
            put(POLICY_FILE, json.dumps({p: {'name': NETWORKS[p]['name'],
                                             'penalty': NETWORKS[p]['penalty']}
                                         for p in PATHS}))
        except Exception:
            pass
        time.sleep(2)


def startup_reset():
    """Apply the healthy baseline for the starting location (At home)."""
    if os.geteuid() != 0:
        return
    for p in PATHS:
        reset_path(p)


if __name__ == '__main__':
    if os.geteuid() != 0:
        print('WARNING: not running as root, dashboard controls are disabled.')
        print('         Start with: sudo venv/bin/python app.py')
    startup_reset()
    threading.Thread(target=sampler, daemon=True).start()
    threading.Thread(target=auto_reporter, daemon=True).start()
    threading.Thread(target=policy_heartbeat, daemon=True).start()
    print('Automatic report every %d s. Reports are saved in %s' % (REPORT_EVERY, REPORT_DIR))
    app.run(host='127.0.0.1', port=5000, threaded=True)
