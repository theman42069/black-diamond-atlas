# Run: python tools/test_rails_lib.py  (no network, no extra packages). Prints "ok" or fails on the first wrong answer.
from rails_lib import decode, names_agree

# Google's published example polyline: (38.5, -120.2), (40.7, -120.95), (43.252, -126.453), returned as (lng, lat)
assert decode('_p~iF~ps|U_ulLnnqC_mqNvxq`@') == [(-120.2, 38.5), (-120.95, 40.7), (-126.453, 43.252)]

lehigh = {'title': 'Mount Carmel to Centralia', 'between': None, 'slug': 'lehigh-valley-mount-carmel',
          'railroads': ['Lehigh Valley Railroad']}
# A line that names another railroad must not take this history...
assert not names_agree({'name': 'Reading Branch'}, lehigh)
# ...one that shares a real word with it may...
assert names_agree({'name': 'Lehigh Valley Branch'}, lehigh)
# ...and trails or unnamed grades are always allowed (the shape match decides).
assert names_agree({'name': 'Reading Branch Trail'}, lehigh)
assert names_agree({}, lehigh)
print('ok')
