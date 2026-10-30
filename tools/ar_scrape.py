# Scrape Abandoned Rails' Pennsylvania listing (routes as encoded polylines) and, for lines inside the area of
# data/rails-old.geojson, the ICC abandonment filings on each line's page. Writes ar.json beside this script.
import json, re, sys, time, html as H
from pathlib import Path
from scrapling.fetchers import Fetcher

HERE = Path(__file__).parent
OLD = Path(sys.argv[1])  # path to data/rails-old.geojson
BASE = 'https://www.abandonedrails.com/'


def decode(s):
    pts, i, lat, lng = [], 0, 0, 0
    while i < len(s):
        vals = []
        for _ in range(2):
            shift = res = 0
            while True:
                b = ord(s[i]) - 63; i += 1
                res |= (b & 0x1f) << shift; shift += 5
                if b < 0x20: break
            vals.append(~(res >> 1) if res & 1 else res >> 1)
        lat += vals[0]; lng += vals[1]
        pts.append((lng / 1e5, lat / 1e5))
    return pts


old = json.loads(OLD.read_text())
xs = [c[0] for f in old['features'] for c in f['geometry']['coordinates']]
ys = [c[1] for f in old['features'] for c in f['geometry']['coordinates']]
area = (min(xs), min(ys), max(xs), max(ys))
print('area', area)

page = Fetcher.get(BASE + 'pennsylvania').body.decode(errors='ignore')
lines = []
for m in re.finditer(r'<section name="abndnmnt"([^>]*)>', page):
    a = dict(re.findall(r'data-([a-z]+)=(?:"([^"]*)"|\'([^\']*)\')', m.group(1)) and
             [(k, v or w) for k, v, w in re.findall(r'data-([a-z]+)=(?:"([^"]*)"|\'([^\']*)\')', m.group(1))])
    routes = [decode(r) for r in json.loads(H.unescape(a.get('routes', '[]')) or '[]') if r]
    pts = [p for r in routes for p in r]
    if not pts: continue
    inside = any(area[0] <= x <= area[2] and area[1] <= y <= area[3] for x, y in pts)
    if inside:
        lines.append({'slug': a['filename'], 'title': H.unescape(a['title']), 'routes': routes})
print('PA lines with routes in area:', len(lines))

for n, l in enumerate(lines):
    time.sleep(1)
    try:
        d = Fetcher.get(BASE + l['slug']).body.decode(errors='ignore')
    except Exception as e:
        print('fail', l['slug'], e); continue
    filings = []
    for card in re.findall(r'<div class="lines">(.*?)</table>', d, re.S):
        t = lambda pat: (re.search(pat, card, re.S) or [None, None])[1]
        clean = lambda s: re.sub(r'\s+', ' ', H.unescape(re.sub('<[^>]+>', '', s))).strip() if s else None
        filings.append({
            'railroad': clean(t(r'class="top"[^>]*>(.*?)</td>')),
            'docket': clean(t(r'Docket:\s*<strong[^>]*>(.*?)</strong>')),
            'date': clean(t(r'<td style="text-align:center;">([\d/]+)</td>')),
            'miles': clean(t(r'Length:\s*<strong[^>]*>([\d.]+)')),
            'text': clean(t(r'class="filingText">(.*?)</td>')),
        })
    l['filings'] = filings
    # Facts from the intro: endpoints, railroads, built/abandoned years (not the write-up itself)
    head = d[d.find('<h1'):d.find('Add your comments')]
    text = re.sub(r'\s+', ' ', H.unescape(re.sub(r'<script.*?</script>|<[^>]+>', ' ', head, flags=re.S)))
    sub = re.search(r'<h2[^>]*>(.*?)</h2>', head, re.S)
    l['between'] = re.sub(r'\s+', ' ', H.unescape(re.sub('<[^>]+>', '', sub.group(1)))).strip() if sub else None
    l['railroads'] = [H.unescape(t) for t in re.findall(r'<a href="/[a-z0-9-]+" title="([^"]+)">', head)
                      if not re.fullmatch(r'[A-Z][a-z]+( [A-Z][a-z]+)?', H.unescape(t)) or 'Rail' in t]
    b = re.search(r'\bbuilt (?:in|around|circa|about)? ?(1[789]\d\d)', text)
    a = re.findall(r'\babandoned (?:in|around|circa|about)? ?(1[89]\d\d|20\d\d)', text)
    l['built'] = b.group(1) if b else None
    l['abandoned'] = a[-1] if a else None
    print(n + 1, '/', len(lines), l['slug'], len(filings), 'filings', flush=True)

(HERE / 'ar.json').write_text(json.dumps(lines))
print('saved', len(lines))
