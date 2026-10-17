#!/usr/bin/env python3
from mininet.net import Mininet
from mininet.node import RemoteController, OVSSwitch
from mininet.link import TCLink
from mininet.cli import CLI
from mininet.log import setLogLevel

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

    CLI(net)
    net.stop()

if __name__ == '__main__':
    setLogLevel('info')
    build()
