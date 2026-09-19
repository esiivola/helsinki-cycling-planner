"""Check the built graph against the cities' signal registers.

The question is not whether the graph has a light near a junction but whether it has
one a *rider* meets: a signal on a carriageway that the router avoids, because a
cycleway runs beside it, is met by nobody. Both numbers are reported.

    python tools/audit_signals.py [tools/signals.json] [public/graph]
"""
from __future__ import annotations

import json, gzip, math, sys
import numpy as np

REACH_M = 40.0
FALLBACK_M = 80.0  # what the build reaches to at an interchange, where the
                   # register's point sits in the middle of the whole thing
DEDICATED, SIDEPATH = 1, 2
directory = sys.argv[2] if len(sys.argv) > 2 else 'public/graph'
m = json.load(open(f'{directory}/graph.json'))
buf = gzip.open(f'{directory}/graph.bin.gz', 'rb').read()
def arr(n):
    s = m['layout'][n]; return np.frombuffer(buf, dtype=np.dtype(s['type']), count=s['count'], offset=s['offset'])
scale, shape_scale = m['coordinate_scale'], m['shape_scale']
lon, lat, kind = arr('lon')/scale, arr('lat')/scale, arr('node_kind')
edge_a, edge_b, edge_class = arr('edge_a'), arr('edge_b'), arr('edge_class')
shape_kind, shape_delta, shape_count = arr('shape_kind'), arr('shape_delta'), arr('shape_count')

# which nodes touch a way a rider would use: a cycleway, or a road with no path beside it
ridable_node = np.zeros(len(lon), dtype=bool)
for edge in range(m['edge_count']):
    if not (edge_class[edge] & SIDEPATH) or (edge_class[edge] & DEDICATED):
        ridable_node[edge_a[edge]] = True
        ridable_node[edge_b[edge]] = True

signals, rider_signals = [], []
for node in range(len(lon)):
    if kind[node] in (2, 3):
        signals.append((float(lon[node]), float(lat[node])))
        if ridable_node[node]:
            rider_signals.append((float(lon[node]), float(lat[node])))
unzig = lambda v: (v >> 1) ^ -(v & 1)
cursor = 0
for edge in range(m['edge_count']):
    count = int(shape_count[edge])
    if count:
        x = round(lon[edge_a[edge]] * shape_scale); y = round(lat[edge_a[edge]] * shape_scale)
        rides = not (edge_class[edge] & SIDEPATH) or bool(edge_class[edge] & DEDICATED)
        for step in range(count):
            x += int(unzig(int(shape_delta[(cursor+step)*2]))); y += int(unzig(int(shape_delta[(cursor+step)*2+1])))
            if shape_kind[cursor+step] in (2, 3):
                signals.append((x/shape_scale, y/shape_scale))
                if rides: rider_signals.append((x/shape_scale, y/shape_scale))
    cursor += count

def coverage(points, city, reach=REACH_M):
    cell = 0.003
    grid = {}
    for x, y in points: grid.setdefault((int(x//cell), int(y//cell)), []).append((x, y))
    missing = []
    for f in city:
        x, y = f['geometry']['coordinates']
        east = math.cos(math.radians(y)) * 111_320
        key = (int(x//cell), int(y//cell))
        best = min((math.hypot((px-x)*east, (py-y)*110_540)
                    for dx in (-1,0,1) for dy in (-1,0,1) for px, py in grid.get((key[0]+dx, key[1]+dy), ())),
                   default=float('inf'))
        if best > reach: missing.append((f['properties'].get('risteys'), best))
    return missing

# Audit against the same register the build reads, city by city.
register = json.load(open(sys.argv[1] if len(sys.argv) > 1 else 'tools/signals.json'))['signals']
as_features = lambda rows: [{'geometry': {'coordinates': [r['lon'], r['lat']]},
                             'properties': {'risteys': r.get('name')}} for r in rows]
groups = {'all': register}
for row in register:
    groups.setdefault(row['city'], []).append(row)
print(f"{'':9} {'junctions':>9}  {'a signal a rider meets, within':>32}")
print(f"{'':9} {'':>9}  {f'{REACH_M:.0f} m':>15} {f'{FALLBACK_M:.0f} m':>16}")
for city_name, rows in groups.items():
    feats = as_features(rows)
    near = len(feats) - len(coverage(rider_signals, feats))
    far = len(feats) - len(coverage(rider_signals, feats, FALLBACK_M))
    print(f"{city_name:9} {len(feats):>9}  {near:>6} ({near/len(feats):5.1%}) {far:>7} ({far/len(feats):5.1%})")
