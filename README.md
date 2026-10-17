# Adaptive Traffic Switching Across Multiple Networks using SDN

An SDN simulation where an OS-Ken controller monitors three virtual
networks (A, B, C) and moves traffic to a better one when the active
network degrades or fails.

## Architecture

    React dashboard (port 5173)
            |  HTTP polling
    Flask API (port 5000)
            |  reads /tmp/sdn_state.json
    OS-Ken controller app (monitoring + decision logic inside)
            |  OpenFlow 1.3
    Open vSwitch switches (Mininet)
            |
    Path A / Path B / Path C  ->  h1 <-> h2 traffic

Topology: h1 - s1 =(s3 | s4 | s5)= s2 - h2. Each path switch is one network.
Link impairments (delay, loss, link down) are applied with tc on the
s1-side links.

## How it works

- Latency and loss: the controller sends probe packets over each path and
  measures the round trip and missing replies.
- Bandwidth: OpenFlow port statistics polled every second.
- Availability: OpenFlow port-status events.
- Decision: score = latency + 10 x loss%. Switch if another path scores at
  least 20% and 20 points better for 3 consecutive checks, with a 10 s
  cooldown. If the active path is down, switch immediately.

## Run

Use four terminals. Only the Flask terminal uses the venv.

1. Controller:  osken-manager controller.py
2. Topology:    sudo python3 topo.py
3. Flask:       source venv/bin/activate && python app.py
4. Dashboard:   cd dashboard && npm install && npm run dev

Open http://localhost:5173

Manual path change: echo B > /tmp/active_path.txt
Static mode:        echo static > /tmp/mode.txt

## Experiment

    sudo python3 run_experiment.py

Runs the same 60 s scenario in static and adaptive mode with a 4 Mbps UDP
iperf3 stream and a ping every 0.2 s:
t=10 s Path A gets 150 ms delay and 30% loss, t=30 s Path B goes down,
t=50 s everything is restored. Per-run output goes to results/ and the
three runs are in results_run1..3. Averages: python3 average.py

## Results (average of 3 runs)

| Metric                | Static    | Adaptive  |
|-----------------------|-----------|-----------|
| Ping loss             | 20.3 %    | 1.9 %     |
| UDP loss (iperf3)     | 20.0 %    | 1.8 %     |
| Average RTT           | 93.1 ms   | 14.8 ms   |
| p95 RTT               | 155.0 ms  | 10.2 ms   |
| Goodput (of 4 Mbps)   | 3.20 Mbps | 3.93 Mbps |
| Path switches         | 0         | 2         |
| First switch delay    | n/a       | 2.8 s     |

Limitation: the maximum RTT is about 155 ms in both modes because the
adaptive controller needs about 2-3 s to detect degradation before it
switches.

## Tools

Mininet, Open vSwitch, OS-Ken, OpenFlow 1.3, Python, iPerf3, Linux tc,
Flask, React (Vite, Recharts).
