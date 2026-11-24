"""Verify and normalize the historical CNI trace. Run from the project root."""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen
from shutil import copyfileobj

import pandas as pd
import pyarrow.parquet as pq

REPO = "https://github.com/HSShashank/CNI-22"
URL = "https://raw.githubusercontent.com/HSShashank/CNI-22/master/data/BMTC.parquet.gzip"
SOURCE_BLOB = "eca924a6a2a9feb2d1e6aac1c2fd272a77943fb7"
RENAME = {"BusID": "bus_id", "Timestamp": "timestamp", "Latitude": "lat", "Longitude": "lon"}


def checksum(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def parse_times(series, zone="Asia/Kolkata"):
    """Interpret naive local wall clocks as IST and respect explicit offsets."""
    if pd.api.types.is_datetime64_any_dtype(series):
        parsed = series.dt.tz_localize(zone) if series.dt.tz is None else series
        return parsed.dt.tz_convert("UTC")
    strings = series.astype("string")
    clock = strings.str.match(r"^\d{4}-\d\d-\d\d[T ]\d\d:\d\d", na=False)
    offset = strings.str.contains(r"(?:Z|[+-]\d\d:?\d\d)$", na=False)
    naive = pd.to_datetime(strings.where(clock & ~offset), format="mixed", errors="coerce")
    local = naive.dt.tz_localize(zone).dt.tz_convert("UTC")
    if offset.any():
        local = local.where(~offset, pd.to_datetime(strings.where(clock & offset), format="mixed", utc=True, errors="coerce"))
    return local


def normalize(path, folder, downloaded=None):
    parquet = pq.ParquetFile(path)
    schema = parquet.schema_arrow
    missing = RENAME.keys() - set(schema.names)
    if missing:
        raise ValueError(f"Missing CNI columns: {sorted(missing)}")
    frame = parquet.read(columns=list(RENAME)).to_pandas().rename(columns=RENAME)
    null_counts = {col: int(count) for col, count in frame.isna().sum().items()}
    times = parse_times(frame.timestamp)
    valid_coords = (pd.to_numeric(frame.lat, errors="coerce").between(-90, 90)
                    & pd.to_numeric(frame.lon, errors="coerce").between(-180, 180))
    missing_id = frame.bus_id.isna() | frame.bus_id.astype("string").str.strip().eq("")
    valid = ~missing_id & valid_coords & times.notna()
    dropped = dict(missing_bus_id=int(missing_id.sum()),
                   invalid_coordinate=int((~missing_id & ~valid_coords).sum()),
                   invalid_timestamp=int((~missing_id & valid_coords & times.isna()).sum()))
    frame = frame.loc[valid].copy()
    frame["_instant"] = times.loc[valid]
    same = frame.duplicated(["bus_id", "_instant", "lat", "lon"])
    dropped["identical_duplicate"] = int(same.sum())
    frame = frame.loc[~same]
    conflict = frame.duplicated(["bus_id", "_instant"], keep=False)
    dropped["conflicting_key"] = int(conflict.sum())
    frame = frame.loc[~conflict]
    local = frame._instant.dt.tz_convert("Asia/Kolkata")
    if sorted(local.dt.year.unique()) != [2019]:
        raise ValueError("Expected a nonempty CNI file containing only 2019 timestamps")
    folder.mkdir(parents=True, exist_ok=True)
    out = folder / "cni_normalized.csv"
    temp = out.with_suffix(".csv.tmp")
    frame.to_csv(temp, columns=list(RENAME.values()), index=False, chunksize=100000)
    temp.replace(out)
    result = dict(source_repository=REPO, source_file_url=URL, download_date=downloaded,
                  source_sha256=checksum(path), normalized_sha256=checksum(out),
                  schema={f.name: str(f.type) for f in schema},
                  source_rows=parquet.metadata.num_rows, normalized_rows=len(frame),
                  dropped_rows=dropped, null_counts=null_counts,
                  source_year=2019, timezone_policy="Timezone-naive values interpreted as Asia/Kolkata",
                  minimum_timestamp=str(local.min()), maximum_timestamp=str(local.max()),
                  normalized_output=out.as_posix())
    (folder / "cni_provenance.json").write_text(json.dumps(result, indent=2)+"\n", encoding="utf-8")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=Path("data/BMTC.parquet.gzip"))
    parser.add_argument("--out", type=Path, default=Path("data/raw"))
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--download-date", help="UTC acquisition date for an already downloaded file")
    args = parser.parse_args()
    downloaded = args.download_date
    if args.download:
        args.input.parent.mkdir(parents=True, exist_ok=True)
        temp = args.input.with_suffix(".download")
        with urlopen(URL, timeout=180) as response, temp.open("wb") as target:
            copyfileobj(response, target)
        digest = hashlib.sha1(f"blob {temp.stat().st_size}\0".encode())
        with temp.open("rb") as source:
            for block in iter(lambda: source.read(1048576), b""):
                digest.update(block)
        if digest.hexdigest() != SOURCE_BLOB:
            raise ValueError("CNI source differs from the recorded Git blob. Review the upstream revision.")
        temp.replace(args.input)
        downloaded = datetime.now(timezone.utc).date().isoformat()
    print(json.dumps(normalize(args.input, args.out, downloaded), indent=2))


if __name__ == "__main__":
    main()
