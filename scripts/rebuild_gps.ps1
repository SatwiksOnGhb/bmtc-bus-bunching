$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot '..')
try {
    python -m data.cni --download
    if ($LASTEXITCODE -ne 0) { throw 'GPS download or normalization failed' }
    if (-not (Test-Path 'data/raw/corridors.osm')) {
        python -m data.corridors
        if ($LASTEXITCODE -ne 0) { throw 'OSM export failed' }
    }
    python -m data.gps_clean --gps data/raw/cni_normalized.csv --roads data/raw/corridors.osm --selected-gtfs data/processed/gtfs/selected_gtfs.zip --source cni_2022 --out runs/gps
    if ($LASTEXITCODE -ne 0) { throw 'GPS calibration failed' }
} finally {
    Pop-Location
}
