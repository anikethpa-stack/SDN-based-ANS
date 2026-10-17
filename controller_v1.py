from os_ken.base import app_manager
from os_ken.controller import ofp_event
from os_ken.controller.handler import CONFIG_DISPATCHER, set_ev_cls
from os_ken.ofproto import ofproto_v1_3
from os_ken.lib import hub

CMD_FILE = '/tmp/active_path.txt'
PATH_PORT = {'A': 2, 'B': 3, 'C': 4}   # port on s1/s2 for each path


class AdaptiveSwitch(app_manager.OSKenApp):
    OFP_VERSIONS = [ofproto_v1_3.OFP_VERSION]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.dps = {}
        self.active = 'A'
        with open(CMD_FILE, 'w') as f:
            f.write('A')
        hub.spawn(self._watch_file)

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

        if dp.id in (3, 4, 5):            # path switches: pass-through
            self.add_flow(dp, 10, parser.OFPMatch(in_port=1), 2)
            self.add_flow(dp, 10, parser.OFPMatch(in_port=2), 1)
        elif dp.id in (1, 2):             # edge switches
            for port in (2, 3, 4):        # anything from a path -> host
                self.add_flow(dp, 10, parser.OFPMatch(in_port=port), 1)
            self.add_flow(dp, 10, parser.OFPMatch(in_port=1),
                          PATH_PORT[self.active])   # host -> active path
        self.logger.info('Switch s%s connected', dp.id)

    def switch_to(self, path):
        for dpid in (1, 2):
            dp = self.dps.get(dpid)
            if dp:
                self.add_flow(dp, 10, dp.ofproto_parser.OFPMatch(in_port=1),
                              PATH_PORT[path])
        self.logger.info('SWITCHED %s -> %s', self.active, path)
        self.active = path

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
