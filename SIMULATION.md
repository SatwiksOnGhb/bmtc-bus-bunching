# Part 2 · Simulation and dashboard (Satwik Ray)

This part is a SUMO digital twin of BMTC routes **375-D**, **378** and **401-M** (held out), built from Varun's GTFS, his OpenStreetMap corridor map and his 2019 BMTC GPS speeds. It has mixed traffic, Poisson passengers, dwell time, rain and breakdown scenarios, and holding control at stops. On top of the twin sit a PettingZoo environment for Part 3, a live runner, a labelled dataset and a Streamlit dashboard.

## Quick start (Windows, from the `bmtc` folder)

```powershell
py -3.14 -m pip install -r requirements-part1.txt -r requirements-part2.txt
py -3.14 -m pytest -q tests                    # Varun's tests + Part 2 contract tests
py -3.14 -m streamlit run dashboard/app.py     # live dashboard in the browser
py -3.14 -m sim.dataset                        # regenerate the dataset and baseline tables (~30 min)
py -3.14 -m sim.figures                        # report figures in runs/figures/
```

SUMO 1.28 must be installed with `SUMO_HOME` set. The built scenarios are already in `runs/sumo/`, so `sim.scenario` only needs rerunning if the map or the routes change.

## Hand-offs (as in the work-split plan)

| Plan item | Where | Status |
| --- | --- | --- |
| Road network: OSM → SUMO, bus lines and stops, junction fixes | `sim/scenario.py` → `runs/sumo/<route>/` | ✅ 3 routes, 0 U-turns, 0 bus teleports |
| Mixed traffic with GPS-calibrated link speeds | `sim/bus_sim.py` | ✅ cars, two-wheelers, autos; speeds by OSM way and hour |
| Passengers and dwell via TraCI, bunching confirmed | `sim/bus_sim.py`, `runs/holding/time_space.png` | ✅ |
| Scenarios: rain and breakdown, seeded | `sim/scenarios.py` `make_scenario(name, seed)` | ✅ `<route>_{base,rain,breakdown}` |
| RL environment | `sim/env.py` `BMTCHoldingEnv` | ✅ PettingZoo Parallel, Part 1 schemas |
| Live runner, swappable policy and predictor, two side-by-side sims | `sim/runner.py` `Runner.stream()`, `side_by_side()` | ✅ |
| Labelled dataset and baseline results | `sim/dataset.py` → `runs/dataset/` | ✅ Parquet + KPI tables |
| Streamlit dashboard | `dashboard/app.py` | ✅ map, time-space, KPIs, selectors, what-if, side-by-side |
| Settings in `common/config.yaml` | `sim:` section | ✅ |

## How the twin works

- **Network.** `data/raw/corridors.osm` (Varun's corridor map) is converted with `netconvert --output.original-names --junctions.join --tls.join`. Merging junctions matters: OSM draws many Bengaluru junctions as several nodes a few metres apart, and the zero-length links and double signals between them gridlocked traffic on 401-M. For each route and direction, every GTFS stop is snapped to a nearby bus road, choosing the road and side of the road that give the shortest route through all stops in order. The network is then cut to that route's roads (`runs/sumo/<route>/net.xml`). SUMO's `gtfs2pt.py` was tried first but put stops on the wrong side of the road (U-turn detours and gridlock), and its shape matching takes hours on this map.
- **Schedule.** Trips departing 07:00–11:00 on 16 Nov 2026 from Varun's `scheduled_arrivals.csv`, for each route's main pattern in each direction. Bus IDs are GTFS `trip_id`s; stop indices match `pattern_stops.csv`. Trips departing under 2 minutes after the previous one are dropped (see Limitations).
- **Road speeds.** Every hour, each road segment's speed is set to Varun's median BMTC bus speed for that OSM way and hour (`runs/sumo/full/edge_hour_speeds.csv`). Where there's no measurement, the route's corridor median is used. All speeds are then multiplied by `speed_calibration` (see Calibration).
- **Mixed traffic.** 200 vehicles per hour per direction (50% two-wheelers, 30% cars, 20% autos) drive loop-free stretches of each route. Buses pull out of the lane at stops, so traffic passes them as it does in Bengaluru. Any background vehicle stuck for over 2 minutes leaves the corridor, as if turning into a side street, so a leftover map glitch can't gridlock the route. Buses are never removed, and the count is reported as `traffic_removed`.
- **Passengers.** Poisson arrivals at 0.4 per minute per stop, doubling around the 08:30 peak, each heading to a random later stop. Bus capacity is 80.
- **Dwell.** 4 s + 2.0 s per boarding + 1.2 s per alighting. A late bus meets more passengers, dwells longer and falls further behind, which is how bunching emerges.
- **Holding.** At every stop except the first and last, the policy picks a hold from `holding.actions_s` (0–90 s), added after dwell.
- **Scenarios.** `base`; `rain` (all roads × 0.7); `breakdown` (one seeded bus leaves service 1–2 h in, and its passengers wait at that stop for the next bus). Rain and breakdown can also be triggered live.
- **Logs.** One `StopArrival` per bus per stop, a `PassengerTrip` per journey and a `VehicleTrip` per bus, fed into Varun's `compute_kpis`.

## Calibration and validation

GPS medians count only moving time (Varun drops pings below 3 km/h). SUMO then adds its own signals, traffic and stops, so measured speeds used directly make buses run too slow. One factor scales all speeds (`speed_calibration: 2.35`). It was tuned so 375-D's simulated running time matches its timetable, then checked on the other two routes **without retuning**:

| Route | Simulated mean trip (no control, base, 8 seeds) | GTFS timetable | Difference |
| --- | ---: | ---: | ---: |
| 375-D | 1992 s | 2023 s | −1.6% (calibrated here) |
| 378 | 5045 s | 5007 s | +0.8% |
| 401-M (held out) | 2972 s | 3416 s | −13.0% |

The GPS data still sets which roads and hours are slower; the factor only sets the overall level.

## Baseline results

288 runs: 3 routes × 3 scenarios × 4 policies × 8 seeds, 07:00–11:00. Figures are in `runs/figures/` (`python -m sim.figures`).

- **Two-headway holding is the most regular** on every route (headway CV 0.31–0.34 against 0.55–0.74 with no control), for 3–4 minutes of extra trip time.
- **Daganzo (forward-headway) holding almost eliminates bunched arrivals** (≤0.1%), but its CV is higher than two-headway's and it adds 3–7 minutes per trip. Schedule holding is the weakest controller.
- **Rain hurts most:** bunched arrivals under no control rise from 6% to 13% on 375-D and from 15% to 23% on 378. Holding still helps.
- **A single breakdown barely moves the 4-hour averages** (one bus out of about 90); it shows up locally in the dashboard and the time-space plots.
- **On 378 (58 stops), buses run full**, so waits are long whatever the policy (see Limitations).
- **Target for MAPPO:** beat two-headway's CV with Daganzo's near-zero bunching and less extra trip time, including zero-shot on 401-M.

| Route | Scenario | Policy | Headway CV | Bunched (<20%) | Bunched (<50%) | Wait (s) | Trip (s) | Hold (s) |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 375-D | base | Daganzo | 0.40 | 0.1% | 1.0% | 210 | 2176 | 11.1 |
| 375-D | base | No control | 0.55 | 6.2% | 13.1% | 233 | 1992 | 0.0 |
| 375-D | base | Schedule | 0.46 | 3.8% | 8.0% | 233 | 2230 | 12.8 |
| 375-D | base | Two-headway | 0.34 | 2.0% | 5.9% | 205 | 2157 | 9.8 |
| 375-D | breakdown | Daganzo | 0.41 | 0.1% | 1.0% | 217 | 2180 | 11.4 |
| 375-D | breakdown | No control | 0.55 | 6.5% | 13.1% | 242 | 2006 | 0.0 |
| 375-D | breakdown | Schedule | 0.46 | 3.2% | 7.6% | 237 | 2234 | 12.9 |
| 375-D | breakdown | Two-headway | 0.34 | 1.7% | 6.0% | 209 | 2137 | 10.0 |
| 375-D | rain | Daganzo | 0.49 | 0.3% | 3.5% | 242 | 2788 | 17.9 |
| 375-D | rain | No control | 0.67 | 13.0% | 20.4% | 273 | 2576 | 0.0 |
| 375-D | rain | Schedule | 0.62 | 10.6% | 17.5% | 272 | 2675 | 6.1 |
| 375-D | rain | Two-headway | 0.49 | 5.3% | 12.0% | 238 | 2640 | 8.4 |
| 378 | base | Daganzo | 0.40 | 0.0% | 0.9% | 906 | 5470 | 12.9 |
| 378 | base | No control | 0.73 | 15.0% | 25.1% | 853 | 5045 | 0.0 |
| 378 | base | Schedule | 0.44 | 4.0% | 7.4% | 1001 | 5445 | 11.0 |
| 378 | base | Two-headway | 0.34 | 2.8% | 6.8% | 919 | 5301 | 8.7 |
| 378 | breakdown | Daganzo | 0.42 | 0.0% | 0.9% | 960 | 5493 | 13.0 |
| 378 | breakdown | No control | 0.74 | 14.9% | 24.8% | 913 | 5058 | 0.0 |
| 378 | breakdown | Schedule | 0.44 | 4.0% | 7.3% | 1078 | 5446 | 11.0 |
| 378 | breakdown | Two-headway | 0.34 | 2.7% | 6.8% | 990 | 5276 | 8.8 |
| 378 | rain | Daganzo | 0.55 | 0.4% | 4.9% | 1398 | 7308 | 22.4 |
| 378 | rain | No control | 0.90 | 23.3% | 34.4% | 1280 | 6631 | 0.0 |
| 378 | rain | Schedule | 0.85 | 20.7% | 30.6% | 1291 | 6682 | 1.8 |
| 378 | rain | Two-headway | 0.59 | 9.4% | 18.2% | 1308 | 6752 | 8.1 |
| 401-M | base | Daganzo | 0.55 | 0.0% | 0.0% | 305 | 3167 | 8.6 |
| 401-M | base | No control | 0.74 | 9.7% | 17.6% | 340 | 2972 | 0.0 |
| 401-M | base | Schedule | 0.52 | 0.3% | 0.9% | 326 | 3383 | 14.5 |
| 401-M | base | Two-headway | 0.31 | 0.3% | 2.2% | 265 | 3193 | 9.3 |
| 401-M | breakdown | Daganzo | 0.55 | 0.0% | 0.0% | 313 | 3153 | 8.1 |
| 401-M | breakdown | No control | 0.74 | 9.2% | 17.1% | 355 | 2967 | 0.0 |
| 401-M | breakdown | Schedule | 0.52 | 0.2% | 0.6% | 336 | 3381 | 14.5 |
| 401-M | breakdown | Two-headway | 0.31 | 0.1% | 2.2% | 273 | 3197 | 9.3 |
| 401-M | rain | Daganzo | 0.56 | 0.0% | 0.3% | 350 | 3908 | 12.8 |
| 401-M | rain | No control | 0.79 | 13.7% | 22.7% | 391 | 3616 | 0.0 |
| 401-M | rain | Schedule | 0.69 | 6.4% | 12.4% | 376 | 3682 | 3.9 |
| 401-M | rain | Two-headway | 0.42 | 1.2% | 6.1% | 318 | 3750 | 7.6 |

## For Vikas: environment, runner and dataset

```python
from sim.env import BMTCHoldingEnv
env = BMTCHoldingEnv(predictor=my_predictor)          # predictor optional: predict(history) -> Prediction
obs, infos = env.reset(seed=1, options={"scenario": "378_rain"})
while env.agents:                                    # buses currently at a stop, waiting for a hold
    obs, rewards, terminations, truncations, infos = env.step({a: actor(obs[a]) for a in env.agents})
env.kpis()
```

- **Agents and actions.** Agents are GTFS trip IDs. Actions are indices into `holding.actions_s` (0, 15, 30, 45, 60, 90 s).
- **Observation.** 12 values (see the `sim/env.py` docstring), including `p_bunch` and a flag for whether a prediction is available. `infos[bus]["bus_state"]` is the Part 1 `BusObservation`.
- **Reward (semi-Markov).** `−|fwd − bwd|/H − 0.1 · hold · onboard / (H · capacity)`. It arrives with the bus's next decision, with `infos[bus]["elapsed_s"]` for discounting.
- **Centralised critic.** `env.state()` is a 200-value global state: 25 buses × 4 features × 2 directions.
- **Rule-based baselines through the env:** `hold_indices(BaselinePolicy(name, cfg.holding).act({a: infos[a]["bus_state"]}), env.actions_s)`.
- **Runner.** `Runner(scenario, seed, policy, predictor).stream()` yields `Snapshot`s. `set_policy()` and `trigger("rain" | "clear" | "breakdown")` work live. `side_by_side(scenario, seed, policy_a, policy_b)` runs two identical seeded simulations. Policies only need `act(obs) -> {bus_id: hold_s}`, so MAPPO plugs in directly.
- **Dataset.** `runs/dataset/arrivals.parquet` has one row per bus per stop: route, condition, scenario, policy, seed, split (`train` seeds 1–5, `test` seeds 101–103, `held_out_route` for 401-M), bus/trip, stop, time, forward and backward headway, schedule deviation, dwell, load, waiting passengers, hour, and Varun's labels `bunch_next_3/5/8` (null = unknown). Split by episode, never by row.
- **Speed.** A 375-D episode takes about 10 s and a 378 episode about 30 s. Use `python -m sim.dataset --workers N` or one environment per process for parallel runs.

## Dashboard

`streamlit run dashboard/app.py`:
- **Controls (sidebar):** route, scenario, policy, seed and speed. **Start** restarts with the chosen settings; **Play/Pause** and **Step** control the clock.
- **Map:** buses on the road (pydeck), coloured green for a normal gap, orange for a gap under half the schedule, red for bunched and blue for holding at a stop.
- **Time-space diagram** of the last 90 minutes (Plotly), plus KPI cards and bunching alerts.
- **What-if:** Rain, Clear and Breakdown buttons work during a run.
- **Side-by-side:** a second policy on the same seed.
- **Baseline results** tab.

Part 3 adds MAPPO to the policy list and predictions to the alerts.

## Limitations (put these in the report)

1. **Simulation only.** Report results "in a calibrated simulation of BMTC routes".
2. **GPS speeds are from August 2019** (pre-COVID). One global calibration factor is fitted to the 2026 timetable on one route.
3. **Passenger demand is assumed** (0.4/min/stop + peak), because stop-level ridership isn't public. On long routes (378) buses fill up and passengers get left behind, so waits are long. Test sensitivity with `demand_per_min` in `config.yaml`.
4. **Background traffic covers only the route's own roads** (no cross streets), at 200 vehicles/h/direction, and stuck vehicles are removed after 2 minutes. It adds realistic friction but is not a calibrated traffic model.
5. **The timetable has near-duplicate trips** (0–60 s apart, up to 4 at the same second). One per 2 minutes is kept (`min_departure_gap_s`). Varun should check these in the source feed.
6. **Trips are not linked.** Each GTFS trip is a separate bus; there are no terminal layovers or vehicle blocks.
7. **Varun's 20% bunching threshold is strict.** KPIs also include the 50% threshold and headway CV.
8. **Small map glitches remain.** 24 of 288 runs had 1–3 bus teleports (a bus stuck over 5 minutes is moved ahead by SUMO), and 378 has one 3 m turnaround stub. Neither changes the averages noticeably.
