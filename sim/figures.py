"""Report figures from the baseline dataset (run `python -m sim.dataset` first).

    python -m sim.figures
Writes runs/figures/baselines_<condition>.png, time_space_<route>.png and validation.csv.
"""
from pathlib import Path

import matplotlib
import pandas as pd

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "runs" / "dataset"
OUT = ROOT / "runs" / "figures"
POLICIES = ["no_control", "schedule", "daganzo", "two_headway"]
LABELS = {"no_control": "No control", "schedule": "Schedule", "daganzo": "Daganzo", "two_headway": "Two-headway"}
COLORS = ["#9E9E9E", "#4C78A8", "#F58518", "#54A24B"]
ROUTES = {"375d": "375-D", "378": "378", "401m": "401-M (held out)"}
METRICS = [("headway_cv", "Headway CV"), ("bunched_arrivals_pct", "Bunched arrivals (%)"),
           ("mean_passenger_wait_s", "Mean passenger wait (s)"), ("mean_trip_time_s", "Mean trip time (s)")]


def baselines(kpis):
    for condition, sub in kpis.groupby("condition"):
        fig, axes = plt.subplots(1, len(METRICS), figsize=(18, 4.2))
        for ax, (m, label) in zip(axes, METRICS):
            stats = sub.groupby(["route", "policy"])[m].agg(["mean", "std"]).reset_index()
            width = 0.2
            for i, p in enumerate(POLICIES):
                rows = stats[stats.policy == p].set_index("route").reindex(list(ROUTES))
                ax.bar([j + i * width for j in range(len(ROUTES))], rows["mean"], width, yerr=rows["std"],
                       capsize=2, color=COLORS[i], label=LABELS[p])
            ax.set_xticks([j + 1.5 * width for j in range(len(ROUTES))], list(ROUTES.values()), fontsize=8)
            ax.set_title(label, fontsize=10)
        axes[0].legend(fontsize=8)
        fig.suptitle(f"Rule-based holding, scenario '{condition}' (mean ± sd over 8 seeds, 07:00-11:00)")
        fig.tight_layout()
        fig.savefig(OUT / f"baselines_{condition}.png", dpi=150)
        plt.close(fig)


def time_space(arrivals):
    for route, label in ROUTES.items():
        sub = arrivals[(arrivals.route == route) & (arrivals.condition == "base") & (arrivals.seed == 1)
                       & arrivals.policy.isin(["no_control", "two_headway"])]
        patterns = sorted(sub.pattern_id.unique())
        fig, axes = plt.subplots(len(patterns), 2, figsize=(15, 4.5 * len(patterns)), sharex=True, squeeze=False)
        for col, p in enumerate(["no_control", "two_headway"]):
            for row, pattern in enumerate(patterns):
                ax = axes[row][col]
                for _, g in sub[(sub.policy == p) & (sub.pattern_id == pattern)].groupby("bus_id"):
                    g = g.sort_values("t")
                    ax.plot(g.t / 3600, g.stop_idx, lw=0.8)
                ax.set_title(f"{LABELS[p]} · direction {row + 1}", fontsize=10)
                ax.set_ylabel("Stop index")
        for ax in axes[-1]:
            ax.set_xlabel("Time of day (h)")
        fig.suptitle(f"Route {label}: one line per bus; lines touching = bunching (seed 1)")
        fig.tight_layout()
        fig.savefig(OUT / f"time_space_{route}.png", dpi=130)
        plt.close(fig)


def validation(kpis):
    sched = pd.read_csv(ROOT / "data" / "processed" / "gtfs" / "scheduled_arrivals.csv")
    arrivals = pd.read_parquet(DATA / "arrivals.parquet", columns=["route", "trip_id"]).drop_duplicates()
    rows = []
    for route, label in ROUTES.items():
        trips = arrivals[arrivals.route == route].trip_id.unique()
        g = sched[sched.trip_id.isin(trips)].groupby("trip_id").arrival_s
        timetable = (g.max() - g.min()).mean()
        sim = kpis[(kpis.route == route) & (kpis.condition == "base") & (kpis.policy == "no_control")]
        rows.append({"route": label, "simulated_trip_s": round(sim.mean_trip_time_s.mean()),
                     "timetable_trip_s": round(timetable),
                     "difference_pct": round(100 * (sim.mean_trip_time_s.mean() / timetable - 1), 1)})
    table = pd.DataFrame(rows)
    table.to_csv(OUT / "validation.csv", index=False)
    print(table.to_string(index=False))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    kpis = pd.read_csv(DATA / "baseline_kpis.csv")
    baselines(kpis)
    time_space(pd.read_parquet(DATA / "arrivals.parquet",
                               columns=["route", "condition", "seed", "policy", "pattern_id", "bus_id", "t", "stop_idx"]))
    validation(kpis)
    print(f"Figures in {OUT}")


if __name__ == "__main__":
    main()
