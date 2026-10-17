import json, os, struct, time
from collections import deque

from os_ken.base import app_manager
from os_ken.controller import ofp_event
from os_ken.controller.handler import (CONFIG_DISPATCHER, MAIN_DISPATCHER,
                                       set_ev_cls)
from os_ken.ofproto import ofproto_v1_3
from os_ken.lib import hub
from os_ken.lib.packet import packet, ethernet

CMD_FILE = '/tmp/active_path.txt'
STATE_FILE = '/tmp/sdn_state.json'
PATH_PORT = {'A': 2, 'B': 3, 'C': 4}
PORT_PATH = {v: k for k, v in PATH_PORT.items()}
PATH_IDX = {'A': 0, 'B': 1, 'C': 2}
IDX_PATH = {v: k for k, v in PATH_IDX.items()}
PROBE_ETH = 0x88B5
PROBE_FMT = '!BId'
PROBE_SIZE = struct.calcsize(PROBE_FMT)
PROBE_INTERVAL = 0.5
PROBE_TIMEOUT = 1.5
HIST = 20


class AdaptiveSwitch(app_manager.OSKenApp):
    OFP_VERSIONS = [ofproto_v1_3.OFP_VERSION]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.dps = {}
        self.active = 'A'
        self.pending = {p: {} for p in PATH_PORT}
        self.hist = {p: deque(maxlen=HIST) for p in PATH_PORT}
        self.link_up = {p: True for p in PATH_PORT}
        self.tx_mbps = {p: 0.0 for p in PATH_PORT}
        self.last_tx = {}
        self.event_log = []
        with open(CMD_FILE, 'w') as f:
            f.write('A')
        hub.spawn(self._watch_file)
        hub.spawn(self._probe_loop)
        hub.spawn(self._stats_loop)
        hub.spawn(self._decision_loop)

    # ---------- flows ----------
    def add_flow(self, dp, priority, match, out_port):
        parser = dp.ofproto_parser
        ofp = dp.ofproto
        actions = [parser.OFPActionOutput(out_port)]
        inst = [parser.OFPInstructionActions(ofp.OFPIT_APPLY_ACTIONS, actions)]
        dp.send_msg(parser.OFPFlowMod(datapath=dp, priority=priority,
                                      match=match, instructions=inst))

    @set_ev_cls(ofp_event.EventOFPSwitchFeatures, CONFIG_DISPATCHER)
    def on_switch_connect(self, ev):
        dp = ev.msg.datapath
        parser = dp.ofproto_parser
        self.dps[dp.id] = dp

        if dp.id in (3, 4, 5):
            self.add_flow(dp, 10, parser.OFPMatch(in_port=1), 2)
            self.add_flow(dp, 10, parser.OFPMatch(in_port=2), 1)
        elif dp.id in (1, 2):
            for port in (2, 3, 4):
                self.add_flow(dp, 10, parser.OFPMatch(in_port=port), 1)
            self.add_flow(dp, 10, parser.OFPMatch(in_port=1),
                          PATH_PORT[self.active])
            if dp.id == 2:   # probes arriving at s2 go to the controller
                self.add_flow(dp, 100, parser.OFPMatch(eth_type=PROBE_ETH),
                              dp.ofproto.OFPP_CONTROLLER)
        self.logger.info('Switch s%s connected', dp.id)

    def switch_to(self, path):
        for dpid in (1, 2):
            dp = self.dps.get(dpid)
            if dp:
                self.add_flow(dp, 10, dp.ofproto_parser.OFPMatch(in_port=1),
                              PATH_PORT[path])
        self.log_event('switch', path, 'from %s' % self.active)
        self.active = path

    def log_event(self, kind, path, detail):
        ev = {'ts': time.time(), 'kind': kind, 'path': path, 'detail': detail}
        self.event_log.append(ev)
        self.event_log = self.event_log[-50:]
        self.logger.info('EVENT %s %s %s', kind, path, detail)

    # ---------- manual switch via file ----------
    def _watch_file(self):
        while True:
            hub.sleep(1)
            try:
                with open(CMD_FILE) as f:
                    want = f.read().strip().upper()
            except OSError:
                continue
            if want in PATH_PORT and want != self.active:
                self.switch_to(want)

    # ---------- probes: latency + loss ----------
    def send_probe(self, dp, path, seq, ts):
        parser = dp.ofproto_parser
        ofp = dp.ofproto
        pkt = packet.Packet()
        pkt.add_protocol(ethernet.ethernet(ethertype=PROBE_ETH,
                                           dst='ff:ff:ff:ff:ff:ff',
                                           src='00:00:00:00:00:fe'))
        payload = struct.pack(PROBE_FMT, PATH_IDX[path], seq, ts)
        pkt.add_protocol(payload.ljust(46, b'\x00'))
        pkt.serialize()
        actions = [parser.OFPActionOutput(PATH_PORT[path])]
        out = parser.OFPPacketOut(datapath=dp, buffer_id=ofp.OFP_NO_BUFFER,
                                  in_port=ofp.OFPP_CONTROLLER,
                                  actions=actions, data=pkt.data)
        dp.send_msg(out)

    def _probe_loop(self):
        seq = 0
        tick = 0
        while True:
            hub.sleep(PROBE_INTERVAL)
            dp = self.dps.get(1)
            if dp is None:
                continue
            seq += 1
            tick += 1
            now = time.time()
            for path in PATH_PORT:
                for s, t in list(self.pending[path].items()):
                    if now - t > PROBE_TIMEOUT:
                        del self.pending[path][s]
                        self.hist[path].append(None)
                self.pending[path][seq] = now
                self.send_probe(dp, path, seq, now)
            self.write_state()
            if tick % 4 == 0:
                self.logger.info(self.summary())

    @set_ev_cls(ofp_event.EventOFPPacketIn, MAIN_DISPATCHER)
    def on_packet_in(self, ev):
        data = ev.msg.data
        eth = packet.Packet(data).get_protocol(ethernet.ethernet)
        if eth is None or eth.ethertype != PROBE_ETH:
            return
        idx, seq, ts = struct.unpack(PROBE_FMT, data[14:14 + PROBE_SIZE])
        path = IDX_PATH.get(idx)
        if path and seq in self.pending[path]:
            del self.pending[path][seq]
            self.hist[path].append((time.time() - ts) * 1000.0)

    # ---------- port status + stats ----------
    @set_ev_cls(ofp_event.EventOFPPortStatus, MAIN_DISPATCHER)
    def on_port_status(self, ev):
        msg = ev.msg
        dp = msg.datapath
        if dp.id != 1:
            return
        path = PORT_PATH.get(msg.desc.port_no)
        if not path:
            return
        ofp = dp.ofproto
        up = (not (msg.desc.state & ofp.OFPPS_LINK_DOWN)
              and not (msg.desc.config & ofp.OFPPC_PORT_DOWN))
        if up != self.link_up[path]:
            self.link_up[path] = up
            self.log_event('link', path, 'UP' if up else 'DOWN')

    def _stats_loop(self):
        while True:
            hub.sleep(1)
            dp = self.dps.get(1)
            if dp is None:
                continue
            dp.send_msg(dp.ofproto_parser.OFPPortStatsRequest(
                dp, 0, dp.ofproto.OFPP_ANY))

    @set_ev_cls(ofp_event.EventOFPPortStatsReply, MAIN_DISPATCHER)
    def on_port_stats(self, ev):
        if ev.msg.datapath.id != 1:
            return
        now = time.time()
        for st in ev.msg.body:
            path = PORT_PATH.get(st.port_no)
            if not path:
                continue
            prev = self.last_tx.get(path)
            if prev and now > prev[0]:
                self.tx_mbps[path] = ((st.tx_bytes - prev[1]) * 8
                                      / (now - prev[0]) / 1e6)
            self.last_tx[path] = (now, st.tx_bytes)

    # ---------- metrics + output ----------
    def metrics(self, path):
        h = list(self.hist[path])
        loss = 100.0 * sum(1 for x in h if x is None) / len(h) if h else 0.0
        recent = [x for x in h[-6:] if x is not None]
        lat = sum(recent) / len(recent) if recent else None
        return {'latency_ms': round(lat, 1) if lat is not None else None,
                'loss_pct': round(loss, 1),
                'tx_mbps': round(self.tx_mbps[path], 2),
                'up': self.link_up[path]}

    def summary(self):
        parts = []
        for p in PATH_PORT:
            m = self.metrics(p)
            parts.append('%s: lat=%sms loss=%s%% tx=%sMbps %s' % (
                p, m['latency_ms'], m['loss_pct'], m['tx_mbps'],
                'UP' if m['up'] else 'DOWN'))
        return ' | '.join(parts) + ' || active=' + self.active

    def write_state(self):
        state = {'ts': time.time(), 'active': self.active,
                 'paths': {p: self.metrics(p) for p in PATH_PORT},
                 'events': self.event_log[-30:]}
        tmp = STATE_FILE + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(state, f)
        os.replace(tmp, STATE_FILE)

    # ---------- decision engine ----------
    MODE_FILE = '/tmp/mode.txt'
    _better_count = 0
    _last_switch = 0.0

    def score(self, path):
        m = self.metrics(path)
        if not m['up'] or m['latency_ms'] is None:
            return float('inf')
        return m['latency_ms'] + 10.0 * m['loss_pct']

    def mode(self):
        try:
            with open(self.MODE_FILE) as f:
                return f.read().strip().lower()
        except OSError:
            return 'adaptive'

    def do_switch(self, path, reason):
        self.log_event('decision', path, reason)
        self.switch_to(path)
        with open(CMD_FILE, 'w') as f:
            f.write(path)
        self._last_switch = time.time()
        self._better_count = 0

    def _decision_loop(self):
        while True:
            hub.sleep(1)
            if self.mode() != 'adaptive':
                self._better_count = 0
                continue
            if any(len(self.hist[p]) < 8 for p in PATH_PORT):
                continue
            scores = {p: self.score(p) for p in PATH_PORT}
            best = min(scores, key=scores.get)
            cur = scores[self.active]
            now = time.time()
            if cur == float('inf'):
                if best != self.active and scores[best] != float('inf'):
                    self.do_switch(best, 'active path unavailable')
                continue
            better = (best != self.active
                      and scores[best] < 0.8 * cur
                      and cur - scores[best] > 20)
            self._better_count = self._better_count + 1 if better else 0
            if self._better_count >= 3 and now - self._last_switch >= 10:
                self.do_switch(best, 'score %.0f -> %.0f' % (cur, scores[best]))
