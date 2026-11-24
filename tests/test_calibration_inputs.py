import json
from pathlib import Path
from zipfile import ZipFile

import nbformat
import pandas as pd
import pytest

from data.cni import normalize, parse_times
from data.corridors import bounds, clip_download, validate
from data.gps_clean import read_ways, clean_points
from common.settings import load_settings


def test_normalization_provenance_and_rejection_counts(tmp_path):
    raw = pd.DataFrame({
        "BusID": ["001"]*7, "Latitude":[13,13,13,13,13,130,13],
        "Longitude":[77,77,77,78,77,77,77],
        "Timestamp":["2019-08-01 07:00","2019-08-01 07:00","2019-08-01 07:01",
                     "2019-08-01 07:01","bad","2019-08-01 07:03","2019-08-01 07:04"]})
    src = tmp_path / "trace.parquet"
    raw.to_parquet(src)
    report = normalize(src, tmp_path, "2026-11-23")
    assert report["source_year"] == 2019 and report["normalized_rows"] == 2
    assert report["source_rows"] == 7 and len(report["source_sha256"]) == 64
    assert report["dropped_rows"] == dict(identical_duplicate=1, conflicting_key=2,
                                           invalid_timestamp=1, invalid_coordinate=1, missing_bus_id=0)
    csv = pd.read_csv(tmp_path/"cni_normalized.csv",dtype=str)
    assert csv.columns.tolist() == ["bus_id","timestamp","lat","lon"]
    assert list(csv.bus_id) == ["001","001"]
    assert json.loads((tmp_path/"cni_provenance.json").read_text()) == report
    raw.drop(columns="Timestamp").to_parquet(src)
    with pytest.raises(ValueError,match="Timestamp"):
        normalize(src,tmp_path)
    raw.iloc[[0]].assign(Timestamp="2022-01-01 12:00").to_parquet(src)
    with pytest.raises(ValueError,match="2019"):
        normalize(src,tmp_path)


def test_mixed_instants_and_motion_outliers(tmp_path):
    parsed = parse_times(pd.Series(["2019-08-01 08:00","2019-08-01T02:30:00Z","bad"]))
    assert parsed[0] == parsed[1] and parsed.isna().iloc[2]
    p = tmp_path/"trace.csv"
    p.write_text("bus_id,timestamp,lat,lon\na,2019-08-01 08:00:00,13,77\na,2019-08-01 08:00:01,13,77.5\n")
    _,report = clean_points(p,load_settings().gps)
    assert report["pairs_above_max_speed"] == 1


def test_osm_bounds_reference_integrity_and_missing_corridor(tmp_path):
    feed = tmp_path/"test.zip"
    with ZipFile(feed,"w") as z:
        z.writestr("trips.txt","route_id,trip_id\nA,1\nB,2\n")
        z.writestr("stops.txt","stop_id,stop_lon,stop_lat\na,77,13\nb,77.001,13\nc,78,13\nd,78.001,13\n")
        z.writestr("stop_times.txt","trip_id,stop_id,stop_sequence\n1,a,1\n1,b,2\n2,c,1\n2,d,2\n")
    west, south, east, north = bounds(feed,1000)
    assert west < 77 < 78.001 < east and south < 13 < north
    raw = tmp_path/"test.osm"
    a = '<node id="1" lon="77" lat="13"/><node id="2" lon="77.001" lat="13"/>'
    b = '<node id="3" lon="78" lat="13"/><node id="4" lon="78.001" lat="13"/>'
    way = '<way id="{}"><nd ref="{}"/><nd ref="{}"/><tag k="highway" v="primary"/></way>'
    raw.write_text("<osm>"+a+b+way.format(111,1,2)+"</osm>")
    with pytest.raises(ValueError,match="Missing roads"):
        validate(raw,feed)
    raw.write_text("<osm>"+a+b+way.format(111,1,2)+way.format(222,3,4)+"</osm>")
    clipped = tmp_path/"clipped.osm"
    clip_download(raw,clipped,feed,1000)
    assert validate(clipped,feed)["corridor_intersecting_ways"] == {"A":1,"B":1}
    assert {w for w,_ in read_ways(clipped)} == {"111","222"}
    raw.write_text("<osm>"+a+way.format(111,1,9)+"</osm>")
    with pytest.raises(ValueError,match="Incomplete"):
        validate(raw,feed)


def test_notebook_missing_gps_outputs(tmp_path,capsys):
    nb = nbformat.read(Path(__file__).resolve().parents[1]/"data/eda.ipynb",4)
    nbformat.validate(nb)
    namespace = {"root":tmp_path,"pd":pd,"json":json}
    cells = [c.source for c in nb.cells if c.cell_type=="code"]
    exec(next(c for c in cells if c.startswith("gps_dir =")),namespace)
    exec(next(c for c in cells if c.startswith("if verified and hour_file")),namespace)
    assert capsys.readouterr().out.count("GPS calibration not yet available") == 2
