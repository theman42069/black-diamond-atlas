# Attach Abandoned Rails facts to the OSM lines in data/rails-old.geojson whose shape follows an Abandoned Rails
# route (>= 60% of the line's points within 50 m). Their route geometry is used only for matching, not saved.
import json, math, sys
from pathlib import Path

HERE = Path(__file__).parent
OLD = Path(sys.argv[1])
ar = json.loads((HERE / 'ar.json').read_text())
old = json.loads(OLD.read_text())

M_LAT = 111320.0
def xy(p, lat0): return (p[0] * M_LAT * math.cos(math.radians(lat0)), p[1] * M_LAT)

def seg_dist(p, a, b):
    ax, ay = a; bx, by = b; px, py = p
    dx, dy = bx - ax, by - ay
    t = 0 if dx == dy == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

lat0 = 41.0
segs = []  # (line index, a, b, bbox)
for i, l in enumerate(ar):
    for r in l['routes']:
        pts = [xy(p, lat0) for p in r]
        for a, b in zip(pts, pts[1:]):
            segs.append((i, a, b, (min(a[0], b[0]) - 50, min(a[1], b[1]) - 50, max(a[0], b[0]) + 50, max(a[1], b[1]) + 50)))

# coarse grid for speed
G = 2000.0
grid = {}
for s in segs:
    for gx in range(int(s[3][0] // G), int(s[3][2] // G) + 1):
        for gy in range(int(s[3][1] // G), int(s[3][3] // G) + 1):
            grid.setdefault((gx, gy), []).append(s)

GENERIC = set('branch railroad rail road railway line track industrial the and of junction pa secondary running spur'.split())
def words(s): return {w for w in __import__('re').findall(r'[a-z]+', (s or '').lower()) if w not in GENERIC and len(w) > 2}

def names_agree(p, l):
    # A neighbouring line in the same valley can run within 50 m. When the OSM line carries its own railroad-style
    # name, it must share a real word with the history; trails and roads on an old grade are kept.
    name = ' '.join(filter(None, [p.get('name'), p.get('railroad')]))
    if not __import__('re').search(r'(?i)branch|rail ?road|railway|track|line\b', name) or __import__('re').search(r'(?i)trail', name):
        return True
    return bool(words(name) & words(' '.join([l['title'], l['between'] or '', l['slug'].replace('-', ' ')] + l['railroads'])))

used = {}
for f in old['features']:
    f['properties'].pop('ar', None)
    pts = [xy(c, lat0) for c in f['geometry']['coordinates']]
    hits = {}
    for p in pts:
        near = set()
        for s in grid.get((int(p[0] // G), int(p[1] // G)), []):
            if s[0] not in near and s[3][0] <= p[0] <= s[3][2] and s[3][1] <= p[1] <= s[3][3] and seg_dist(p, s[1], s[2]) <= 50:
                near.add(s[0])
        for i in near: hits[i] = hits.get(i, 0) + 1
    best = [i for i, n in hits.items() if n >= 0.6 * len(pts) and len(pts) >= 2 and names_agree(f['properties'], ar[i])]
    if best:
        i = max(best, key=lambda k: hits[k])
        f['properties']['ar'] = i
        used[i] = used.get(i, 0) + 1

# Table of facts for the matched lines, stored once at the top of the file
table = []
remap = {}
for i in sorted(used):
    l = ar[i]
    remap[i] = len(table)
    built = l['built'] if l['built'] and int(l['built']) < 1930 else None
    table.append({k: v for k, v in {
        'title': l['between'] or l['title'], 'url': 'https://www.abandonedrails.com/' + l['slug'],
        'railroads': l['railroads'], 'built': built, 'abandoned': l['abandoned'],
        'filings': [{k2: f[k2] for k2 in ('date', 'docket', 'miles', 'railroad', 'text') if f.get(k2)} for f in l['filings']],
    }.items() if v})
for f in old['features']:
    if 'ar' in f['properties']: f['properties']['ar'] = remap[f['properties']['ar']]
old['history'] = table
old['history_source'] = 'Line histories: Abandoned Rails (abandonedrails.com), facts and ICC filings only. Scraped 2026-10-29'

# Same one-feature-per-line layout as the original file
out = '{"type":"FeatureCollection",' + json.dumps({k: old[k] for k in old if k not in ('type', 'features')})[1:-1] + ',"features":[\n'
out += ',\n'.join(json.dumps(f, separators=(',', ':')) for f in old['features']) + '\n]}\n'
OLD.write_text(out)
print('matched OSM lines:', sum(used.values()), 'to', len(used), 'of', len(ar), 'Abandoned Rails lines')
for i in sorted(used): print('  ', used[i], ar[i]['slug'])
print('unmatched:', [l['slug'] for j, l in enumerate(ar) if j not in used])
