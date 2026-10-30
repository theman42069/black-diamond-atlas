/* Black Diamond Atlas. A ground view (LIDAR, slope, satellite or streets) with an optional older view
   on top, chosen on a slider that runs from USGS topo sheets of the 1880s to aerial photos of the 2020s.
   Clicking the map shows that spot's height, old PennPilot photos and links; there's also a measuring
   line with a ground profile, and notes kept in this browser. The view is kept in the address, so a
   copied link reopens the same spot and layers. */
(function () {
  'use strict';

  // ---------- Configuration ----------

  var PASDA = 'https://imagery.pasda.psu.edu/arcgis/rest/services/';
  var ELEVATION = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/';
  var HIST_TOPO = 'https://historical1.arcgis.com/arcgis/rest/services/USA_Historical_Topo_Maps/ImageServer/';
  var PENNPILOT = PASDA + 'PennPilot/MapServer/';
  // Esri's world search finds towns as well as street addresses, and answers fast enough to suggest as you type.
  var GEOCODER = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/';
  // Colliery pins and railroads come live from the Anthracite Collieries site, so they stay in step with it.
  var COLLIERIES_SITE = 'https://theman42069.github.io/anthracite-collieries/';
  var NOTES_KEY = 'researchMap:notes';
  var UNITS_KEY = 'researchMap:units';
  var START = { lat: 40.79, lng: -76.56, zoom: 14 };   // Shamokin
  var PA_EXTENT = '-80.6,39.7,-74.6,42.3';
  var UNIT_CHOICES = {
    mi: { big: 'mi', bigM: 1609.34, small: 'ft', smallM: 0.3048 },
    km: { big: 'km', bigM: 1000, small: 'm', smallM: 1 }
  };
  var FIELD_COLORS = {
    'northern': '#f2b63c', 'eastern middle': '#4cc3d9', 'western middle': '#ef5b5b', 'southern': '#b28dff'
  };
  var MONTHS = ['Jan.', 'Feb.', 'March', 'April', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];

  // ---------- Small helpers ----------

  // localStorage can be blocked (private windows); the map still works, it just forgets.
  function readStore(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function writeStore(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* not kept */ }
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Same rule as the collieries site, so links to its pages match.
  function slugify(text) {
    return String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  // Lowercase, accents and punctuation removed, so "St. Nicholas" and "st nicholas" match.
  function plain(text) {
    return String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function $(id) { return document.getElementById(id); }

  function getJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    });
  }

  function pointParam(latlng) {
    return encodeURIComponent(JSON.stringify({ x: latlng.lng, y: latlng.lat, spatialReference: { wkid: 4326 } }));
  }

  var unitKey = UNIT_CHOICES[readStore(UNITS_KEY)] ? readStore(UNITS_KEY) : 'mi';
  var UNIT = UNIT_CHOICES[unitKey];

  function fmtHeight(m) {
    return UNIT.small === 'ft' ? Math.round(m / 0.3048).toLocaleString() + ' ft' : Math.round(m).toLocaleString() + ' m';
  }

  function fmtDistance(m) {
    var big = m / UNIT.bigM;
    return big >= 0.25 ? big.toFixed(2) + ' ' + UNIT.big : Math.round(m / UNIT.smallM).toLocaleString() + ' ' + UNIT.small;
  }

  // ---------- Layers ----------
  // Most of these are plain ArcGIS map images rather than tiles: the server draws each one on request,
  // and slows down sharply when asked for several at once. So these layers ask for ONE image covering
  // the view (plus a margin for panning) each time the map stops moving, and keep showing the old
  // image until the new one has arrived.

  // Leaflet throws if an image overlay is removed while a zoom is still running; ignore the late steps.
  ['_animateZoom', '_reset'].forEach(function (name) {
    var original = L.ImageOverlay.prototype[name];
    L.ImageOverlay.prototype[name] = function (e) { if (this._map) original.call(this, e); };
  });

  var prefetched = {};   // image addresses fetched ahead of time (the years either side of the one shown)

  var ViewImage = L.Layer.extend({
    options: { opacity: 1, attribution: null },

    initialize: function (url, extra, opts) {
      this._url = url;
      this._extra = extra;
      L.setOptions(this, opts);
    },

    getAttribution: function () { return this.options.attribution; },
    getEvents: function () { return { moveend: this._schedule, resize: this._schedule }; },

    onAdd: function () { this._update(); },

    onRemove: function () {
      clearTimeout(this._timer);
      this._drop('_pending');
      this._drop('_current');
      this._drop('_fading');
      this.fire('load');   // nothing left to wait for
    },

    setOpacity: function (o) {
      this.options.opacity = o;
      if (this._current) this._current.setOpacity(o);
      return this;
    },

    _drop: function (which) {
      var ov = this[which];
      if (!ov) return;
      ov.off();
      var img = ov.getElement();
      if (img && which === '_pending') img.src = '';   // stop a download that's no longer wanted
      if (this._map) this._map.removeLayer(ov);
      this[which] = null;
    },

    _schedule: function () {
      clearTimeout(this._timer);
      this._timer = setTimeout(this._update.bind(this), 120);
    },

    _update: function () {
      var map = this._map;
      if (!map) return;
      var v = this.view(map);
      if (this._current && this._current._url === v.sharp) return;
      // A quarter-size preview first when nothing usable is on screen (first load or a new zoom level),
      // unless the sharp image was already fetched ahead of time.
      var needPreview = (!this._current || this._current.zoom !== v.zoom) && !prefetched[v.sharp];
      this._load(needPreview ? v.preview : v.sharp, v.bounds, v.zoom, needPreview ? v.sharp : null);
    },

    // The image addresses for the current view: sharp (up to 2x on high-resolution screens) and a quarter-size preview.
    view: function (map) {
      var size = map.getSize(), zoom = map.getZoom();
      var px = map.getPixelBounds();
      var margin = L.point(Math.round(size.x * 0.2), Math.round(size.y * 0.2));
      var min = px.min.subtract(margin), max = px.max.add(margin);
      var nw = map.unproject(min, zoom), se = map.unproject(max, zoom);
      var a = L.CRS.EPSG3857.project(nw), b = L.CRS.EPSG3857.project(se);
      var self = this;
      function urlAt(ratio) {
        var w = Math.min(4096, Math.round((max.x - min.x) * ratio)), h = Math.min(4096, Math.round((max.y - min.y) * ratio));
        return self._url + '?bbox=' + [a.x, b.y, b.x, a.y].map(function (v) { return v.toFixed(1); }).join(',') +
          '&bboxSR=3857&imageSR=3857&size=' + w + ',' + h + '&f=image' + self._extra;
      }
      return {
        sharp: urlAt(Math.min(Math.max(window.devicePixelRatio || 1, 1), 2)), preview: urlAt(0.5),
        bounds: L.latLngBounds(nw, se), zoom: zoom
      };
    },

    _load: function (url, bounds, zoom, thenUrl) {
      var map = this._map;
      this._drop('_pending');
      var ov = L.imageOverlay(url, bounds, { pane: this.options.pane, opacity: 0, interactive: false });
      ov.zoom = zoom;
      this._pending = ov;
      this.fire('loading');
      ov.on('load', function () {
        if (this._pending !== ov) return;
        this._pending = null;
        ov.off();
        // The new image fades in (CSS) over the old one, which goes once the fade is done.
        this._drop('_fading');
        this._fading = this._current;
        this._current = ov.setOpacity(this.options.opacity);
        var self = this;
        setTimeout(function () { if (self._fading && self._fading !== self._current) self._drop('_fading'); }, 350);
        if (thenUrl) this._load(thenUrl, bounds, zoom, null);   // the preview is up; now the sharp one
        else this.fire('load');
      }, this);
      ov.on('error', function () {
        if (this._pending !== ov) return;
        // These servers drop the odd request under load; ask once more before giving up.
        if (!ov.retried) { ov.retried = true; setTimeout(function () { ov.setUrl(url + '&retry=1'); }, 600); return; }
        this._drop('_pending');
        this.fire('load');
      }, this);
      ov.addTo(map);
    }
  });

  function exportLayer(url, extra, opts) {
    return function (pane) {
      return watchLoading(new ViewImage(url, extra, L.extend({ pane: pane }, opts)));
    };
  }

  function tiles(url, opts) {
    return function (pane) { return watchLoading(L.tileLayer(url, L.extend({ pane: pane, maxZoom: 20, keepBuffer: 4 }, opts))); };
  }

  // "Loading…" shows on the map while any view is still being drawn.
  var loadingLayers = [];
  function watchLoading(layer) {
    function busy(on) {
      var i = loadingLayers.indexOf(layer);
      if (on && i < 0) loadingLayers.push(layer);
      if (!on && i >= 0) loadingLayers.splice(i, 1);
      $('loading').hidden = !loadingLayers.length;
    }
    return layer.on('loading', function () { busy(true); })
      .on('load remove', function () { busy(false); });
  }

  // The PEMA photos also come as ready-made tiles, which load much faster than drawn images.
  function pemaTiles(service) {
    return tiles(PASDA + service + '/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: 20, attribution: 'PEMA aerial photos via <a href="https://www.pasda.psu.edu/">PASDA</a>, Penn State'
    });
  }

  function pasdaPhotos(service, extra) {
    return exportLayer(PASDA + 'pasda/' + service + '/MapServer/export', '&format=jpg' + (extra || ''), {
      attribution: 'Aerial photos via <a href="https://www.pasda.psu.edu/">PASDA</a>, Penn State'
    });
  }

  var lidarMake = exportLayer(PASDA + 'pasda/USGS_Hillshade2017_2020/MapServer/export', '&format=jpg', {
    attribution: 'LIDAR: USGS 3DEP via <a href="https://www.pasda.psu.edu/">PASDA</a>'
  });
  var satelliteMake = tiles('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxNativeZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics'
  });

  // The ground view: one of these is always on the bottom.
  var GROUND = [
    { key: 'lidar', label: 'LIDAR', sub: '2017–2020',
      hint: 'Bare ground with the trees and buildings taken away. Culm banks, strip pits, rail beds and foundations show as sharp edges.',
      make: lidarMake },
    { key: 'fusion', label: 'LIDAR + photo', sub: 'today',
      hint: 'Today\'s satellite photo shaded by the LIDAR relief, so every bank, pit and rail bed stands out in 3D.',
      make: function (pane) { return L.layerGroup([satelliteMake(pane), lidarMake('blend')]); } },
    { key: 'leafoff', label: 'Leaf-off', sub: '2021–23',
      hint: 'Sharp aerial photos taken before the leaves came out, so the ground under the trees shows.',
      make: pemaTiles('PEMAImagery2021_2023cache') },
    { key: 'slope', label: 'Slope', sub: 'steep ground',
      hint: 'Steep ground in warm colors. The sides of banks, stripping cuts and fills stand out.',
      make: exportLayer(ELEVATION + 'exportImage', '&format=jpgpng&renderingRule=' +
        encodeURIComponent(JSON.stringify({ rasterFunction: 'Slope Map' })), {
        attribution: 'Slope: <a href="https://www.usgs.gov/3d-elevation-program">USGS 3DEP</a>'
      }) },
    { key: 'satellite', label: 'Satellite', sub: 'today',
      hint: 'Today\'s satellite photos.',
      make: satelliteMake },
    { key: 'streets', label: 'Streets', sub: 'today',
      hint: 'Today\'s roads and towns.',
      make: tiles('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxNativeZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }) }
  ];
  var GROUND_BY_KEY = {};
  GROUND.forEach(function (g) { GROUND_BY_KEY[g.key] = g; });

  // Older views with fixed dates. The topo sheets for wherever the map is are added to these.
  var FIXED_STOPS = [
    { key: 'nhap', year: 1983, label: '1980s', kind: 'photo', name: 'Aerial photos, infrared',
      hint: 'Living plants show red; bare culm and stripped ground grey or black.',
      make: exportLayer(PASDA + 'pasda/PA_NHAP80s/MapServer/export', '&format=jpg', {
        maxNativeZoom: 17, attribution: '1980s NHAP photos via <a href="https://www.pasda.psu.edu/">PASDA</a>'
      }) },
    { key: 'doqq', year: 1994, label: '1990s', kind: 'photo', name: 'Aerial photos',
      hint: 'Black-and-white USGS photos from about 1993–95, when many breakers were still standing.',
      make: pasdaPhotos('DOQQ', '&layers=show:0,1') },
    { key: 'naip2004', year: 2004, label: '2004', kind: 'photo', name: 'Aerial photos, infrared', make: pasdaPhotos('NAIP2004_WEB') },
    { key: 'lidar08', year: 2007, label: '2006–08', kind: 'lidar', name: 'LIDAR, first survey',
      hint: 'The first statewide LIDAR. Blink it over today\'s LIDAR to see ground that changed.',
      make: exportLayer(PASDA + 'pasda/PAMAP_Hillshade_WEB/MapServer/export', '&format=jpg', {
        attribution: 'LIDAR: PAMAP via <a href="https://www.pasda.psu.edu/">PASDA</a>'
      }) },
    { key: 'pamap', year: 2007.5, label: '2007–08', kind: 'photo', name: 'Aerial photos, leaf-off',
      hint: 'Taken before the leaves came out, so the ground under the trees shows.', make: pasdaPhotos('PAMAP_cycle2WEB') },
    { key: 'naip2008', year: 2008, label: '2008', kind: 'photo', name: 'Aerial photos', make: pasdaPhotos('NAIP2008_WEB') },
    { key: 'naip2010', year: 2010, label: '2010', kind: 'photo', name: 'Aerial photos', make: pasdaPhotos('NAIP2010WEB') },
    { key: 'naip2013', year: 2013, label: '2013', kind: 'photo', name: 'Aerial photos', make: pasdaPhotos('NAIP2013WEB') },
    { key: 'naip2015', year: 2015, label: '2015', kind: 'photo', name: 'Aerial photos', make: pasdaPhotos('NAIP2015WEB') },
    { key: 'naip2017', year: 2017, label: '2017', kind: 'photo', name: 'Aerial photos', make: pasdaPhotos('NAIP2017WEB') },
    { key: 'pema', year: 2018.5, label: '2018–20', kind: 'photo', name: 'Aerial photos, leaf-off',
      hint: 'Taken before the leaves came out, so the ground under the trees shows.', make: pemaTiles('PEMAImagery2018_2020cache') },
    { key: 'naip2019', year: 2019, label: '2019', kind: 'photo', name: 'Aerial photos', make: pasdaPhotos('NAIP2019WEB') },
    { key: 'naip2022', year: 2022, label: '2022', kind: 'photo', name: 'Aerial photos', make: pasdaPhotos('NAIP2022WEB') },
    { key: 'pema2', year: 2022.5, label: '2021–23', kind: 'photo', name: 'Aerial photos, leaf-off',
      hint: 'The newest leaf-off photos, sharp enough to pick out foundations and rail beds.', make: pemaTiles('PEMAImagery2021_2023cache') }
  ];

  // One historical USGS topo sheet, shown alone.
  function sheetStop(s) {
    var rule = encodeURIComponent(JSON.stringify({ mosaicMethod: 'esriMosaicLockRaster', lockRasterIds: [s.id] }));
    return {
      key: 'sheet' + s.id, year: s.year, label: String(s.year), kind: 'map',
      name: 'Topo map, ' + s.name + ' sheet',
      hint: s.year ? 'USGS ' + s.name + ' sheet, surveyed ' + s.year + ', printed ' + s.printed + ', scale 1:' + s.scale.toLocaleString() + '.' : '',
      make: exportLayer(HIST_TOPO + 'exportImage', '&format=jpgpng&mosaicRule=' + rule, {
        attribution: 'USGS Historical Topographic Map Collection via Esri'
      })
    };
  }

  // ---------- Map ----------

  var state = readHash();
  var map = L.map('map', { center: [state.lat, state.lng], zoom: state.zoom, minZoom: 7 });
  map.createPane('blend');
  map.getPane('blend').style.zIndex = 210;   // LIDAR multiplied into the photo below it (see the CSS)
  map.createPane('older');
  map.getPane('older').style.zIndex = 250;   // above the ground view, below lines and pins
  map.createPane('railsAll');
  map.getPane('railsAll').style.zIndex = 340;
  map.createPane('railsOld');
  map.getPane('railsOld').style.zIndex = 345;
  map.createPane('rails');
  map.getPane('rails').style.zIndex = 350;

  var scale = null;
  function setUnits(key) {
    unitKey = key;
    UNIT = UNIT_CHOICES[key];
    writeStore(UNITS_KEY, key);
    Array.prototype.forEach.call(document.querySelectorAll('#units button'), function (b) {
      b.setAttribute('aria-checked', String(b.dataset.units === key));
    });
    if (scale) map.removeControl(scale);
    scale = L.control.scale({ imperial: key === 'mi', metric: key === 'km' }).addTo(map);
    if (spotAt) showSpot(spotAt, true);
    if (route.length >= 2) {
      $('measure-total').textContent = 'Length: ' + fmtDistance(routeLength());
      loadProfile();
    }
  }
  $('units').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-units]');
    if (b) setUnits(b.dataset.units);
  });

  // ---------- Tabs ----------

  var TABS = ['spot', 'tools'];
  function showTab(name, focus) {
    TABS.forEach(function (t) {
      var on = t === name;
      $('tab-' + t).setAttribute('aria-selected', String(on));
      $('tab-' + t).tabIndex = on ? 0 : -1;
      $('pane-' + t).hidden = !on;
    });
    document.querySelector('.side').scrollTop = 0;
    if (focus) $('tab-' + name).focus();
  }
  document.querySelector('.tabs').addEventListener('click', function (e) {
    var b = e.target.closest('[role="tab"]');
    if (b) showTab(b.id.replace('tab-', ''));
  });
  document.querySelector('.tabs').addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    var i = TABS.indexOf(document.activeElement.id.replace('tab-', ''));
    if (i < 0) return;
    showTab(TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length], true);
  });

  // ---------- Ground view ----------

  var groundLayer = null;
  $('ground').innerHTML = GROUND.map(function (g, i) {
    return '<button type="button" class="chip" role="radio" data-key="' + g.key + '" aria-checked="false" title="' +
      escapeHtml(g.hint) + ' (' + (i + 1) + ')">' + g.label + '</button>';
  }).join('');

  function setGround(key) {
    var g = GROUND_BY_KEY[key] || GROUND[0];
    if (groundLayer) map.removeLayer(groundLayer);
    groundLayer = g.make('tilePane').addTo(map);
    state.ground = g.key;
    Array.prototype.forEach.call($('ground').children, function (b) {
      b.setAttribute('aria-checked', String(b.dataset.key === g.key));
    });
    updateBadge();
    writeHash();
  }
  $('ground').addEventListener('click', function (e) {
    var b = e.target.closest('.chip');
    if (b) setGround(b.dataset.key);
  });

  // ---------- Through time ----------

  var stops = FIXED_STOPS.slice();
  var stopIndex = -1;
  var olderLayer = null;
  var leavingLayer = null;   // the year being replaced, kept until the new one has loaded
  var timeOn = false;
  var mode = 'fade';
  var sheetsFor = null;        // where the topo sheet list was last fetched
  var sheetsReq = 0;
  var pendingKey = state.older;   // a stop named in the address, chosen once the sheets arrive
  var slider = $('time-slider');
  var opacity = $('opacity');
  opacity.value = state.opacity;

  function stopByKey(key) {
    for (var i = 0; i < stops.length; i++) if (stops[i].key === key) return i;
    return -1;
  }

  function renderTicks() {
    slider.max = stops.length - 1;
    $('time-ticks').innerHTML = stops.map(function (s, i) {
      return '<i class="' + s.kind + '" style="left:' + (stops.length > 1 ? i / (stops.length - 1) * 100 : 0) + '%"></i>';
    }).join('');
  }

  function setStop(i) {
    i = Math.max(0, Math.min(stops.length - 1, i));
    var s = stops[i];
    stopIndex = i;
    slider.value = i;
    // The previous year stays up until the new one has loaded, so the map never goes blank between years.
    if (leavingLayer) map.removeLayer(leavingLayer);
    leavingLayer = olderLayer;
    olderLayer = s.make('older').addTo(map);
    var arriving = olderLayer;
    olderLayer.once('load', function () {
      // Let the new year fade in over the old one first.
      setTimeout(function () {
        if (leavingLayer && olderLayer === arriving) { map.removeLayer(leavingLayer); leavingLayer = null; }
      }, 350);
      prefetchAround(i);
    });
    applyMode();
    $('time-year').textContent = s.label;
    $('time-name').textContent = s.name;
    $('time-hint').textContent = s.hint || '';
    $('time-prev').disabled = i === 0;
    $('time-next').disabled = i === stops.length - 1;
    state.older = s.key;
    updateBadge();
    writeHash();
    return olderLayer;
  }

  // Fetch the years either side of this one for the current view, so stepping to them is instant.
  function prefetchAround(i) {
    [i - 1, i + 1].forEach(function (j) {
      var s = stops[j];
      if (!s || !timeOn) return;
      var layer = s.make('older');
      if (!layer.view) return;   // ready-made tiles are quick already
      var url = layer.view(map).sharp;
      if (prefetched[url]) return;
      prefetched[url] = true;
      new Image().src = url;
    });
  }

  function setTime(on) {
    timeOn = on;
    $('time-on').checked = on;
    $('time-body').hidden = !on;
    $('time-card').classList.toggle('open', on);
    if (!on) {
      stopPlay();
      if (olderLayer) map.removeLayer(olderLayer);
      if (leavingLayer) map.removeLayer(leavingLayer);
      olderLayer = leavingLayer = null;
      stopIndex = -1;
      state.older = '';
      applyMode();
      updateBadge();
      writeHash();
      return;
    }
    renderTicks();
    var i = stopByKey(pendingKey || state.older);
    if (i >= 0) setStop(i);
    else if (stops[0].kind === 'map' && !userChose) setStop(0);   // this area's sheets are already known
    else if (userChose && state.older) setStop(stopByKey('doqq'));
    else { $('time-year').textContent = '…'; $('time-name').textContent = 'Finding old maps'; }
    loadSheets(true);
  }
  $('time-on').addEventListener('change', function (e) { setTime(e.target.checked); });
  var userChose = false;   // once a year is picked by hand, moving the map keeps to it
  function pick(i) { stopPlay(); pendingKey = null; userChose = true; setStop(i); }
  // While the slider is being dragged only the label follows; the map loads once it settles on a year.
  var slideTimer = null;
  slider.addEventListener('input', function () {
    var s = stops[+slider.value];
    $('time-year').textContent = s.label;
    $('time-name').textContent = s.name;
    clearTimeout(slideTimer);
    slideTimer = setTimeout(function () { pick(+slider.value); }, 200);
  });
  $('time-prev').addEventListener('click', function () { pick(stopIndex - 1); });
  $('time-next').addEventListener('click', function () { pick(stopIndex + 1); });

  // Topo sheets covering the middle of the map. One per survey year: the most detailed, earliest printing.
  function loadSheets(first) {
    var c = map.getCenter();
    if (sheetsFor && map.distance(sheetsFor, c) < 3000) return;
    sheetsFor = c;
    var req = ++sheetsReq;
    if (first) $('time-hint').textContent = 'Finding the old topo maps for this area…';
    getJson(HIST_TOPO + 'query?geometryType=esriGeometryPoint&spatialRel=esriSpatialRelIntersects&returnGeometry=false&f=json' +
      '&outFields=OBJECTID,Map_Name,Date_On_Map,Map_Scale,Imprint_Year&geometry=' + pointParam(c)).then(function (d) {
      if (req !== sheetsReq) return;
      var byYear = {};
      (d.features || []).forEach(function (f) {
        var a = f.attributes;
        if (!a.Date_On_Map || a.Map_Scale > 125000) return;
        var s = { id: a.OBJECTID, name: a.Map_Name, year: a.Date_On_Map, printed: a.Imprint_Year, scale: a.Map_Scale };
        var best = byYear[s.year];
        if (!best || s.scale < best.scale || (s.scale === best.scale && s.printed < best.printed)) byYear[s.year] = s;
      });
      var current = stops[stopIndex] && stops[stopIndex].key;
      var currentYear = stops[stopIndex] && stops[stopIndex].year;
      stops = Object.keys(byYear).map(function (y) { return sheetStop(byYear[y]); }).concat(FIXED_STOPS)
        .sort(function (a, b) { return a.year - b.year; });
      renderTicks();
      if (!timeOn) return;
      // Keep the same view if it's still here; a sheet from elsewhere becomes this area's sheet nearest its year.
      var keep = first && !pendingKey && !userChose ? 0 : stopByKey(pendingKey || current);   // first time: the oldest map
      if (keep < 0) {
        keep = 0;
        stops.forEach(function (s, i) { if (Math.abs(s.year - currentYear) < Math.abs(stops[keep].year - currentYear)) keep = i; });
      }
      pendingKey = null;
      if (keep !== stopIndex || stops[keep].key !== current) setStop(keep);
      else { slider.value = keep; $('time-prev').disabled = keep === 0; $('time-next').disabled = keep === stops.length - 1; }
      if (first) $('time-hint').textContent = stops[stopIndex].hint || '';
    }).catch(function () {
      if (req !== sheetsReq) return;
      sheetsFor = null;
      if (timeOn && stopIndex < 0) setStop(stopByKey('doqq'));
      if (first) $('time-hint').textContent = 'The old topo maps could not load; the photos still work.';
    });
  }
  map.on('moveend', function () { if (timeOn) loadSheets(false); });

  // Fade, swipe or blink.
  var blinkTimer = null, blinkShowing = true;

  document.querySelector('#time-body .seg').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-mode]');
    if (b) setMode(b.dataset.mode);
  });

  function setMode(m) {
    mode = m;
    state.mode = m;
    Array.prototype.forEach.call(document.querySelectorAll('#time-body .seg button'), function (b) {
      b.setAttribute('aria-checked', String(b.dataset.mode === m));
    });
    opacity.hidden = m !== 'fade';
    applyMode();
    writeHash();
  }

  function applyMode() {
    clearInterval(blinkTimer);
    blinkTimer = null;
    blinkShowing = true;
    if (olderLayer) olderLayer.setOpacity(mode === 'fade' ? opacity.value / 100 : 1);
    if (olderLayer && mode === 'blink') {
      blinkTimer = setInterval(function () {
        blinkShowing = !blinkShowing;
        olderLayer.setOpacity(blinkShowing ? 1 : 0);
        updateBadge();
      }, 900);
    }
    clipOlder();
    updateBadge();
  }

  opacity.addEventListener('input', function () {
    if (olderLayer && mode === 'fade') olderLayer.setOpacity(opacity.value / 100);
    state.opacity = +opacity.value;
    writeHash();
  });

  // The year label says what's on screen; while blinking it flips to "Now" with the map.
  function updateBadge() {
    var s = timeOn && stops[stopIndex];
    if (!s) return;
    var now = mode === 'blink' && !blinkShowing, g = GROUND_BY_KEY[state.ground];
    $('time-year').textContent = now ? 'Now' : s.label;
    $('time-name').textContent = now ? g.label + ', ' + g.sub : s.name + (mode === 'swipe' ? ' ◂ | ▸ ' + g.label : '');
    $('time-year').parentNode.classList.toggle('now', now);
  }

  // Swipe: the older view is clipped at a line you drag; older on the left, ground view on the right.
  var swipeX = 0, swipeBar = null;

  function clipOlder() {
    var pane = map.getPane('older');
    if (mode !== 'swipe' || !olderLayer) {
      pane.style.clip = '';
      if (swipeBar) { swipeBar.remove(); swipeBar = null; }
      return;
    }
    if (!swipeBar) makeSwipeBar();
    var nw = map.containerPointToLayerPoint([0, 0]);
    var se = map.containerPointToLayerPoint(map.getSize());
    pane.style.clip = 'rect(' + nw.y + 'px,' + (nw.x + swipeX) + 'px,' + se.y + 'px,' + nw.x + 'px)';
    swipeBar.style.left = swipeX + 'px';
  }

  function makeSwipeBar() {
    swipeX = Math.round(map.getSize().x / 2);
    swipeBar = L.DomUtil.create('div', 'swipe', map.getContainer());
    swipeBar.innerHTML = '<div class="swipe-line"></div>' +
      '<button type="button" class="swipe-handle" aria-label="Drag to compare the older view with the ground view">&#8249;&#8250;</button>';
    L.DomEvent.disableClickPropagation(swipeBar);
    var handle = swipeBar.querySelector('.swipe-handle');
    function drag(e) {
      var r = map.getContainer().getBoundingClientRect();
      swipeX = Math.max(0, Math.min(r.width, e.clientX - r.left));
      clipOlder();
    }
    handle.addEventListener('pointerdown', function (e) {
      handle.setPointerCapture(e.pointerId);
      map.dragging.disable();
      handle.addEventListener('pointermove', drag);
    });
    handle.addEventListener('pointerup', function () {
      handle.removeEventListener('pointermove', drag);
      map.dragging.enable();
    });
    handle.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      swipeX = Math.max(0, Math.min(map.getSize().x, swipeX + (e.key === 'ArrowLeft' ? -30 : 30)));
      clipOlder();
    });
  }
  map.on('move zoom resize', clipOlder);

  // Play: step through the years, waiting for each view to load before moving on.
  var playing = false, playTimer = null;

  function stopPlay() {
    playing = false;
    clearTimeout(playTimer);
    $('time-play').setAttribute('aria-pressed', 'false');
    $('time-play').innerHTML = '&#9654;';
    $('time-play').setAttribute('aria-label', 'Play through the years');
  }

  function playStep() {
    if (!playing) return;
    if (stopIndex >= stops.length - 1) { stopPlay(); return; }
    var layer = setStop(stopIndex + 1);
    var next = function () { clearTimeout(playTimer); playTimer = setTimeout(playStep, 1300); };
    layer.once('load', next);
    playTimer = setTimeout(playStep, 6000);   // don't wait forever on a slow server
  }

  $('time-play').addEventListener('click', function () {
    if (playing) { stopPlay(); return; }
    playing = true;
    $('time-play').setAttribute('aria-pressed', 'true');
    $('time-play').innerHTML = '&#10074;&#10074;';
    $('time-play').setAttribute('aria-label', 'Pause');
    if (mode === 'blink') setMode('fade');
    if (stopIndex >= stops.length - 1) setStop(0);
    playTimer = setTimeout(playStep, 800);
  });

  $('lidar-change').addEventListener('click', function () {
    setGround('lidar');
    pendingKey = 'lidar08';
    if (!timeOn) setTime(true);
    else { pendingKey = null; setStop(stopByKey('lidar08')); }
    setMode('blink');
  });

  // ---------- Address (hash) ----------
  // #zoom/lat/lng/ground/older/opacity/mode

  function readHash() {
    var p = location.hash.replace(/^#/, '').split('/');
    var s = { zoom: +p[0], lat: +p[1], lng: +p[2], ground: p[3] || 'lidar', older: p[4] || '',
      opacity: +p[5] || 75, mode: /^(fade|swipe|blink)$/.test(p[6]) ? p[6] : 'fade' };
    if (!isFinite(s.zoom) || !isFinite(s.lat) || !isFinite(s.lng) || !p[2]) {
      s.lat = START.lat; s.lng = START.lng; s.zoom = START.zoom;
    }
    return s;
  }

  var hashTimer = null;
  function writeHash() {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(function () {
      var c = map.getCenter();
      history.replaceState(null, '', '#' + [map.getZoom(), c.lat.toFixed(5), c.lng.toFixed(5),
        state.ground, timeOn ? state.older : '', state.opacity, state.mode].join('/'));
    }, 200);
  }
  map.on('moveend', writeHash);

  // ---------- Pins, railroads, place names ----------

  var pins = L.layerGroup().addTo(map);
  var sites = [];
  getJson(COLLIERIES_SITE + 'data/collieries.geojson').then(function (d) {
    d.features.forEach(function (f) {
      if (!f.geometry || f.geometry.type !== 'Point') return;
      var p = f.properties, ll = L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]);
      var slug = p.id ? slugify(p.id) : slugify(p.name);
      sites.push({ name: p.name, latlng: ll, plain: plain(p.name) });
      L.circleMarker(ll, {
        radius: 7, color: '#16181b', weight: 2, fillOpacity: 0.95, bubblingMouseEvents: false,
        fillColor: FIELD_COLORS[String(p.field || '').toLowerCase()] || '#9aa0a6'
      }).bindTooltip(escapeHtml(p.name), { className: 'map-tip', direction: 'top', offset: [0, -6] })
        .bindPopup('<b>' + escapeHtml(p.name) + '</b><br><a href="' + COLLIERIES_SITE + '#' + encodeURIComponent(slug) +
          '" target="_blank" rel="noopener">Photos, history and sources ↗</a>')
        .on('click', function () { showSpot(ll); })
        .addTo(pins);
    });
  }).catch(function () { /* pins are a nice-to-have here */ });

  $('show-pins').addEventListener('change', function (e) {
    if (e.target.checked) pins.addTo(map); else map.removeLayer(pins);
  });

  // Every railway in OpenStreetMap (in use, disused and abandoned), drawn under the colliery site's own
  // lines so those keep their pop-up details.
  var rails = L.layerGroup([L.tileLayer('https://{s}.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png', {
    pane: 'railsAll', subdomains: 'abc', maxZoom: 20, maxNativeZoom: 19, keepBuffer: 4,
    attribution: 'Railways: <a href="https://www.openrailwaymap.org/">OpenRailwayMap</a> (CC-BY-SA), data &copy; OpenStreetMap contributors'
  })]);
  var railsLoaded = false;
  rails.on('add', function () {
    if (railsLoaded) return;
    railsLoaded = true;
    getJson(COLLIERIES_SITE + 'data/railroads.geojson').then(function (d) {
      L.geoJSON(d, {
        pane: 'rails',
        attribution: 'Railroads &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        style: function (f) {
          var s = f.properties.status;
          return s === 'active' ? { color: '#f4efe6', weight: 2.5, opacity: 0.9 }
            : s === 'spur' ? { color: '#5fd38d', weight: 3, opacity: 0.95, dashArray: '2 6', lineCap: 'round' }
            : { color: '#e9a23b', weight: 2.5, opacity: 0.95, dashArray: '6 5' };
        },
        onEachFeature: function (f, layer) {
          var p = f.properties;
          layer.bindTooltip('<b>' + escapeHtml(p.name || (p.status === 'active' ? 'Railroad' : 'Abandoned railroad')) + '</b>' +
            '<br>' + (p.status === 'active' ? 'Track still in use' : p.status === 'spur' ? 'Gone; shown on old maps' : 'Abandoned or removed') +
            (p.note ? '<br>' + escapeHtml(p.note) : ''), { sticky: true, className: 'map-tip' });
        }
      }).addTo(rails);
    }).catch(function () { railsLoaded = false; });

    // About 2,800 old lines (abandoned, disused, torn up) from OpenStreetMap, saved with this site
    // (see data/rails-old.geojson). Drawn on a canvas, which stays quick with this many lines.
    // Some carry a line history (d.history[p.ar]): years, railroads and ICC abandonment filings from Abandoned Rails.
    getJson('data/rails-old.geojson').then(function (d) {
      var STATUS = { abandoned: 'Abandoned', disused: 'Disused, track may remain', razed: 'Torn up' };
      var history = d.history || [];
      L.geoJSON(d, {
        pane: 'railsOld',
        renderer: L.canvas({ pane: 'railsOld', tolerance: 6 }),
        attribution: 'Old railroads &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL); ' +
          'line histories <a href="https://www.abandonedrails.com/">Abandoned Rails</a>',
        style: function (f) {
          var s = f.properties.status;
          var st = s === 'disused' ? { color: '#9fd8e0', weight: 2.5, opacity: 0.9, dashArray: '8 4' }
            : s === 'razed' ? { color: '#f4a261', weight: 3, opacity: 0.95, dashArray: '1 6', lineCap: 'round' }
            : { color: '#f4a261', weight: 2.5, opacity: 0.9, dashArray: '5 5' };
          if (f.properties.ar !== undefined) { st.weight += 1; st.bubblingMouseEvents = false; } // has a history: click opens it
          return st;
        },
        onEachFeature: function (f, layer) {
          var p = f.properties, h = history[p.ar];
          var last = h && h.filings && h.filings[h.filings.length - 1];
          var gone = h && (h.abandoned || (last && last.date && last.date.slice(-4)));
          var years = h ? [h.built && 'built ' + h.built, gone && 'abandoned ' + gone].filter(Boolean).join(', ') : '';
          layer.bindTooltip('<b>' + escapeHtml(p.name || (h && h.title) || 'Old railroad') + '</b>' +
            (p.railroad ? '<br>' + escapeHtml(p.railroad) : '') +
            '<br>' + (STATUS[p.status] || 'Abandoned') + (p.kind ? ' · ' + escapeHtml(p.kind) : '') +
            (h ? '<br>' + escapeHtml(h.title) + (years ? ', ' + years : '') + '<br><small>Click for its history</small>' : ''),
            { sticky: true, className: 'map-tip' });
          if (h) layer.bindPopup(railHistory(h), { maxWidth: 340, className: 'rail-history' });
        }
      }).addTo(rails);
    }).catch(function () { /* the other rail layers still show */ });

    // Lines missing from OpenStreetMap, traced by hand from old USGS topo sheets (data/rails-traced.geojson).
    getJson('data/rails-traced.geojson').then(function (d) {
      L.geoJSON(d, {
        pane: 'railsOld',
        attribution: 'Traced rails: USGS topographic maps',
        style: { color: '#c9a7ff', weight: 3, opacity: 0.95, dashArray: '6 4' },
        onEachFeature: function (f, layer) {
          var p = f.properties;
          layer.bindTooltip('<b>' + escapeHtml(p.name) + '</b><br>Gone; traced from the ' + escapeHtml(p.source) +
            '<br><small>Position ' + escapeHtml(p.accuracy) + '</small>', { sticky: true, className: 'map-tip' });
        }
      }).addTo(rails);
    }).catch(function () { /* the other rail layers still show */ });
  });
  function railHistory(h) {
    return '<b>' + escapeHtml(h.title) + '</b>' +
      (h.railroads ? '<br><small>' + h.railroads.map(escapeHtml).join(' · ') + '</small>' : '') +
      (h.built || h.abandoned ? '<p>' + [h.built && 'Built ' + h.built, h.abandoned && 'abandoned ' + h.abandoned].filter(Boolean).join(', ') + '</p>' : '') +
      (h.filings || []).map(function (f) {
        return '<p><b>ICC filing ' + escapeHtml(f.date || '') + '</b>' + (f.docket ? ', docket ' + escapeHtml(f.docket) : '') +
          (f.miles ? ', ' + escapeHtml(f.miles) + ' mi' : '') + (f.text ? '<br><small>' + escapeHtml(f.text) + '</small>' : '') + '</p>';
      }).join('') +
      '<a href="' + escapeHtml(h.url) + '" target="_blank" rel="noopener">Photos and more on Abandoned Rails ↗</a>';
  }

  $('show-rails').addEventListener('change', function (e) {
    if (e.target.checked) rails.addTo(map); else map.removeLayer(rails);
  });

  var placeLabels = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 20, maxNativeZoom: 19, pane: 'overlayPane', attribution: 'Labels &copy; Esri' });
  $('show-labels').addEventListener('change', function (e) {
    if (e.target.checked) placeLabels.addTo(map); else map.removeLayer(placeLabels);
  });

  // ---------- Mining records ----------
  // Old mine maps of the Southern field, one mosaic per coal seam (PASDA). The seam list comes from the
  // service: each seam, and its "Overlap"/"Underlap" extra sheets, has an "Image" sublayer.
  var MINE_MAPS = PASDA + 'Mosaics/MapServices_SouthernAnthracite/MapServer';
  var seamIds = {}, seamLayer = null;
  map.createPane('mines');
  map.getPane('mines').style.zIndex = 255;   // over the older view, under rails and pins

  getJson(MINE_MAPS + '?f=json').then(function (d) {
    var byId = {};
    d.layers.forEach(function (l) { byId[l.id] = l; });
    d.layers.forEach(function (l) {
      var parent = byId[l.parentLayerId];
      if (l.name !== 'Image' || !parent) return;
      var seam = parent.name.replace(/ (Overlap|Underlap)$/, '');
      (seamIds[seam] = seamIds[seam] || []).push(l.id);
    });
    // Listed as the service lists them: top of the coal measures down to the Lykens Valley seams.
    $('mine-seam').innerHTML = '<option value="">Off</option>' + Object.keys(seamIds).map(function (s) {
      return '<option>' + escapeHtml(s) + '</option>';
    }).join('');
  }).catch(function () { $('mine-seam').innerHTML = '<option value="">Not available</option>'; });

  $('mine-seam').addEventListener('change', function (e) {
    if (seamLayer) map.removeLayer(seamLayer);
    seamLayer = null;
    var ids = seamIds[e.target.value];
    $('mine-opacity').hidden = !ids;
    if (!ids) return;
    seamLayer = exportLayer(MINE_MAPS + '/export', '&format=png32&transparent=true&layers=show:' + ids.join(','), {
      attribution: 'Mine maps: PA DEP via <a href="https://www.pasda.psu.edu/">PASDA</a>'
    })('mines').addTo(map);
    seamLayer.setOpacity($('mine-opacity').value / 100);
  });
  $('mine-opacity').addEventListener('input', function (e) { if (seamLayer) seamLayer.setOpacity(e.target.value / 100); });

  // Abandoned mine hazards: PA DEP's Abandoned Mine Land inventory as published monthly on PASDA.
  // Layer 1 is the outline of each problem area (strip pits, banks, subsidence), layer 0 the point features
  // (shafts, openings, fires). Fetched for the view when zoomed in, every page, so nothing is left out.
  // When PASDA is down, the points alone come from DCNR's copy of the inventory (same positions, no outlines).
  var AML = 'https://mapservices.pasda.psu.edu/server/rest/services/pasda/DEP/MapServer/';
  var AML_BACKUP = 'https://conservationexplorer.dcnr.pa.gov/arcgis/rest/services/PA_Public/AML_Points/MapServer/0';
  var hazards = L.layerGroup();
  var hazardReq = 0;

  function fetchAll(layerUrl, bbox, offset, got) {
    return getJson(layerUrl + '/query?where=1%3D1&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326' +
      '&returnGeometry=true&f=geojson&orderByFields=OBJECTID&resultRecordCount=1000&resultOffset=' + offset +
      '&outFields=*&geometry=' + bbox).then(function (d) {
      if (!d.features) throw new Error('no features');
      d.features.forEach(function (f) { // DCNR spells the fields in capitals
        var p = {};
        Object.keys(f.properties).forEach(function (k) { p[k.toLowerCase()] = f.properties[k]; });
        f.properties = p;
      });
      got = got.concat(d.features);
      return d.features.length === 1000 ? fetchAll(layerUrl, bbox, offset + 1000, got) : got;
    });
  }

  function hazardTip(p) {
    var problem = String(p.sf_probl_1 || p.sf_type || 'Mine hazard').replace(/^\d+\s+/, '');
    var size = [p.height_ft ? p.height_ft + ' ft high' : '', p.volume_cy ? p.volume_cy.toLocaleString() + ' cu yd' : '',
      p.flow_gpm ? p.flow_gpm + ' gal/min' : ''].filter(Boolean).join(', ');
    return '<b>' + escapeHtml(problem) + '</b>' +
      '<br>' + escapeHtml(p.sf_type || '') + (p.sf_status ? ' · ' + escapeHtml(p.sf_status) : '') +
      (p.sf_prior_1 ? '<br>' + escapeHtml(p.sf_prior_1) : '') + (size ? '<br>' + escapeHtml(size) : '') +
      (p.sf_name ? '<br><small>Site ' + escapeHtml(p.sf_name) + '</small>' : '');
  }

  function loadHazards() {
    if (!map.hasLayer(hazards)) return;
    if (map.getZoom() < 12) {
      hazards.clearLayers();
      $('hazard-label').textContent = 'Mine hazards (zoom in)';
      return;
    }
    var b = map.getBounds(), req = ++hazardReq;
    var bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map(function (v) { return v.toFixed(5); }).join(',');
    Promise.race([
      Promise.all([fetchAll(AML + 1, bbox, 0, []), fetchAll(AML + 0, bbox, 0, [])]),
      new Promise(function (_, reject) { setTimeout(reject, 6000); }) // a stuck PASDA can hang 20s before failing
    ]).catch(function () {
      return fetchAll(AML_BACKUP, bbox, 0, []).then(function (pts) { return [[], pts]; });
    }).then(function (r) {
      if (req !== hazardReq) return;
      hazards.clearLayers();
      var color = function (p) { return /complete/i.test(p.sf_status || '') ? '#9aa0a6' : '#e5484d'; };
      L.geoJSON({ type: 'FeatureCollection', features: r[0].concat(r[1]) }, {
        style: function (f) {
          if (f.geometry.type === 'Point') return {}; // dots are styled in pointToLayer
          var c = color(f.properties);
          return { color: c, weight: 2, fillColor: c, fillOpacity: 0.18, bubblingMouseEvents: false };
        },
        // Points by kind: shafts red, slopes blue, anything else amber; reclaimed ones faded.
        pointToLayer: function (f, ll) {
          var p = f.properties, kind = p.sf_probl_1 || '';
          return L.circleMarker(ll, {
            radius: 6, weight: 2, color: '#16181b', bubblingMouseEvents: false,
            fillOpacity: /complete/i.test(p.sf_status || '') ? 0.35 : 0.95,
            fillColor: /shaft/i.test(kind) ? '#e5484d' : /slope/i.test(kind) ? '#3b82f6' : '#f5a524'
          });
        },
        onEachFeature: function (f, layer) {
          var tip = hazardTip(f.properties);
          // Checked against LIDAR pits, DEP's shaft and slope points sit a median 28 m from the real opening,
          // scattered in every direction (no shift to correct). The ring shows where to look.
          if (f.geometry.type === 'Point' && /shaft|slope/i.test(f.properties.sf_probl_1 || '')) {
            L.circle(layer.getLatLng(), {
              radius: 30, weight: 1.5, dashArray: '4 4', fill: false, interactive: false,
              color: /shaft/i.test(f.properties.sf_probl_1) ? '#e5484d' : '#3b82f6'
            }).addTo(hazards);
            tip += '<br><small>Recorded position, usually within 30 m (ring). Look for the pit in the LIDAR view.</small>';
          }
          layer.bindTooltip(tip, { className: 'map-tip', direction: 'top', sticky: f.geometry.type !== 'Point' });
        }
      }).addTo(hazards);
      $('hazard-label').textContent = 'Mine hazards (' + (r[0].length + r[1].length) + ')';
    }).catch(function () { if (req === hazardReq) $('hazard-label').textContent = 'Mine hazards (not loading)'; });
  }

  map.on('moveend', loadHazards);
  $('show-hazards').addEventListener('change', function (e) {
    if (e.target.checked) { hazards.addTo(map); loadHazards(); }
    else { map.removeLayer(hazards); $('hazard-label').textContent = 'Mine hazards'; }
  });

  // ---------- Search: collieries, coordinates, then addresses and towns ----------

  var searchInput = $('search');
  var resultsBox = $('search-results');
  var results = [];
  var activeResult = -1;
  var searchTimer = null, searchReq = 0;

  function parseCoords(q) {
    var m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(q);
    if (!m) return null;
    var lat = +m[1], lng = +m[2];
    if (lng > 0 && lng < 90 && lat > 0) lng = -lng;   // Pennsylvania: people often leave off the minus
    return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? L.latLng(lat, lng) : null;
  }

  function renderResults(message) {
    resultsBox.innerHTML = results.length ? results.map(function (r, i) {
      return '<li role="option" id="result-' + i + '" aria-selected="' + (i === activeResult) + '">' +
        escapeHtml(r.text) + '<small>' + r.kind + '</small></li>';
    }).join('') : (message ? '<li class="none">' + escapeHtml(message) + '</li>' : '');
    var open = !!(results.length || message);
    resultsBox.hidden = !open;
    searchInput.setAttribute('aria-expanded', String(open));
    if (activeResult >= 0) searchInput.setAttribute('aria-activedescendant', 'result-' + activeResult);
    else searchInput.removeAttribute('aria-activedescendant');
  }

  function closeResults() {
    results = [];
    activeResult = -1;
    renderResults();
  }

  function runSearch() {
    var q = searchInput.value.trim();
    var req = ++searchReq;
    results = [];
    activeResult = -1;
    if (q.length < 2) { renderResults(); return; }
    var ll = parseCoords(q);
    if (ll) results.push({ text: ll.lat.toFixed(5) + ', ' + ll.lng.toFixed(5), kind: 'Coordinates', latlng: ll });
    var want = plain(q);
    sites.filter(function (s) { return s.plain.indexOf(want) !== -1; })
      .sort(function (a, b) { return a.plain.indexOf(want) - b.plain.indexOf(want) || a.name.localeCompare(b.name); })
      .slice(0, 6).forEach(function (s) { results.push({ text: s.name, kind: 'Colliery', latlng: s.latlng, zoom: 16 }); });
    renderResults(ll ? '' : 'Searching…');
    if (ll) return;
    getJson(GEOCODER + 'suggest?f=json&maxSuggestions=5&searchExtent=' + PA_EXTENT + '&location=-76.4,40.8&text=' + encodeURIComponent(q))
      .then(function (d) {
        if (req !== searchReq) return;
        (d.suggestions || []).forEach(function (s) {
          results.push({ text: s.text, kind: 'Place', magicKey: s.magicKey });
        });
        renderResults('Nothing found. Try a colliery name, a town, or coordinates like 40.789, -76.558.');
      }).catch(function () {
        if (req === searchReq) renderResults(results.length ? '' : 'The address search isn\'t answering right now.');
      });
  }

  function chooseResult(r) {
    closeResults();
    searchInput.value = r.text;
    searchInput.blur();
    if (r.latlng) { goTo(r.latlng, r.zoom || 17); return; }
    getJson(GEOCODER + 'findAddressCandidates?f=json&outSR=4326&maxLocations=1&magicKey=' + encodeURIComponent(r.magicKey) +
      '&SingleLine=' + encodeURIComponent(r.text)).then(function (d) {
      var c = d.candidates && d.candidates[0];
      if (!c) throw new Error('none');
      var ll = L.latLng(c.location.y, c.location.x);
      // The result's own extent fits it: close in on an address, wider for a town.
      var e = c.extent;
      var zoom = e ? Math.max(13, map.getBoundsZoom([[e.ymin, e.xmin], [e.ymax, e.xmax]])) : 16;
      map.setView(ll, Math.min(zoom, 18));
      showSpot(ll);
    }).catch(function () { renderResults('That place could not be found.'); });
  }

  function goTo(ll, zoom) {
    map.setView(ll, zoom);
    showSpot(ll);
  }

  searchInput.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 250);
  });
  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!results.length) return;
      e.preventDefault();
      var n = results.length;
      activeResult = e.key === 'ArrowDown' ? (activeResult + 1) % n : (activeResult <= 0 ? n - 1 : activeResult - 1);
      renderResults();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      var r = results[activeResult >= 0 ? activeResult : 0];
      if (r) chooseResult(r);
      else { clearTimeout(searchTimer); runSearch(); }
    } else if (e.key === 'Escape') {
      closeResults();
    }
  });
  resultsBox.addEventListener('mousedown', function (e) { e.preventDefault(); });   // keep focus in the box
  resultsBox.addEventListener('click', function (e) {
    var li = e.target.closest('li[role="option"]');
    if (li) chooseResult(results[+li.id.replace('result-', '')]);
  });
  searchInput.addEventListener('blur', function () { setTimeout(closeResults, 150); });

  // ---------- This spot ----------

  var spotAt = null;
  var spotMarker = null;
  var SPOT_KEY = 'researchMap:spotClicks';

  // "Spot info" on/off, remembered in this browser. Off: clicking the map does nothing, and the marker goes.
  $('spot-on').checked = readStore(SPOT_KEY) !== 'off';
  $('spot-on').addEventListener('change', function (e) {
    writeStore(SPOT_KEY, e.target.checked ? 'on' : 'off');
    if (!e.target.checked && spotMarker) { map.removeLayer(spotMarker); spotMarker = null; }
  });
  var spotReq = 0;
  var photoCache = {};

  function dms(v, pos, neg) {
    var a = Math.abs(v), d = Math.floor(a), mf = (a - d) * 60, m = Math.floor(mf), s = (mf - m) * 60;
    return d + '° ' + m + '′ ' + s.toFixed(1) + '″ ' + (v >= 0 ? pos : neg);
  }

  function showSpot(ll, keepTab) {
    spotAt = ll;
    var req = ++spotReq;
    if (!spotMarker) spotMarker = L.marker(ll, { icon: L.divIcon({ className: 'spot-pin', iconSize: [18, 18] }), interactive: false, keyboard: false }).addTo(map);
    spotMarker.setLatLng(ll);

    var lat = ll.lat.toFixed(5), lng = ll.lng.toFixed(5);
    $('spot-empty').hidden = true;
    $('spot').hidden = false;
    $('spot-dec').textContent = lat + ', ' + lng;
    $('spot-dms').textContent = dms(ll.lat, 'N', 'S') + ' · ' + dms(ll.lng, 'E', 'W');
    $('spot-copy').textContent = 'Copy';
    $('spot-height').textContent = 'looking up…';
    getJson(ELEVATION + 'identify?geometryType=esriGeometryPoint&returnGeometry=false&returnCatalogItems=false&f=json&geometry=' +
      pointParam(ll)).then(function (d) {
      var v = parseFloat(d.value);
      if (!isFinite(v)) throw new Error('no data');
      if (req === spotReq) $('spot-height').textContent = fmtHeight(v) + ' above sea level';
    }).catch(function () {
      if (req === spotReq) $('spot-height').textContent = 'not available here';
    });

    var z = Math.max(map.getZoom(), 15);
    $('spot-links').innerHTML = [
      ['Google Maps', 'https://www.google.com/maps/@' + lat + ',' + lng + ',' + z + 'z/data=!3m1!1e3'],
      ['Google Earth', 'https://earth.google.com/web/@' + lat + ',' + lng + ',300a,1200d,35y,0h,0t,0r'],
      ['Bing aerial', 'https://www.bing.com/maps?cp=' + lat + '~' + lng + '&lvl=' + z + '&style=a'],
      ['USGS topoView', 'https://ngmdb.usgs.gov/topoview/viewer/#' + Math.min(z, 15) + '/' + lat + '/' + lng],
      ['PA Mine Map Atlas', 'https://www.minemaps.psu.edu/']
    ].map(function (l) { return '<a href="' + l[1] + '" target="_blank" rel="noopener">' + l[0] + ' ↗</a>'; }).join('');

    showPhotos(ll, req);
    if (!keepTab) showTab('spot');
  }

  $('spot-copy').addEventListener('click', function () {
    var b = $('spot-copy');
    (navigator.clipboard ? navigator.clipboard.writeText($('spot-dec').textContent) : Promise.reject()).then(function () {
      b.textContent = 'Copied';
    }).catch(function () { b.textContent = 'Copy failed'; });
  });
  $('spot-note').addEventListener('click', function () { if (spotAt) addNote(spotAt); });
  $('spot-time').addEventListener('click', function () {
    if (!spotAt) return;
    map.setView(spotAt, Math.max(map.getZoom(), 15));
    if (!timeOn) setTime(true); else loadSheets(false);
  });

  // PennPilot's photo centers for the 1940s–1970s flights, one layer per decade. For each decade the photo
  // whose center is nearest; a photo is about 4.6 km square, so a center within 2 km keeps the spot in frame.
  function nearestPhoto(layer, ll) {
    var url = PENNPILOT + layer + '/query?f=json&geometryType=esriGeometryPoint&inSR=4326&outSR=4326' +
      '&geometry=' + ll.lng + ',' + ll.lat + '&distance=2000&units=esriSRUnit_Meter&outFields=*&returnGeometry=true';
    return getJson(url).then(function (d) {
      var best = null;
      (d.features || []).forEach(function (f) {
        var a = f.attributes || {};
        if (/^y/i.test(a.missing || a.photoIsMis || '')) return;
        // Every decade's record has an HTML snippet linking .../pennpilot/px/eraNNNN/<name>.jpg.
        var m = null;
        Object.keys(a).some(function (k) {
          m = /pennpilot\/px\/(era\d{4})\/([\w-]+)\.jpg/.exec(String(a[k]));
          return m;
        });
        if (!m) return;
        var dist = ll.distanceTo([f.geometry.y, f.geometry.x]);
        var tiff = /href="([^"]+\.tif)"/i.exec(a.Image_TIFF || '');
        if (!best || dist < best.dist) best = { dist: dist, era: m[1], name: m[2], tiff: tiff && tiff[1] };
      });
      if (!best) return null;
      // Names look like "schuylkill_100338_aqs_17_21": county, then the flight date as MMDDYY.
      var dm = /_(\d{2})(\d{2})(\d{2})_/.exec(best.name);
      var base = 'https://www.pasda.psu.edu/pennpilot/px/' + best.era + '/';
      return {
        full: base + best.name + '.jpg',
        thumb: base + 'JPEG/' + best.name + '.jpg',
        tiff: best.tiff,
        year: dm ? 1900 + +dm[3] : null,
        date: dm && +dm[1] >= 1 && +dm[1] <= 12 ? MONTHS[+dm[1] - 1] + ' ' + (+dm[2]) + ', 19' + dm[3] : best.era.slice(3) + 's'
      };
    }).catch(function () { return null; });
  }

  function showPhotos(ll, req) {
    var list = $('spot-photos'), status = $('spot-photos-status');
    list.innerHTML = '';
    status.textContent = 'Looking for photos…';
    var id = ll.lat.toFixed(4) + ',' + ll.lng.toFixed(4);
    var pending = photoCache[id] || (photoCache[id] = Promise.all([0, 1, 2, 3].map(function (layer) {
      return nearestPhoto(layer, ll);
    })));
    pending.then(function (photos) {
      if (req !== spotReq) return;
      photos = photos.filter(Boolean).sort(function (a, b) { return (a.year || 0) - (b.year || 0); });
      status.textContent = photos.length ? '' : 'No PennPilot photos were found for this spot.';
      spotPhotos = photos;
      list.innerHTML = photos.map(function (ph, i) {
        return '<li><a href="' + escapeHtml(ph.full) + '" data-i="' + i + '" target="_blank" rel="noopener">' +
          '<img src="' + escapeHtml(ph.thumb) + '" alt="Aerial photo, ' + escapeHtml(ph.date) + '" loading="lazy">' +
          escapeHtml(ph.date) + '</a></li>';
      }).join('');
    });
  }

  // ---------- Old aerial photo viewer ----------
  // A second Leaflet map with a flat (non-geographic) grid holds the photo, so zooming, dragging and
  // pinching work just like the main map. The small photo shows at once; the larger one replaces it.
  // The full-resolution TIFFs can't be shown in a browser (and Penn State doesn't let pages read them),
  // so they're offered as a download.

  var spotPhotos = [];
  var viewerMap = null, viewerLayers = [], viewerIndex = 0, viewerOpener = null;
  var enh = { bright: $('enh-bright'), contrast: $('enh-contrast'), sharp: $('enh-sharp') };

  function applyEnhance() {
    var k = enh.sharp.value / 100;   // a standard 3x3 sharpen; 0 leaves the photo unchanged
    $('sharpen-kernel').setAttribute('kernelMatrix', [0, -k, 0, -k, 1 + 4 * k, -k, 0, -k, 0].join(' '));
    var filter = 'brightness(' + enh.bright.value / 100 + ') contrast(' + enh.contrast.value / 100 + ')' + (k ? ' url(#sharpen)' : '');
    viewerLayers.forEach(function (l) { var el = l.getElement(); if (el) el.style.filter = filter; });
  }
  [enh.bright, enh.contrast, enh.sharp].forEach(function (input) { input.addEventListener('input', applyEnhance); });
  // Old prints are often flat and grey; this is a good starting point for picking out banks and buildings.
  $('enh-auto').addEventListener('click', function () { enh.bright.value = 105; enh.contrast.value = 150; enh.sharp.value = 60; applyEnhance(); });
  $('enh-reset').addEventListener('click', function () { enh.bright.value = 100; enh.contrast.value = 100; enh.sharp.value = 0; applyEnhance(); });

  function showInViewer(i) {
    var ph = spotPhotos[i];
    if (!ph) return;
    viewerIndex = i;
    $('viewer-title').textContent = 'Aerial photo, ' + ph.date;
    $('viewer-prev').disabled = i === 0;
    $('viewer-next').disabled = i === spotPhotos.length - 1;
    $('viewer-tiff').href = ph.tiff || ph.full;
    $('tiff-steps').hidden = !ph.tiff;
    $('viewer-status').textContent = 'Loading the larger photo…';
    viewerLayers.forEach(function (l) { viewerMap.removeLayer(l); });
    viewerLayers = [];

    // The thumbnail fixes the shape; the photo is laid out 1000 units wide.
    var thumb = new Image();
    thumb.onload = function () {
      if (viewerIndex !== i) return;
      var bounds = [[0, 0], [1000 * thumb.naturalHeight / thumb.naturalWidth, 1000]];
      viewerLayers.push(L.imageOverlay(ph.thumb, bounds).addTo(viewerMap));
      viewerMap.fitBounds(bounds, { animate: false });
      viewerMap.setMaxBounds(L.latLngBounds(bounds).pad(0.5));
      applyEnhance();
      var big = L.imageOverlay(ph.full, bounds);
      big.once('load', function () {
        if (viewerIndex !== i) return;
        var img = big.getElement();
        $('viewer-status').textContent = img.naturalWidth + ' × ' + img.naturalHeight + ' px · scroll or pinch to zoom';
      });
      big.once('error', function () { if (viewerIndex === i) $('viewer-status').textContent = 'The larger photo could not load.'; });
      viewerLayers.push(big.addTo(viewerMap));
      applyEnhance();
    };
    thumb.src = ph.thumb;
  }

  function openViewer(i, opener) {
    viewerOpener = opener;
    $('viewer').hidden = false;
    if (!viewerMap) {
      viewerMap = L.map('viewer-map', { crs: L.CRS.Simple, minZoom: -3, maxZoom: 5, zoomSnap: 0.25, attributionControl: false });
    }
    viewerMap.invalidateSize();
    showInViewer(i);
    $('viewer-close').focus();
  }

  // Full-resolution TIFFs. Penn State's server won't let a web page fetch them, but a file you've
  // downloaded can be read here. The TIFF reader loads only the first time one is opened.
  var utifReady = null, tiffUrl = null;

  function loadUtif() {
    return utifReady || (utifReady = new Promise(function (ok, fail) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/utif@3.1.0/UTIF.js';
      s.onload = ok;
      s.onerror = function () { utifReady = null; fail(); };
      document.head.appendChild(s);
    }));
  }

  function openTiff(file) {
    if (!file) return;
    $('viewer-title').textContent = file.name;
    $('viewer-status').textContent = 'Reading the full-resolution photo…';
    Promise.all([loadUtif(), file.arrayBuffer()]).then(function (r) {
      var buf = r[1], img = UTIF.decode(buf)[0];
      UTIF.decodeImage(buf, img);
      var w = img.width, h = img.height, rgba = UTIF.toRGBA8(img);
      // shortcut: a 45-megapixel canvas is too big for iPhones/iPads (about 16 MP max); those show an error.
      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, 0, w * h * 4), w, h), 0, 0);
      return new Promise(function (ok, fail) {
        canvas.toBlob(function (blob) { if (blob) ok({ blob: blob, w: w, h: h }); else fail(); }, 'image/jpeg', 0.92);
      });
    }).then(function (r) {
      if (tiffUrl) URL.revokeObjectURL(tiffUrl);
      tiffUrl = URL.createObjectURL(r.blob);
      viewerLayers.forEach(function (l) { viewerMap.removeLayer(l); });
      var bounds = [[0, 0], [1000 * r.h / r.w, 1000]];
      viewerLayers = [L.imageOverlay(tiffUrl, bounds).addTo(viewerMap)];
      viewerMap.setMaxBounds(L.latLngBounds(bounds).pad(0.5));
      viewerMap.fitBounds(bounds, { animate: false });
      applyEnhance();
      $('viewer-status').textContent = r.w + ' × ' + r.h + ' px · full resolution · zoom in for detail';
    }).catch(function () {
      $('viewer-status').textContent = 'That file could not be opened. Is it a PennPilot TIFF? (Phones may not have enough memory.)';
    });
  }

  $('viewer-open').addEventListener('click', function () { $('viewer-file').click(); });
  $('viewer-file').addEventListener('change', function (e) { openTiff(e.target.files[0]); e.target.value = ''; });
  $('viewer').addEventListener('dragover', function (e) { e.preventDefault(); $('viewer').classList.add('dropping'); });
  $('viewer').addEventListener('dragleave', function (e) { if (e.target === $('viewer-map')) $('viewer').classList.remove('dropping'); });
  $('viewer').addEventListener('drop', function (e) {
    e.preventDefault();
    $('viewer').classList.remove('dropping');
    openTiff(e.dataTransfer.files[0]);
  });

  function closeViewer() {
    $('viewer').hidden = true;
    if (viewerOpener) viewerOpener.focus();
  }

  $('spot-photos').addEventListener('click', function (e) {
    var a = e.target.closest('a[data-i]');
    if (!a) return;
    e.preventDefault();
    openViewer(+a.dataset.i, a);
  });
  $('viewer-close').addEventListener('click', closeViewer);
  $('viewer-prev').addEventListener('click', function () { showInViewer(viewerIndex - 1); });
  $('viewer-next').addEventListener('click', function () { showInViewer(viewerIndex + 1); });
  document.addEventListener('keydown', function (e) {
    if ($('viewer').hidden) return;
    if (e.key === 'Escape') { e.stopPropagation(); closeViewer(); }
    else if (e.key === 'ArrowLeft' && e.target.type !== 'range') showInViewer(viewerIndex - 1);
    else if (e.key === 'ArrowRight' && e.target.type !== 'range') showInViewer(viewerIndex + 1);
  }, true);

  // ---------- Click modes: look at a spot (default), measure, place a note ----------

  var clickMode = 'spot';

  function setClickMode(m) {
    clickMode = m;
    $('measure').setAttribute('aria-pressed', String(m === 'measure'));
    $('measure').textContent = m === 'measure' ? 'Stop measuring' : (route.length ? 'Keep measuring' : 'Start measuring');
    $('note-add').setAttribute('aria-pressed', String(m === 'note'));
    $('mode-bar').hidden = m === 'spot';
    $('mode-text').textContent = m === 'measure' ? 'Click along a route to measure it.' : 'Click the map where the note goes.';
    map.getContainer().classList.toggle('crosshair', m !== 'spot');
  }
  $('measure').addEventListener('click', function () { setClickMode(clickMode === 'measure' ? 'spot' : 'measure'); });
  $('note-add').addEventListener('click', function () { setClickMode(clickMode === 'note' ? 'spot' : 'note'); });
  $('mode-done').addEventListener('click', function () { setClickMode('spot'); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && clickMode !== 'spot') setClickMode('spot'); });

  map.on('click', function (e) {
    if (clickMode === 'measure') addMeasurePoint(e.latlng);
    else if (clickMode === 'note') { setClickMode('spot'); addNote(e.latlng); }
    else if ($('spot-on').checked) showSpot(e.latlng);
  });

  // ---------- Measure and ground profile ----------

  var route = [];
  var routeLine = L.polyline([], { color: '#d4a24c', weight: 3, dashArray: '6 4', interactive: false }).addTo(map);
  var routeDots = L.layerGroup().addTo(map);
  var profileMarker = null;
  var profileReq = 0;

  function routeLength() {
    var total = 0;
    for (var i = 1; i < route.length; i++) total += map.distance(route[i - 1], route[i]);
    return total;
  }

  function addMeasurePoint(ll) {
    route.push(ll);
    routeLine.setLatLngs(route);
    L.circleMarker(ll, { radius: 4, color: '#d4a24c', fillColor: '#16181b', fillOpacity: 1, weight: 2, interactive: false }).addTo(routeDots);
    $('measure-out').hidden = false;
    $('measure-total').textContent = route.length < 2 ? 'Now click a second point.' : 'Length: ' + fmtDistance(routeLength());
    if (route.length >= 2) loadProfile();
  }

  $('measure-clear').addEventListener('click', function () {
    route = [];
    routeLine.setLatLngs([]);
    routeDots.clearLayers();
    if (profileMarker) { map.removeLayer(profileMarker); profileMarker = null; }
    $('profile').innerHTML = '';
    $('measure-out').hidden = true;
    setClickMode(clickMode);
  });

  function loadProfile() {
    var req = ++profileReq;
    var box = $('profile');
    box.innerHTML = '<p class="hint">Loading the ground profile…</p>';
    var g = JSON.stringify({ paths: [route.map(function (p) { return [p.lng, p.lat]; })], spatialReference: { wkid: 4326 } });
    getJson(ELEVATION + 'getSamples?geometryType=esriGeometryPolyline&sampleCount=120&returnFirstValueOnly=true&f=json&geometry=' +
      encodeURIComponent(g)).then(function (d) {
      if (req !== profileReq) return;
      var pts = (d.samples || []).map(function (s) {
        return { ll: L.latLng(s.location.y, s.location.x), h: parseFloat(s.value) };
      }).filter(function (s) { return isFinite(s.h); });
      if (pts.length < 2) throw new Error('no samples');
      // Samples come back in order along the line; distance is measured point to point.
      var dist = 0;
      pts.forEach(function (p, i) { if (i) dist += map.distance(pts[i - 1].ll, p.ll); p.d = dist; });
      drawProfile(box, pts);
    }).catch(function () {
      if (req === profileReq) box.innerHTML = '<p class="hint">The ground profile could not load.</p>';
    });
  }

  function drawProfile(box, pts) {
    var W = 340, H = 140, padL = 48, padB = 20, padT = 8;
    var hs = pts.map(function (p) { return p.h; });
    var lo = Math.min.apply(null, hs), hi = Math.max.apply(null, hs);
    if (hi - lo < 5) { lo -= 3; hi += 3; }
    var total = pts[pts.length - 1].d;
    function x(d) { return padL + (d / total) * (W - padL - 4); }
    function y(h) { return padT + (1 - (h - lo) / (hi - lo)) * (H - padT - padB); }
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + x(p.d).toFixed(1) + ' ' + y(p.h).toFixed(1); }).join('');
    var area = line + 'L' + x(total).toFixed(1) + ' ' + (H - padB) + 'L' + padL + ' ' + (H - padB) + 'Z';
    box.innerHTML =
      '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Ground profile from ' + fmtHeight(hs[0]) + ' to ' + fmtHeight(hs[hs.length - 1]) + '">' +
        '<path d="' + area + '" class="prof-area"/><path d="' + line + '" class="prof-line"/>' +
        '<text x="' + (padL - 4) + '" y="' + (padT + 8) + '" text-anchor="end">' + fmtHeight(hi) + '</text>' +
        '<text x="' + (padL - 4) + '" y="' + (H - padB) + '" text-anchor="end">' + fmtHeight(lo) + '</text>' +
        '<text x="' + padL + '" y="' + (H - 4) + '">0</text>' +
        '<text x="' + (W - 4) + '" y="' + (H - 4) + '" text-anchor="end">' + fmtDistance(total) + '</text>' +
        '<line class="prof-cursor" y1="' + padT + '" y2="' + (H - padB) + '" visibility="hidden"/>' +
      '</svg><p class="hint" id="prof-read">' + fmtHeight(hi - lo) + ' from the lowest to the highest point. Point at the chart to find that spot on the map.</p>';

    var svg = box.querySelector('svg'), cursor = box.querySelector('.prof-cursor'), read = $('prof-read');
    svg.addEventListener('pointermove', function (e) {
      var r = svg.getBoundingClientRect();
      var d = ((e.clientX - r.left) / r.width * W - padL) / (W - padL - 4) * total;
      var p = pts.reduce(function (a, b) { return Math.abs(b.d - d) < Math.abs(a.d - d) ? b : a; });
      cursor.setAttribute('x1', x(p.d)); cursor.setAttribute('x2', x(p.d)); cursor.setAttribute('visibility', 'visible');
      read.textContent = fmtDistance(p.d) + ' along: ' + fmtHeight(p.h);
      if (!profileMarker) profileMarker = L.circleMarker(p.ll, { radius: 6, color: '#fff', fillColor: '#d4a24c', fillOpacity: 1, interactive: false }).addTo(map);
      profileMarker.setLatLng(p.ll);
    });
  }

  // ---------- Notes ----------

  var notesLayer = L.layerGroup().addTo(map);
  var notes = loadNotes();
  var noteIcon = L.divIcon({ className: 'note-pin', html: '<span></span>', iconSize: [18, 18], iconAnchor: [9, 9] });

  function loadNotes() {
    try {
      var v = JSON.parse(readStore(NOTES_KEY));
      return Array.isArray(v) ? v.filter(function (n) { return n && isFinite(n.lat) && isFinite(n.lng); }) : [];
    } catch (e) { return []; }
  }

  function saveNotes() {
    writeStore(NOTES_KEY, JSON.stringify(notes.map(function (n) {
      return { lat: n.lat, lng: n.lng, text: n.text, date: n.date };
    })));
    renderNotes();
  }

  function notePopup(n, marker) {
    var div = document.createElement('div');
    div.className = 'note-pop';
    div.innerHTML = '<label class="visually-hidden" for="note-text">Note</label>' +
      '<textarea id="note-text" rows="4" placeholder="What did you find here?">' + escapeHtml(n.text) + '</textarea>' +
      '<div class="btn-row"><button type="button" class="btn note-save">Save</button>' +
      '<button type="button" class="btn note-del">Delete</button></div>' +
      '<div class="meta">' + n.lat.toFixed(5) + ', ' + n.lng.toFixed(5) + (n.date ? ' · ' + escapeHtml(n.date) : '') + '</div>';
    div.querySelector('.note-save').addEventListener('click', function () {
      n.text = div.querySelector('textarea').value.trim();
      saveNotes();
      marker.closePopup();
    });
    div.querySelector('.note-del').addEventListener('click', function () {
      notes.splice(notes.indexOf(n), 1);
      saveNotes();
    });
    return div;
  }

  function renderNotes() {
    notesLayer.clearLayers();
    var list = $('notes');
    list.innerHTML = '';
    notes.forEach(function (n) {
      var m = L.marker([n.lat, n.lng], { icon: noteIcon, title: n.text || 'Note' }).addTo(notesLayer);
      m.bindPopup(function () { return notePopup(n, m); }, { maxWidth: 280 });
      n.marker = m;
      var li = document.createElement('li');
      li.innerHTML = '<button type="button">' + escapeHtml(n.text || '(no text yet)') +
        (n.date ? ' <small>' + escapeHtml(n.date) + '</small>' : '') + '</button>';
      li.firstChild.addEventListener('click', function () {
        map.setView([n.lat, n.lng], Math.max(map.getZoom(), 16));
        m.openPopup();
      });
      list.appendChild(li);
    });
    $('note-count').textContent = notes.length ? '(' + notes.length + ')' : '';
  }

  function addNote(ll) {
    var n = { lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6), text: '', date: new Date().toISOString().slice(0, 10) };
    notes.push(n);
    saveNotes();
    showTab('tools');
    n.marker.openPopup();
    var ta = $('note-text');
    if (ta) ta.focus();
  }

  $('notes-export').addEventListener('click', function () {
    var gj = { type: 'FeatureCollection', features: notes.map(function (n) {
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [n.lng, n.lat] }, properties: { note: n.text, date: n.date } };
    }) };
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(gj, null, 2)], { type: 'application/geo+json' }));
    a.download = 'colliery-research-notes.geojson';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });

  var importInput = $('notes-import');
  $('notes-import-btn').addEventListener('click', function () { importInput.click(); });
  importInput.addEventListener('change', function () {
    var file = importInput.files[0];
    if (!file) return;
    file.text().then(function (t) {
      (JSON.parse(t).features || []).forEach(function (f) {
        if (!f.geometry || f.geometry.type !== 'Point') return;
        var c = f.geometry.coordinates, p = f.properties || {};
        notes.push({ lat: +c[1], lng: +c[0], text: String(p.note || p.name || p.description || ''), date: String(p.date || '') });
      });
      saveNotes();
    }).catch(function () { alert('That file could not be read as GeoJSON.'); });
    importInput.value = '';
  });

  // ---------- Keyboard shortcuts ----------
  // Capture phase, so the arrow keys step through years instead of panning the map.

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || !$('viewer').hidden) return;
    if (e.target.closest('input, textarea, select, [contenteditable]') && e.target.type !== 'checkbox') return;
    var k = e.key.toLowerCase(), handled = true;
    if (k === '/') searchInput.focus();
    else if (k >= '1' && k <= String(GROUND.length)) setGround(GROUND[+k - 1].key);
    else if (k === 't') setTime(!timeOn);
    else if (k === 'p') $('show-pins').click();
    else if (k === 'r') $('show-rails').click();
    else if (timeOn && (k === 'arrowleft' || k === 'arrowright')) pick(stopIndex + (k === 'arrowleft' ? -1 : 1));
    else if (timeOn && k === ' ' && !e.target.closest('button')) $('time-play').click();
    else if (timeOn && (k === 'f' || k === 's' || k === 'b')) setMode({ f: 'fade', s: 'swipe', b: 'blink' }[k]);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // ---------- Start ----------

  setUnits(unitKey);
  setGround(state.ground);
  setMode(state.mode);
  renderNotes();
  if (state.older) setTime(true);
})();
