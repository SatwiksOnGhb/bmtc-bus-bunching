# BMTC Part 1 · Varun to Satwik

Start with `runs/gps/osm_way_speeds.csv`, `data/raw/corridors.osm` and `data/processed/gtfs/selected_gtfs.zip`. The speed measurements come from historical BMTC GPS on **1 August 2019**, 07:00–19:00 IST. The `cni_2022` identifier refers to the challenge. The network uses a June 2026 OSM snapshot, and the service plan uses the GTFS schedule for 16 November 2026. A corridor label means geographic overlap with a selected route. The GPS source contains no GTFS trip or route IDs.

## Check the handoff on Windows

Extract the ZIP. Open PowerShell in the folder containing this README. Run each command on its own line.

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements-part1.txt
python -m pytest -q
python -m examples.satwik_smoke
python scripts/check_handoff.py
Import-Csv .\runs\gps\osm_way_speeds.csv | Select-Object -First 5
Get-Content .\runs\gps\gps_quality.json
jupyter nbconvert --execute --to notebook --inplace data/eda.ipynb
```

The executed notebook includes the schedule distributions, pattern spacing, hourly moving speeds with sample counts, quality table and map. Open `data/eda.ipynb` in VS Code or Jupyter to view the saved plots. Schedule cells also run when GPS outputs are absent.

## Reproduce the GPS calibration

1. Download the pinned-content CNI file and normalize it. This command saves the upstream file as `data/BMTC.parquet.gzip`, checks its Git blob ID, and writes `data/raw/cni_normalized.csv` and `data/raw/cni_provenance.json`. The latter records the source SHA-256, schema, acquisition date, timestamp range, timezone assumption and exclusions. The upstream GitHub repository is [HSShashank/CNI-22](https://github.com/HSShashank/CNI-22).

```powershell
python -m data.cni --download
```

For a previously downloaded file, run `python -m data.cni --input data/BMTC.parquet.gzip`. Add `--download-date YYYY-MM-DD` with the actual acquisition date when known. The normalizer checks the four required fields, retains original valid positions and times, and excludes missing or invalid values. It retains one copy of an identical bus/time/position and discards every remaining position at a conflicting bus/time. The upstream `Speed` column is recorded in the schema. The calibrated speeds are derived independently from consecutive positions.

2. Use the shipped `data/raw/corridors.osm` to reproduce the original network and way IDs. To fetch a fresh extract from Overpass using Python, run the command below. A live refresh can change OSM geometry and IDs. Regenerate calibration, network and edge overrides together after a refresh.

```powershell
python -m data.corridors
```

The downloader derives the WGS84 box from all selected GTFS shapes and stops, pads it by approximately 1 km, fetches highway ways and their nodes, and keeps complete motor-road ways intersecting a 1 km buffer around the corridors or stops. Node IDs, road IDs and original tags are preserved. It verifies geometry, referenced nodes and per-route road intersection. The stored query, bounds, OSM snapshot, hashes, node/way counts and acquisition date are in `data/raw/corridors_provenance.json`. The extract is a road network of ways and nodes. It omits OSM turn-restriction relations. Map data © OpenStreetMap contributors, licensed under [ODbL 1.0](https://www.openstreetmap.org/copyright).

3. Run the cleaner from this project root.

```powershell
python -m data.gps_clean `
  --gps data/raw/cni_normalized.csv `
  --roads data/raw/corridors.osm `
  --selected-gtfs data/processed/gtfs/selected_gtfs.zip `
  --source cni_2022 `
  --out runs/gps
```

The shortcut `.\scripts\rebuild_gps.ps1` downloads and normalizes the GPS trace, reuses the supplied OSM extract if present, and runs calibration.

| File | What Satwik should use |
| --- | --- |
| `runs/gps/osm_way_speeds.csv` | One row per supported OSM way and IST hour. Use `median_speed_mps` for the SUMO edge-hour join. Quartiles, mean and median in km/h, sample counts and distinct buses are included. |
| `runs/gps/corridor_hour_speeds.csv` | Raw-pair quartiles, median, sample count and distinct buses for each corridor and hour, restricted to published way-hours. Roads shared by corridors contribute to each applicable corridor. |
| `runs/gps/gps_quality.json` | Raw and retained rows, reasons for rejection, no-candidate and ambiguous points, supported ways, thresholds and dates. `matched_osm_ways` includes any confident point match. `matched_ways` counts ways with published speeds. |
| `data/raw/cni_provenance.json`, `data/raw/corridors_provenance.json` | Source identifiers, dates, hashes and transformation details. |

The cleaner orders pings by bus and time, interprets timezone-naive timestamps as IST, and converts explicit offsets to UTC before calculating elapsed seconds. Great-circle displacement in metres divided by elapsed seconds gives speed. It retains intervals of at most 120 seconds and speeds from 3 to 90 km/h. It clips candidate roads to the 120 m route buffers, searches within 35 m, and requires the second-best road to be at least 4 m farther away than the nearest road. Both consecutive endpoints must match the same way. The midpoint sets the IST hour. Each published bin has at least five pairs and two buses. Uncovered bins remain absent. The estimate pools travel directions and describes moving buses. Apply network defaults where an estimate is unavailable.

## Selected routes

Counts cover valid scheduled trips on 16 November 2026. The selection takes the top three distinct route short names, counting all valid directions and variants for each GTFS route ID.

| Role | Route | GTFS route ID | Scheduled trips | Corridor |
| --- | --- | --- | ---: | --- |
| Train | 375-D | `BMTC:f24361ed9448` | 434 | Banashankari Bus Station ↔ Kengeri Bus Stand |
| Train | 378 | `BMTC:0d990fa9636d` | 384 | Electronic City ↔ Kengeri Bus Stand |
| Transfer | 401-M | `BMTC:e0c7829c0795` | 353 | Kengeri Bus Stand ↔ Yeshwanthapura Bus Station |

Keep 401-M out of training and tuning. All three routes share the Kengeri terminal, so this is a route-level transfer test with shared geography.

| File under `data/processed/gtfs/` | Use |
| --- | --- |
| `selected_gtfs.zip` | One-day feed with trips, stops, shapes and service calendar for SUMO |
| `route_manifest.json` | Route IDs, roles, source hash and cleaning counts |
| `cleaned_routes.csv` | All 4,516 routes with valid active trips, ranked by daily trip count |
| `patterns.csv`, `pattern_stops.csv` | Direction, representative trip, and zero-based stop order per pattern |
| `scheduled_arrivals.csv` | Planned arrival, departure and headway in seconds per `trip_id` and `stop_idx` |
| `scheduled_headway_eda.csv`, `scheduled_trip_times.csv` | Schedule statistics used by `data/eda.ipynb` |

## SUMO on Windows

Install SUMO with its command-line tools, add its `bin` directory to PATH and set `SUMO_HOME` to the SUMO installation directory. For example, if installed there, run `$env:SUMO_HOME = 'C:\Program Files (x86)\Eclipse\Sumo'`. The Python tests run independently of SUMO. From the activated environment and the project root:

```powershell
python -m pip install pyproj rtree lxml
New-Item -ItemType Directory -Force runs/sumo | Out-Null
netconvert `
  --osm-files data/raw/corridors.osm `
  --output.original-names true `
  -o runs/sumo/bmtc.net.xml

python "$env:SUMO_HOME/tools/import/gtfs/gtfs2pt.py" `
  --network runs/sumo/bmtc.net.xml `
  --gtfs data/processed/gtfs/selected_gtfs.zip `
  --date 20261116

python -m data.sumo_speeds `
  --net runs/sumo/bmtc.net.xml `
  --speeds runs/gps/osm_way_speeds.csv `
  --out runs/sumo/edge_hour_speeds.csv
```

Use the edge-hour CSV as the lookup for the simulation clock. The join preserves an edge only when its original ID maps unambiguously to one OSM way. Inspect mapped stops and route connectivity before running experiments. Importing a route alone does not validate its running time against observations.

1. Map each SUMO bus trip and stop to the GTFS `trip_id`, `pattern_id`, and `stop_idx`. Preserve a mapping if SUMO rewrites IDs. `t` is elapsed simulation seconds. Derive `hour_ist` from the scenario's start clock. GTFS service-day seconds can exceed 86,400.
2. Build a `BusObservation` at each decision event. Use seconds, positive `sched_dev_s` for a late bus, and `None` for an unknown neighbor headway or schedule target. Set `can_hold=False` at ineligible stops. `p_bunch` can stay `None` until Vikas's predictor is connected.
3. Pass `{bus_id: BusObservation}` to `BaselinePolicy("no_control", cfg.holding).act(...)`. Convert its `{bus_id: hold_seconds}` output using `hold_indices(holds, cfg.holding.actions_s)` before calling the environment with action indices. Try `schedule`, `daganzo`, and `two_headway` with the same seed and scenario.
4. Log one validated `StopArrival` per trip-stop and a distinct `episode_id` per run. Call `compute_kpis` per episode and route. Provide `PassengerTrip` and `VehicleTrip` records for the passenger and trip metrics.
5. Save arrivals as Parquet. Run `python -m data.label_arrivals --input runs/arrivals.parquet --out runs/labelled.parquet`. Pass the result to Vikas. Keep future-label columns out of model inputs and split by episode or scenario.

The policies implement no control, schedule earliness correction, Daganzo-style forward-headway feedback, and two-headway balancing. Holds round down to the configured duration set. For schedule holding, pass the schedule deviation at departure readiness so the boarding dwell is accounted for. Arrival deviation can still be logged as a predictor feature.

### Labels and KPIs

- `bunch_next_3`, `bunch_next_5`, and `bunch_next_8` look strictly after the current stop in the same trip and episode. A label is true when an observed forward gap falls below the threshold. A complete window with no event is false. An incomplete window without a known event is null.
- Start at a provisional ratio of `0.20`. The training schedule EDA compares planned gaps with the median for the same pattern and stop. At 20%, the flagged shares were 6.87% on 375-D and 0% on 378. At 25%, they rose to 15.71% and 6.55%. Revisit the ratio using observations or training simulation data. In the actual label, the denominator is the trip-stop's scheduled predecessor gap with a positive pattern-stop median fallback.
- Headway CV uses population standard deviation divided by mean within comparable episodes, patterns and stops, weighted by eligible gap count. Bunched arrival percentage uses arrivals with both a measured or simulated gap and a schedule target. Wait and delay use completed passenger journeys. Delay is the signed in-vehicle difference from a supplied reference for the same origin and destination. Trip time uses completed bus trips. Metrics with missing inputs return null with coverage counts.

### Rebuild the optional schedule inputs

The [pinned community feed](https://github.com/Vonter/bmtc-gtfs/tree/a4702664d65bfbb37290a5f75effaa24ead1d9dd) comes from Namma BMTC. It describes planned service and may include interpolated stop times. `data/processed/gtfs/ATTRIBUTION.md` has its license and checksum.

```powershell
New-Item -ItemType Directory -Force data/raw | Out-Null
curl.exe -fL https://raw.githubusercontent.com/Vonter/bmtc-gtfs/a4702664d65bfbb37290a5f75effaa24ead1d9dd/gtfs/bmtc.zip -o data/raw/bmtc.zip
python -m data.gtfs_clean --gtfs data/raw/bmtc.zip --out data/processed/gtfs
```

The cleaner honors service calendars and date exceptions, drops unusable trips and removes unreferenced stops from the selected export. It supports feeds with explicit stop times.


## Verification on the supplied inputs

| Check | Measured result |
| --- | ---: |
| GPS collection | 1 August 2019, 07:00–19:00 IST |
| Source rows / retained rows | 6,014,946 / 6,013,915 |
| Buses / duplicate or conflicting rows removed | 1,942 / 1,031 |
| Invalid coordinate rows / invalid timestamp rows | 0 / 0 |
| Motion intervals above 90 km/h | 17,766 |
| Matched points / unmatched points | 399,828 / 5,614,087 |
| Ambiguous points within the unmatched count | 206,250 |
| Consecutive same-way moving pairs | 88,350 |
| Sparse way-hour bins omitted | 2,748 |
| Pairs supporting published estimates | 83,271 |
| Published way-hours / distinct ways | 2,198 / 325 |
| Corresponding SUMO edge-hours / distinct edges | 25,877 / 3,151 |

All 2,198 published way-hours have at least one corresponding SUMO edge. Of the 4,088 road ways within the 120 m matching corridors, 2,690 received a confident GPS point match. The final table covers 325 ways after requiring same-way movement and sufficient observations. Coverage outside those ways or collection hours is unknown.

| Corridor | Supported way-hours | Distinct OSM ways |
| --- | ---: | ---: |
| 375-D | 667 | 99 |
| 378 | 956 | 134 |
| 401-M | 1,093 | 161 |

Corridor totals overlap on shared roads. The source OSM query covered longitudes 77.46934–77.67994°E and latitudes 12.82720–13.03955°N. The clipped extract has 73,464 nodes and 21,246 ways. Use the full SHA-256 hashes in the two provenance files to verify the GPS and map inputs.

The offline suite passed 17 tests. All 11 code cells executed with an in-process IPython session, including rendered plots and tables. The complete notebook also ran with GPS outputs absent. In the build environment, the standard nbconvert command reached kernel startup and ZeroMQ was denied a socket operation. The PowerShell instructions use the standard Jupyter command for local execution.

As a stop-matching sensitivity check, SUMO 1.28.0 with `--radius 40` imported all 1,171 GTFS trips into 14 service route definitions. The 192 stop objects represented 44,707 of 45,849 planned stop calls after expanding routes over trips. SUMO loaded those files successfully. A smaller matching radius dropped some terminal calls. Review stop locations and detours before using the service for holding-control experiments.
