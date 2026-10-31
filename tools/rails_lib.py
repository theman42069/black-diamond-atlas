# Helpers shared by ar_scrape.py and ar_match.py, kept apart from those scripts so they can be tested
# (test_rails_lib.py) without scraping anything.
import re


def decode(s):
    """Google encoded polyline (precision 5), as Abandoned Rails stores its routes -> [(lng, lat), ...]."""
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


GENERIC = set('branch railroad rail road railway line track industrial the and of junction pa secondary running spur'.split())
def words(s): return {w for w in re.findall(r'[a-z]+', (s or '').lower()) if w not in GENERIC and len(w) > 2}


def names_agree(p, l):
    # A neighbouring line in the same valley can run within 50 m. When the OSM line carries its own railroad-style
    # name, it must share a real word with the history; trails and roads on an old grade are kept.
    name = ' '.join(filter(None, [p.get('name'), p.get('railroad')]))
    if not re.search(r'(?i)branch|rail ?road|railway|track|line\b', name) or re.search(r'(?i)trail', name):
        return True
    return bool(words(name) & words(' '.join([l['title'], l['between'] or '', l['slug'].replace('-', ' ')] + l['railroads'])))
