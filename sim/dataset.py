"""Run Varun's four rule-based baselines across routes, scenarios and seeds; save the labelled
dataset for Part 3 and the baseline KPI tables.

From the bmtc folder:
    python -m sim.dataset                         # everything in config.yaml (seeds_train + seeds_test)
    python -m sim.dataset --routes 375d --conditions base --seeds 1 2   # a subset
    python -m sim.dataset --workers 8             # parallel SUMO runs (default: CPU cores - 1)

Outputs in runs/dataset/:
    arrivals.parquet    one row per bus per stop: route, bus, stop, time, forward and backward
                        headway, schedule deviation, dwell, load, waiting passengers, hour, scenario,
                        policy, seed, split, plus Varun's labels bunch_next_3/5/8 (null = unknown)
    baseline_kpis.csv   one row per run (route x scenario x policy x seed)
    baseline_summary.csv  mean KPIs per route x condition x policy
"""
import argparse
import os
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import pandas as pd

OUT_DIR = Path(__file__).resolve().parents[1] / "runs" / "dataset"
POLICIES = ("no_control", "schedule", "daganzo", "two_headway")


def run_one(job):
    from common.labels import label_arrivals
    from control.baselines import BaselinePolicy
    from sim.bus_sim import SETTINGS, BusSim
    from sim.scenarios import HELD_OUT_ROUTES, make_scenario

    scenario, policy, seed, split = job
    sim = BusSim(make_scenario(scenario, seed=seed, policy=policy))
    rule = BaselinePolicy(policy, SETTINGS.holding)
    obs = sim.reset()
    while not sim.done:
        obs = sim.step(rule.act(obs))
    rows = pd.DataFrame([a.model_dump() for a in sim.arrivals])
    labels = pd.DataFrame(label_arrivals(sim.arrivals, SETTINGS.bunching))
    rows = pd.concat([rows, labels], axis=1)
    rows["route"] = sim.cfg.route
    rows["condition"] = sim.cfg.condition
    rows["split"] = "held_out_route" if sim.cfg.route in HELD_OUT_ROUTES else split
    kpis = {"route": sim.cfg.route, "condition": sim.cfg.condition, "scenario": scenario,
            "policy": policy, "seed": seed, "split": rows["split"].iloc[0], **sim.kpis()}
    return rows, kpis


def main():
    from sim.bus_sim import SETTINGS
    from sim.scenarios import CONDITIONS, ROUTES

    ap = argparse.ArgumentParser()
    ap.add_argument("--routes", nargs="+", default=list(ROUTES))
    ap.add_argument("--conditions", nargs="+", default=list(CONDITIONS))
    ap.add_argument("--policies", nargs="+", default=list(POLICIES))
    ap.add_argument("--seeds", nargs="+", type=int, default=None,
                    help="default: config seeds_train (split=train) and seeds_test (split=test)")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    args = ap.parse_args()

    if args.seeds:
        seeds = [(s, "test" if s in SETTINGS.sim.seeds_test else "train") for s in args.seeds]
    else:
        seeds = [(s, "train") for s in SETTINGS.sim.seeds_train] + [(s, "test") for s in SETTINGS.sim.seeds_test]
    jobs = [(f"{r}_{c}", p, s, split) for r in args.routes for c in args.conditions
            for p in args.policies for s, split in seeds]
    print(f"{len(jobs)} runs on {args.workers} workers", flush=True)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    frames, kpis = [], []
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(run_one, job): job for job in jobs}
        for i, fut in enumerate(as_completed(futures), 1):
            rows, k = fut.result()
            frames.append(rows)
            kpis.append(k)
            print(f"[{i}/{len(jobs)}] {k['scenario']:16} {k['policy']:12} seed {k['seed']:3}: "
                  f"CV {k['headway_cv']:.3f}  bunched {k['bunched_arrivals_pct']:.1f}%  "
                  f"wait {k['mean_passenger_wait_s']:.0f}s  trip {k['mean_trip_time_s']:.0f}s  "
                  f"teleports {k['bus_teleports']}", flush=True)

    data = pd.concat(frames, ignore_index=True)
    data.to_parquet(OUT_DIR / "arrivals.parquet", index=False)
    table = pd.DataFrame(kpis).sort_values(["route", "condition", "policy", "seed"])
    table.to_csv(OUT_DIR / "baseline_kpis.csv", index=False)
    cols = ["headway_cv", "bunched_arrivals_pct", "bunched_pct_r50", "mean_passenger_wait_s",
            "mean_in_vehicle_delay_s", "mean_trip_time_s", "mean_hold_s", "passenger_hours_waiting",
            "bus_teleports"]
    summary = table.groupby(["route", "condition", "policy"])[cols].mean().round(3).reset_index()
    summary.to_csv(OUT_DIR / "baseline_summary.csv", index=False)
    print(f"\n{len(data):,} labelled rows, {len(table)} runs -> {OUT_DIR}")
    print(summary.to_string(index=False))


if __name__ == "__main__":
    main()
