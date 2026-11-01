# Write data/places.json: villages, patch towns, locales (old stations and sidings), mines and post offices in the
# anthracite counties, from the USGS place-name file (GNIS). The 2021 file is used because later ones dropped mines,
# locales and post offices:
#   https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/Archive/MainDomestic/PA_Features_20210825.txt
# Run: python tools/gnis_places.py PA_Features_20210825.txt data/places.json
import csv, json, sys

gnis, out = sys.argv[1:3]
COUNTIES = set('Schuylkill Northumberland Columbia Luzerne Carbon Lackawanna Dauphin Lebanon Susquehanna Wayne Sullivan'.split())
KIND = {'Populated Place': 'Village', 'Locale': 'Locale', 'Mine': 'Mine', 'Post Office': 'Post office'}
rows = []
with open(gnis, encoding='utf-8-sig') as f:
    for r in csv.DictReader(f, delimiter='|'):
        k = KIND.get(r['FEATURE_CLASS'])
        if not k or r['COUNTY_NAME'] not in COUNTIES: continue
        name = r['FEATURE_NAME']
        gone = name.endswith(' (historical)')   # GNIS marks places that no longer exist this way
        if gone: name = name[:-len(' (historical)')]
        rows.append([name, k + (', gone' if gone else ''), round(float(r['PRIM_LAT_DEC']), 5), round(float(r['PRIM_LONG_DEC']), 5)])
rows.sort()
# [name, kind, lat, lng], one per line
open(out, 'w').write('[\n' + ',\n'.join(json.dumps(r) for r in rows) + '\n]\n')
print(len(rows), 'places')
