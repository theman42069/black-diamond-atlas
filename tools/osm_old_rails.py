# Add old rail lines from OpenStreetMap to data/rails-old.geojson: every way tagged as abandoned, disused or
# torn up, in either style (railway=abandoned or abandoned:railway=rail, ...), that the file doesn't have yet.
# Run tools/ar_match.py afterwards so the new lines get their histories too.
import json, sys, time
from pathlib import Path
from scrapling.fetchers import Fetcher

OLD = Path(sys.argv[1])
old = json.loads(OLD.read_text())
have = {f['properties']['osm'] for f in old['features']}
xs = [c[0] for f in old['features'] for c in f['geometry']['coordinates']]
ys = [c[1] for f in old['features'] for c in f['geometry']['coordinates']]
STATUS = {'abandoned': 'abandoned', 'disused': 'disused', 'razed': 'razed', 'dismantled': 'razed', 'removed': 'razed'}
LINE = {'rail', 'narrow_gauge', 'light_rail', 'tram', 'funicular', 'inclined', 'abandoned', 'disused', 'razed', 'dismantled', 'yes'}

# Four tiles: Overpass refuses the whole region with full geometry in one request
x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
xm, ym = (x0 + x1) / 2, (y0 + y1) / 2
els = {}
for (s, w, n, e) in [(y0, x0, ym, xm), (y0, xm, ym, x1), (ym, x0, y1, xm), (ym, xm, y1, x1)]:
    B = f'{s:.5f},{w:.5f},{n:.5f},{e:.5f}'
    q = '[out:json][timeout:180];(' + ''.join(f'way["{k}"]({B});' for k in (
        'abandoned:railway', 'disused:railway', 'razed:railway', 'dismantled:railway', 'removed:railway', 'railway:historic')) + \
        ''.join(f'way["railway"="{v}"]({B});' for v in STATUS) + ');out geom;'
    for attempt in range(5):
        r = Fetcher.post('https://overpass-api.de/api/interpreter', data={'data': q}, timeout=300)
        if r.status == 200 and r.body[:1] == b'{':
            for el in json.loads(r.body)['elements']: els[el['id']] = el
            print('tile', B, 'ok'); break
        print('tile', B, 'status', r.status, 'retry', attempt); time.sleep(30 * (attempt + 1))
    else:
        sys.exit('Overpass failed')
els = list(els.values())

added = 0
for e in els:
    t = e.get('tags', {})
    if e['id'] in have or 'geometry' not in e or len(e['geometry']) < 2: continue
    if t.get('building') or t.get('area') == 'yes' or e['geometry'][0] == e['geometry'][-1]: continue  # stations, roundhouses
    status, what = None, None
    if t.get('railway') in STATUS:
        status, what = STATUS[t['railway']], 'rail'
    else:
        for pre in STATUS:
            if f'{pre}:railway' in t: status, what = STATUS[pre], t[f'{pre}:railway']; break
        else:
            if 'railway:historic' in t: status, what = 'abandoned', t['railway:historic']
    if not status or what not in LINE: continue
    kind = {'narrow_gauge': 'narrow gauge', 'funicular': 'incline', 'inclined': 'incline'}.get(what) or t.get('service') or t.get('usage')
    p = {'osm': e['id'], 'status': status}
    if t.get('name'): p['name'] = t['name']
    rr = t.get('operator') or t.get('was:operator') or t.get('historic:operator') or t.get('abandoned:operator')
    if rr: p['railroad'] = rr
    if kind: p['kind'] = kind
    old['features'].append({'type': 'Feature', 'properties': p, 'geometry': {
        'type': 'LineString', 'coordinates': [[round(g['lon'], 5), round(g['lat'], 5)] for g in e['geometry']]}})
    added += 1

old['attribution'] = 'Data (c) OpenStreetMap contributors, ODbL. Exported 2026-10-27, added to ' + time.strftime('%Y-%m-%d')
out = '{"type":"FeatureCollection",' + json.dumps({k: old[k] for k in old if k not in ('type', 'features')})[1:-1] + ',"features":[\n'
out += ',\n'.join(json.dumps(f, separators=(',', ':')) for f in old['features']) + '\n]}\n'
OLD.write_text(out)
print('added', added, 'now', len(old['features']))
