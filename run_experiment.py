#!/usr/bin/env python3
import csv, json, os, re, subprocess, time
from mininet.net import Mininet
from mininet.node import RemoteController, OVSSwitch
from mininet.link import TCLink
from mininet.log import setLogLevel

DURATION = 60
T_DEGRADE = 10
T_FAIL = 30
T_RESTORE = 50
UDP_MBPS = 4.0
RESULTS = 'results'
os.makedirs(RESULTS, exist_ok=True)


def sh(cmd):
    subprocess.run(cmd, shell=True, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL)


def put(path, text):
    # open without O_CREAT so root can write files owned by your user in /tmp
    fd = os.open(path, os.O_WRONLY | os.O_TRUNC)
    os.write(fd, text.encode())
    os.close(fd)


def tc_a(args):
    sh('tc qdisc replace dev s1-eth2 parent 5:1 handle 10: netem ' + args)


def build():
    net = Mininet(controller=None, switch=OVSSwitch, link=TCLink,
                  autoSetMacs=False)
    net.addController('c0', controller=RemoteController,
                      ip='127.0.0.1', port=6653)
    h1 = net.addHost('h1', ip='10.0.0.1/24', mac='00:00:00:00:00:01')
    h2 = net.addHost('h2', ip='10.0.0.2/24', mac='00:00:00:00:00:02')
    sw = {}
    for name, dpid in [('s1', '1'), ('s2', '2'), ('s3', '3'),
                       ('s4', '4'), ('s5', '5')]:
        sw[name] = net.addSwitch(name, dpid=dpid, protocols='OpenFlow13')
    net.addLink(h1, sw['s1'], port2=1)
    net.addLink(h2, sw['s2'], port2=1)
    for i, p in enumerate(['s3', 's4', 's5']):
        port = i + 2
        net.addLink(sw['s1'], sw[p], port1=port, port2=1,
                    bw=10, delay='5ms', loss=0)
        net.addLink(sw[p], sw['s2'], port1=2, port2=port)
    net.start()
    h1.setARP('10.0.0.2', '00:00:00:00:00:02')
    h2.setARP('10.0.0.1', '00:00:00:00:00:01')
    return net


def run(net, mode):
    h1 = net.get('h1')
    print('--- run: %s (about %d s) ---' % (mode, DURATION + 15))
    put('/tmp/mode.txt', mode)
    put('/tmp/active_path.txt', 'A')
    time.sleep(15)

    n_ping = DURATION * 5
    t0 = time.time()
    ping = h1.popen('ping -i 0.2 -c %d 10.0.0.2' % n_ping,
                    stdout=subprocess.PIPE, universal_newlines=True)
    iperf = h1.popen('iperf3 -c 10.0.0.2 -u -b %dM -t %d -J'
                     % (int(UDP_MBPS), DURATION),
                     stdout=subprocess.PIPE, universal_newlines=True)

    def at(t):
        d = t0 + t - time.time()
        if d > 0:
            time.sleep(d)

    at(T_DEGRADE)
    tc_a('delay 150ms loss 30%')
    at(T_FAIL)
    sh('ip link set s1-eth3 down')
    at(T_RESTORE)
    tc_a('delay 5ms loss 0%')
    sh('ip link set s1-eth3 up')

    ping_out = ping.communicate()[0]
    iperf_out = iperf.communicate()[0]

    try:
        events = json.load(open('/tmp/sdn_state.json'))['events']
    except Exception:
        events = []
    sw = [e for e in events if e['kind'] == 'switch' and e['ts'] >= t0]

    rtt = {}
    for line in ping_out.splitlines():
        m = re.search(r'icmp_seq=(\d+).*time=([\d.]+)', line)
        if m:
            rtt[int(m.group(1))] = float(m.group(2))
    vals = sorted(rtt.values())
    ping_loss = 100.0 * (n_ping - len(rtt)) / n_ping
    avg_rtt = sum(vals) / len(vals) if vals else 0.0
    p95 = vals[int(0.95 * (len(vals) - 1))] if vals else 0.0
    mx = vals[-1] if vals else 0.0

    udp_loss = ping_loss
    try:
        j = json.loads(iperf_out[iperf_out.index('{'):])
        udp_loss = float(j['end']['sum'].get('lost_percent', ping_loss))
    except Exception as e:
        print('iperf parse problem (using ping loss instead):', e)
    goodput = UDP_MBPS * (1 - udp_loss / 100.0)

    with open('%s/timeline_%s.csv' % (RESULTS, mode), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['second', 'ping_loss_pct', 'avg_rtt_ms'])
        for s in range(DURATION):
            seqs = range(s * 5 + 1, s * 5 + 6)
            got = [rtt[q] for q in seqs if q in rtt]
            w.writerow([s, round(100.0 * (5 - len(got)) / 5, 1),
                        round(sum(got) / len(got), 1) if got else ''])

    return {
        'mode': mode,
        'ping_loss_pct': round(ping_loss, 1),
        'avg_rtt_ms': round(avg_rtt, 1),
        'p95_rtt_ms': round(p95, 1),
        'max_rtt_ms': round(mx, 1),
        'udp_loss_pct': round(udp_loss, 1),
        'goodput_mbps': round(goodput, 2),
        'switches': len(sw),
        'first_switch_after_degrade_s':
            round(sw[0]['ts'] - (t0 + T_DEGRADE), 1) if sw else '',
    }


if __name__ == '__main__':
    setLogLevel('warning')
    net = build()
    time.sleep(5)
    h2 = net.get('h2')
    h2.cmd('iperf3 -s -D')
    time.sleep(1)
    rows = []
    try:
        for mode in ('static', 'adaptive'):
            rows.append(run(net, mode))
    finally:
        tc_a('delay 5ms loss 0%')
        sh('ip link set s1-eth3 up')
        try:
            put('/tmp/mode.txt', 'adaptive')
        except OSError:
            pass
        h2.cmd('pkill iperf3')
        net.stop()

    if rows:
        with open(RESULTS + '/summary.csv', 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        with open(RESULTS + '/summary.json', 'w') as f:
            json.dump(rows, f, indent=2)
        print()
        for r in rows:
            print(r)
    user = os.environ.get('SUDO_USER', 'root')
    sh('chown -R %s:%s %s' % (user, user, RESULTS))
