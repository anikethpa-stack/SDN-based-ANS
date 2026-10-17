import json, glob
rows = {}
for f in sorted(glob.glob('results_run*/summary.json')):
    for r in json.load(open(f)):
        rows.setdefault(r['mode'], []).append(r)
keys = ['ping_loss_pct', 'udp_loss_pct', 'avg_rtt_ms', 'p95_rtt_ms',
        'goodput_mbps', 'switches', 'first_switch_after_degrade_s']
out = {}
for mode, rs in rows.items():
    out[mode] = {}
    for k in keys:
        vals = [float(r[k]) for r in rs if r[k] != '']
        out[mode][k] = round(sum(vals) / len(vals), 2) if vals else None
    print(mode, 'runs=%d' % len(rs), out[mode])
json.dump(out, open('results_average.json', 'w'), indent=2)
