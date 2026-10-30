# Black Diamond Atlas

A map for finding what's left of Pennsylvania's old anthracite collieries ("black diamonds" was the old name for hard coal). A companion to
[Anthracite Collieries of Pennsylvania](https://theman42069.github.io/anthracite-collieries/), but a separate site.

## What it does

- **Views (chips on the map):** LIDAR bare-earth relief (2017–20), LIDAR + photo (the satellite photo shaded
  by the relief), leaf-off photos (2021–23), slope, satellite, or streets.
- **Time travel (bar at the bottom of the map):** a slider of older views laid over the ground view: the USGS topo sheets for wherever
  the map is (back to the 1880s), aerial photos from the 1980s, 1990s and 2004–2023, and the 2006–08 LIDAR.
  Show it faded, with a swipe line, or blinking; or press play to step through the years.
- **What changed?:** blinks the 2006–08 LIDAR over the 2017–20 one, so ground that was dug,
  filled or hauled away in between stands out.
- **This spot:** click anywhere for the coordinates, ground height, the PennPilot aerial photos of that spot
  from the 1930s–70s, and links to the same spot in Google Maps, Google Earth, Bing and USGS topoView.
- **Search:** collieries, towns, street addresses or coordinates.
- **On the map:** colliery pins and railroads: every line in OpenStreetMap (via OpenRailwayMap), in use,
  disused and abandoned, plus the collieries site's own lines and old spurs to the breakers. Click a
  thicker old line for its history: when it was built and abandoned, by which railroads, and the ICC filings.
- **Mine maps:** old mine maps of the Southern field, one coal seam at a time (Mammoth, Buck Mountain and
  about 28 more), laid over the map with a see-through slider.
- **Mine hazards:** the outline of every abandoned mine problem area (strip pits, banks, subsidence) plus shafts,
  openings and other point features from the state inventory, updated monthly; red dots shafts, blue dots slopes;
  amber other points; outlines red until reclaimed, then grey. Shown when zoomed in. Shafts and slopes get a
  30 m ring: checked against LIDAR pits, DEP's points sit a median 28 m from the real opening. Falls back to
  DCNR's copy of the points when PASDA is down.
- **Measure & notes:** a line's length and the ground profile along it; notes kept in the browser,
  downloadable as GeoJSON.

The view and layers are kept in the address bar, so a copied link opens the same spot.

Keys: `1`–`6` views, `T` time travel, `←` `→` years, `Space` play, `F` `S` `B` fade/swipe/blink,
`P` pins, `R` railroads, `/` search.

## Files

- `index.html` – the page
- `css/style.css` – styles
- `js/app.js` – the map and tools
- `data/rails-old.geojson` – about 1,500 old rail lines in the coal region, exported from OpenStreetMap (ODbL),
  86 of them with a line history (built/abandoned years, railroads, ICC abandonment filings) matched from
  Abandoned Rails by shape (`tools/ar_scrape.py` then `tools/ar_match.py data/rails-old.geojson`, with Scrapling;
  run them again after a re-export);
  re-export with an Overpass query for `railway=abandoned|disused|razed|dismantled` to refresh
- `serve.ps1` – preview on this computer: `powershell -ExecutionPolicy Bypass -File serve.ps1` (opens on http://localhost:8002)

No build step. Put the folder on any static host (for example its own GitHub Pages repository).
After changing `css/style.css` or `js/app.js`, raise the `?v=` number where `index.html` loads them,
so browsers fetch the new copy.

## Data sources

All imagery loads live from public servers; nothing is stored here.

- LIDAR, aerial photos (NHAP, USGS, NAIP, PAMAP, PEMA) and PennPilot photos: [PASDA](https://www.pasda.psu.edu/), Penn State
- Slope and ground heights: [USGS 3D Elevation Program](https://www.usgs.gov/3d-elevation-program)
- Topo sheets: USGS Historical Topographic Map Collection, served by Esri
- Mine maps: PA DEP, Southern Anthracite seam mosaics via PASDA
- Mine hazards: PA DEP Abandoned Mine Land inventory (monthly), via PASDA
- Satellite and place search: Esri
- Colliery pins and railroads: `data/collieries.geojson` and `data/railroads.geojson` from the
  Anthracite Collieries site (railroads from OpenStreetMap)
- More railroads: [OpenRailwayMap](https://www.openrailwaymap.org/) tiles (CC-BY-SA), data from OpenStreetMap
- Line histories: [Abandoned Rails](https://www.abandonedrails.com/) (facts and ICC filings, with a link to each line's page)
