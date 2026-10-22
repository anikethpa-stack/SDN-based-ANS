import json, os, time, threading
from collections import deque
from flask import Flask, jsonify, request
from flask_cors import CORS

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = '/tmp/sdn_state.json'
RESULTS = os.path.join(HERE, 'results', 'summary.json')

app = Flask(__name__)
CORS(app)
history = deque(maxlen=120)


def read_state():
    try:
        with open(STATE) as f:
            s = json.load(f)
        s['stale'] = (time.time() - s['ts']) > 5
        return s
    except Exception:
        return {'stale': True, 'active': None, 'paths': {}, 'events': []}


def sampler():
    while True:
        s = read_state()
        if not s['stale']:
            history.append({
                't': s['ts'],
                'active': s['active'],
                'latency': {p: m['latency_ms'] for p, m in s['paths'].items()},
                'loss': {p: m['loss_pct'] for p, m in s['paths'].items()},
            })
        time.sleep(1)


@app.get('/api/status')
def status():
    s = read_state()
    s.pop('events', None)
    return jsonify(s)


@app.get('/api/events')
def events():
    return jsonify(read_state().get('events', []))


@app.get('/api/history')
def get_history():
    return jsonify(list(history))


@app.get('/api/results')
def results():
    try:
        with open(RESULTS) as f:
            return jsonify(json.load(f))
    except Exception:
        return jsonify([])


@app.post('/api/mode')
def set_mode():
    mode = (request.get_json(silent=True) or {}).get('mode', '')
    if mode not in ('adaptive', 'static'):
        return jsonify({'error': 'mode must be adaptive or static'}), 400
    with open('/tmp/mode.txt', 'w') as f:
        f.write(mode)
    return jsonify({'mode': mode})


@app.post('/api/path')
def set_path():
    path = (request.get_json(silent=True) or {}).get('path', '').upper()
    if path not in ('A', 'B', 'C'):
        return jsonify({'error': 'path must be A, B or C'}), 400
    with open('/tmp/active_path.txt', 'w') as f:
        f.write(path)
    return jsonify({'path': path})


if __name__ == '__main__':
    threading.Thread(target=sampler, daemon=True).start()
    app.run(host='0.0.0.0', port=5000)
