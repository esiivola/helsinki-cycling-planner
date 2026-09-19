#!/usr/bin/env bash
# Build everything the page downloads, in the order the stages depend on each other.
#
#     tools/build_all.sh [extract.osm.pbf] [dem-dir] [out-dir]
#
# The graph and the address index come from the OSM extract; the climb sidecar is
# sampled against the graph that has just been built, so it has to come last. Pass a
# dem-dir holding GeoTIFFs; if it is empty the tiles are fetched, given a key in
# MML_API_KEY or in tools/.mml-key.
#
# With no arguments it uses `data/`, which is gitignored: drop an extract in there
# and a rebuild is one command with nothing to remember.
#
# Roughly 15 minutes for the region: the graph is about 10, the address index 4, and
# climb a handful of seconds.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

extract=${1:-}
if [ -z "$extract" ]; then
  # The newest extract in data/, so a fresher download wins without being renamed.
  extract=$(ls -t data/*.osm.pbf 2>/dev/null | head -1 || true)
fi
if [ -z "$extract" ]; then
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//' >&2
  echo "No extract given and none in data/." >&2
  exit 2
fi
dem=${2:-data/dem}
out=${3:-public/graph}
python=${PYTHON:-.venv/bin/python}
[ -x "$python" ] || python=python3

[ -f "$extract" ] || { echo "no such extract: $extract" >&2; exit 1; }

stage() { printf '\n\033[1m==> %s\033[0m\n' "$1" >&2; }
started=$(date +%s)

stage "graph  ($extract -> $out)"
"$python" tools/build_graph.py "$extract" "$out"

stage "address index"
"$python" tools/build_search.py "$extract" "$out"

# Climb is optional: without it the page prices every route flat, exactly as it did
# before hills existed. A missing DEM is therefore a warning, not a failure.
if ! compgen -G "$dem/*.tif" > /dev/null && { [ -n "${MML_API_KEY:-}" ] || [ -f tools/.mml-key ]; }; then
  stage "elevation tiles -> $dem"
  "$python" tools/fetch_dem.py "$dem" "$out"
fi

if compgen -G "$dem/*.tif" > /dev/null; then
  stage "climb"
  "$python" tools/build_climb.py "$dem" "$out"
else
  printf '\n\033[33mno rasters in %s: skipping climb, routes will be priced flat.\033[0m\n' "$dem" >&2
  printf 'Put a key in MML_API_KEY or tools/.mml-key to fetch them, or pass a\n' >&2
  printf 'directory of GeoTIFFs.\n' >&2
fi

# The city's winter network needs no key and no local input; it is a small fetch and
# entirely optional, so a failure here is a warning rather than a failed build.
stage "winter maintenance"
"$python" tools/build_winter.py "$out" --source data/winter-source.json || \
  printf '\033[33mcould not fetch the winter network; routes will ignore it.\033[0m\n' >&2

stage "done in $(( ($(date +%s) - started) / 60 )) min"
ls -la "$out"
