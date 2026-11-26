/* =====================================================================
   PEATLAND WILDFIRE COMMAND CENTER – app.js  (ArcGIS Maps SDK 5.x + Calcite)
   PERFORMANCE RULES used here (the old version broke all of them):
   1. No graphic/symbol is rebuilt per frame – styling lives in renderers (GPU), not in JS objects.
   2. One requestAnimationFrame loop, throttled to ~8 updates/s, doing tiny work (one opacity + one polygon).
   3. Data changes are batched: telemetry = ONE applyEdits every 5 s; filters = definitionExpression.
   4. The wind FlowRenderer runs at lower density (GPU cost scales with streamline count).
   Sections: 1 Setup · 2 Data & layers · 3 Simulation · 4 Threat analysis · 5 UI · 6 Loop
   ===================================================================== */
(async () => {
const [FeatureLayer, GeoJSONLayer, GraphicsLayer, Graphic, ImageryTileLayer, DimensionalDefinition, Camera, Extent, Point, TileLayer, Basemap, LocalBasemapsSource] =
  await $arcgis.import(["@arcgis/core/layers/FeatureLayer.js", "@arcgis/core/layers/GeoJSONLayer.js",
    "@arcgis/core/layers/GraphicsLayer.js", "@arcgis/core/Graphic.js", "@arcgis/core/layers/ImageryTileLayer.js",
    "@arcgis/core/layers/support/DimensionalDefinition.js", "@arcgis/core/Camera.js",
    "@arcgis/core/geometry/Extent.js", "@arcgis/core/geometry/Point.js", "@arcgis/core/layers/TileLayer.js", "@arcgis/core/Basemap.js", "@arcgis/core/widgets/BasemapGallery/support/LocalBasemapsSource.js"]);

const $ = id => document.getElementById(id);
const set = (id, v) => { const e = $(id); if (e.textContent !== String(v)) e.textContent = v; };   // write DOM only if changed
const rnd = (s => () => (s = s * 16807 % 2147483647) / 2147483647)(42);                         // repeatable "random"
const PULSE = true;               // gentle hotspot "breathing" (set false to disable)
const statusOf = v => v >= -40 ? "Normal" : v >= -80 ? "Dry" : "Critical";
const compass = b => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(((b % 360) + 360) % 360 / 45) % 8];

// ---------- 1) SETUP: 3D scene (<arcgis-scene> in index.html) ----------
const viewEl = document.querySelector("arcgis-scene");
await viewEl.viewOnReady();
const view = viewEl.view, map = viewEl.map;
view.qualityProfile = "medium";   // lighter 3D rendering = higher FPS
view.environment = { atmosphereEnabled: false, starsEnabled: false, background: { type: "color", color: "#1a2736" }, lighting: { type: "virtual" } };   // virtual light = bright, un-shaded symbol colours
map.ground = "world-elevation";   // real terrain; draped layers and the wind flow follow it
const HOME = new Camera({ position: { longitude: 111.8, latitude: -5.8, z: 420000 }, tilt: 55, heading: 0 });
viewEl.camera = HOME;

// ---------- 2) DATA & LAYERS ----------
const tma = await (await fetch("data/tma_stations.json")).json();
const S = tma.stations, DAYS = tma.dates.map(d => d.slice(5)).concat("Now");
const cur = S.map(s => s.series[6]);                       // current water level per station

// 2a) TMAT SPACE-TIME CUBE: every station is a vertical stack of 8 slices (7 days + "Now").
//     Slice colour = water level that day, so a column that turns orange/red toward the top is drying out.
const SL = 2300, tmFeats = [];
S.forEach((s, i) => s.series.concat(cur[i]).forEach((v, k) => tmFeats.push(new Graphic({
  geometry: { type: "point", x: s.lon, y: s.lat, z: k * SL, hasZ: true, spatialReference: { wkid: 4326 } },
  attributes: { OBJECTID: i * 8 + k + 1, sensor_id: s.id, name: s.name, slice: k, day: DAYS[k],
    water_cm: v, cur_status: statusOf(cur[i]), battery: Math.round(55 + rnd() * 45) } }))));
const tmat = new FeatureLayer({
  title: "TMAT sensors", source: tmFeats, objectIdField: "OBJECTID", geometryType: "point", hasZ: true,
  spatialReference: { wkid: 4326 }, elevationInfo: { mode: "relative-to-ground" },
  fields: [["OBJECTID", "oid"], ["sensor_id", "string"], ["name", "string"], ["slice", "integer"],
    ["day", "string"], ["water_cm", "double"], ["cur_status", "string"], ["battery", "integer"]].map(([name, type]) => ({ name, type })),
  renderer: { type: "simple",
    symbol: { type: "point-3d", symbolLayers: [{ type: "object", resource: { primitive: "cylinder" }, anchor: "bottom",
      width: 3600, height: 2100, depth: 3600, material: { color: "#22d3ee" } }] },
    visualVariables: [{ type: "color", field: "water_cm", stops: [{ value: -100, color: "#ff1744" },
      { value: -80, color: "#ff6d00" }, { value: -40, color: "#ffea00" }, { value: 0, color: "#00e5ff" }] }] },
  popupTemplate: { title: "TMAT {sensor_id} – {day}", content: "<b>{name}</b><br>Water level that day: <b>{water_cm} cm</b><br>Sensor now: {cur_status}<br>Battery: {battery}%" }
});

// 2b) VIIRS HOTSPOTS (simulated). A FeatureLayer styled by a renderer: size AND colour follow fire
//     radiative power (FRP, MW): small yellow = weak, larger orange/red = intense. Semi-transparent, no flashing.
const dry = S.filter((s, i) => cur[i] < -70), pool = dry.length ? dry : S, H = [];
for (let i = 0; i < 60; i++) { const b = pool[Math.floor(rnd() * pool.length)], frp = Math.round(4 + rnd() * rnd() * 90);
  H.push({ lon: b.lon + (rnd() - .5) * .3, lat: b.lat + (rnd() - .5) * .3, frp, ago: rnd() * 48, conf: frp > 25 ? "high" : "nominal" }); }
const hot = new FeatureLayer({
  title: "VIIRS hotspots", objectIdField: "OBJECTID", geometryType: "point", spatialReference: { wkid: 4326 },
  elevationInfo: { mode: "relative-to-ground" },
  source: H.map((h, i) => new Graphic({ geometry: { type: "point", longitude: h.lon, latitude: h.lat },
    attributes: { OBJECTID: i + 1, frp: h.frp, hours_ago: h.ago, conf: h.conf, time: new Date(Date.now() - h.ago * 36e5).toLocaleString() } })),
  fields: [["OBJECTID", "oid"], ["frp", "double"], ["hours_ago", "double"], ["conf", "string"], ["time", "string"]].map(([name, type]) => ({ name, type })),
  renderer: { type: "simple",
    symbol: { type: "point-3d", symbolLayers: [{ type: "object", resource: { primitive: "sphere" }, width: 2500, height: 2500, depth: 2500, material: { color: [255, 140, 40, 0.8] } }] },
    visualVariables: [
      { type: "size", field: "frp", valueUnit: "meters", stops: [{ value: 4, size: 2200 }, { value: 94, size: 6000 }] },
      { type: "color", field: "frp", stops: [{ value: 4, color: [255, 230, 0, 1] }, { value: 40, color: [255, 120, 0, 1] }, { value: 94, color: [255, 20, 20, 1] }] }] },
  popupTemplate: { title: "VIIRS thermal anomaly", content: "Detected: {time}<br>Fire radiative power: <b>{frp} MW</b><br>Confidence: {conf}" }
});
const top = H.reduce((a, h) => h.frp > a.frp ? h : a), origin = new Point({ longitude: top.lon, latitude: top.lat });

// 2c) PEATLAND UNITS (KHG), coloured by median water level of their sensors.
const khg = new GeoJSONLayer({
  url: "data/khg_peatland.geojson", title: "KHG", outFields: ["*"],
  renderer: { type: "simple", symbol: { type: "polygon-3d", symbolLayers: [{ type: "fill",
      material: { color: [120, 120, 120, 0.15] }, outline: { color: [255, 255, 255, 0.3], size: 0.6 } }] },
    visualVariables: [{ type: "color", field: "median_cm", stops: [{ value: -100, color: [255, 45, 45, 0.5] },
      { value: -70, color: [255, 140, 30, 0.4] }, { value: -40, color: [250, 210, 60, 0.3] }, { value: 0, color: [40, 200, 230, 0.25] }] }] },
  popupTemplate: { title: "Area Threat Analysis – {name}", content: f => threat("khg", f.graphic.attributes) }
});

// 2d) FIRE: INITIAL BURN AREA (bright yellow polygon at the ignition point), SIMULATED SPREAD (red polygon that grows
//     from it) and a 24 h PROJECTION (orange outline). See the "How the fire spread is simulated" card.
const R0 = 2.2;   // km: approximate radius of the initial burn area
const cl0 = Math.cos(origin.latitude * Math.PI / 180);
const burnRing = Array.from({ length: 41 }, (_, k) => { const t = k / 40 * 2 * Math.PI, r = R0 * (1 + .22 * Math.sin(3 * t + 1) + .12 * Math.sin(5 * t + 2));   // irregular scar outline
  return [origin.longitude + r * Math.sin(t) / (111.3 * cl0), origin.latitude + r * Math.cos(t) / 110.6]; });
const burnHa = (() => { const p = burnRing.map(([x, y]) => [(x - origin.longitude) * 111.3 * cl0, (y - origin.latitude) * 110.6]); let sum = 0;
  for (let i = 0; i < p.length - 1; i++) sum += p[i][0] * p[i + 1][1] - p[i + 1][0] * p[i][1]; return Math.abs(sum) / 2 * 100; })();   // shoelace, km² -> ha
const fireLayer = new GraphicsLayer({ title: "Fire burn area & spread" });
const pop = { title: "Area Threat Analysis – simulated spread", content: () => threat("fire") };
const projection = new Graphic({ popupTemplate: pop, symbol: { type: "polygon-3d", symbolLayers: [{ type: "fill",
  material: { color: [255, 160, 30, 0.1] }, outline: { color: [255, 190, 60, 1], size: 2 } }] } });
const footprint = new Graphic({ popupTemplate: pop, symbol: { type: "polygon-3d", symbolLayers: [{ type: "fill",
  material: { color: [255, 70, 20, 0.6] }, outline: { color: [255, 110, 20, 1], size: 2.5 } }] } });
const burn = new Graphic({ geometry: { type: "polygon", rings: [burnRing], spatialReference: { wkid: 4326 } },
  popupTemplate: { title: "Initial burn area", content: () => threat("burn") },
  symbol: { type: "polygon-3d", symbolLayers: [{ type: "extrude", size: 1200, material: { color: [255, 235, 0, 1] },
    edges: { type: "solid", color: [255, 255, 140, 1], size: 1.5 } }] } });   // raised yellow slab = the part that "pops"
fireLayer.addMany([projection, footprint, burn]);

// 2e) CRITICAL INFRASTRUCTURE (simulated). Each asset sits at a bearing/distance from the ignition point, measured from the
//     main spread direction, so the fire reaches several of them as it grows. Colour: cyan = clear, orange = inside the 24 h
//     projection, red = inside the fire perimeter. off = bearing offset (deg), km = distance from ignition.
const ASSET_DEFS = [
  { n: "Airport", off: 0, km: 19, info: "Regional airport · runway ≈1,800 m · ≈30 flights/day",
    why: "Haze cuts runway visibility below flight minima, so flights are delayed, diverted or suspended", act: "Issue NOTAM, brief airlines, stage a diversion plan, track visibility hourly" },
  { n: "Hospital", off: -12, km: 12, info: "Referral hospital · ≈120 beds",
    why: "Smoke raises respiratory (ISPA, asthma) admissions and oxygen demand", act: "Add surge capacity, stock N95 masks, prepare clean-air wards" },
  { n: "Settlement", off: 8, km: 7, info: "Village cluster · ≈2,500 residents",
    why: "Evacuation need plus prolonged smoke exposure for children and elderly", act: "Early warning, mark evacuation routes, open clean-air shelter" },
  { n: "Power substation", off: 20, km: 15, info: "20 kV substation · feeds ≈8,000 customers",
    why: "Ash and smoke cause line flashovers; heat damages equipment, so outages cascade to pumps and clinics", act: "Pre-position crews, re-route feeders, clear vegetation" },
  { n: "Fuel depot", off: -25, km: 22, info: "Fuel depot · ≈2,000 kL storage",
    why: "Fire and explosion hazard; loss cuts fuel for response vehicles and generators", act: "Cut a firebreak, stage foam units, restrict access" },
  { n: "Highway bridge", off: 35, km: 14, info: "Arterial highway bridge · ≈6,000 vehicles/day",
    why: "Closure cuts evacuation and fire-crew access; low visibility raises crash risk", act: "Traffic control, signed alternative route, visibility warnings" },
  { n: "Oil-palm mill", off: 5, km: 26, info: "Palm-oil mill · ≈45 t/h · plantation concession",
    why: "Plantation and mill losses; the concession holder carries fire liability", act: "Notify the concession, deploy the mill fire brigade, check canal water levels" },
  { n: "Peat canal weir", off: 180, km: 8, info: "Rewetting canal block (peat restoration)",
    why: "Damage to the rewetting structure keeps the water table low, which fuels future fires", act: "Inspect after the fire and rebuild blocks" }];
const assets = ASSET_DEFS.map(d => ({ ...d, name: d.n, lon: origin.longitude, lat: origin.latitude, state: 0 }));
const ASSET_COL = ["#00e5ff", "#ffa000", "#ff1744"];
const aSym = c => ({ type: "point-3d", symbolLayers: [{ type: "icon", resource: { primitive: "kite" }, size: 13, material: { color: c }, outline: { color: "white", size: 1 } }] });
const infra = new GraphicsLayer({ title: "Infrastructure", elevationInfo: { mode: "relative-to-ground", offset: 2500 } });
assets.forEach((a, i) => { a.g = new Graphic({ attributes: { i, name: a.n }, symbol: aSym(ASSET_COL[0]),
  popupTemplate: { title: "{name} – critical infrastructure", content: f => assetCard(f.graphic.attributes.i) } }); });
function placeAssets(baseTo) {   // baseTo = main spread direction (deg); re-run when the real wind direction is known
  assets.forEach(a => { const b = (baseTo + a.off) * Math.PI / 180;
    a.lon = origin.longitude + a.km * Math.sin(b) / (111.3 * cl0); a.lat = origin.latitude + a.km * Math.cos(b) / 110.6;
    a.g.geometry = { type: "point", longitude: a.lon, latitude: a.lat }; a.g.symbol = aSym(ASSET_COL[0]); a.state = 0; });
}
placeAssets(45); assets.forEach(a => infra.add(a.g));

// 2f) WIND FLOW – Esri FlowRenderer on an ImageryTileLayer (Living Atlas monthly-average wind, Vector-MagDir).
//     Replace WIND_URL with your own Vector-UV/MagDir image service for live wind.
const WIND_URL = "https://tiledimageservices.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Average_Wind_Speeds_Month_Altitude/ImageServer";
const windDef = [new DimensionalDefinition({ variableName: "Vector-MagDir", dimensionName: "StdPressure", values: [100000], isSlice: true }),
  new DimensionalDefinition({ variableName: "Vector-MagDir", dimensionName: "StdTime", values: [10], isSlice: true })];   // surface, October
const windFlow = new ImageryTileLayer({ url: WIND_URL, title: "Wind flow", multidimensionalDefinition: windDef,
  elevationInfo: { mode: "relative-to-ground", offset: 800 },
  renderer: { type: "flow", density: 0.25, trailLength: 45, maxPathLength: 90, flowSpeed: 2, trailWidth: 2.5,   // sparse, long, slow streamlines = smoother
    visualVariables: [{ type: "color", field: "Magnitude", stops: [{ value: 0, color: [30, 120, 255, 1] }, { value: 2, color: [34, 211, 238, 1] },
      { value: 4, color: [94, 234, 212, 1] }, { value: 7, color: [232, 255, 138, 1] }, { value: 12, color: [255, 255, 255, 1] }] }] } });

// Terrain hillshade (draped on the ground) makes relief readable under the dark basemap.
const hill = new TileLayer({ url: "https://services.arcgisonline.com/arcgis/rest/services/Elevation/World_Hillshade/MapServer", title: "Terrain hillshade", opacity: 0.35, visible: false });
// Draw order, bottom -> top. The Layers panel can change it.
const ORDER = [hill, khg, windFlow, infra, fireLayer, tmat, hot];
const NAMES = new Map([[hill, "Terrain hillshade"], [khg, "Peatland hydrological units (KHG)"], [windFlow, "Wind flow"], [infra, "Critical infrastructure (sim)"],
  [fireLayer, "Fire burn area & spread"], [tmat, "TMAT groundwater sensors"], [hot, "VIIRS hotspots"]]);
map.addMany(ORDER);

// ---------- 3) SIMULATION STATE ----------
let T = 1, playing = false, windFrom = 225, windSpeed = 14, realWind = null, lastKey = -1, opHot = 1, selSensor = -1, spreadRing = [], projRing = [], alertsReady = false;   // T: 0 = 48 h ago … 1 = now
const F = { conf: "", status: "" };                                                          // active filters
const fire = { a: 2, b: 1, off: 1, a24: 12, b24: 6, off24: 8, to: 45 };
const sel = () => S.map((s, i) => i).filter(i => !F.status || statusOf(cur[i]) === F.status);
const hotExpr = ago => [`hours_ago >= ${(Math.round(ago * 2) / 2)}`, F.conf && `conf = '${F.conf}'`].filter(Boolean).join(" AND ");

// Read the wind at the fire origin so cards & footprint match the streamlines (falls back to simulated wind).
windFlow.load().then(() => windFlow.identify(origin, { multidimensionalDefinition: windDef })).then(r => {
  const [mag, dir] = r.magdirValue || [];
  if (mag >= 0 && mag < 40 && dir >= 0 && dir <= 360) { realWind = { speed: mag * 3.6, from: dir }; placeAssets((dir + 180) % 360); applyTime(); }
}).catch(() => {});
windFlow.load().catch(() => pushAlert("Wind service unavailable – wind card is simulated", "warn"));

const dryF = () => { const idx = sel(), avg = idx.length ? idx.reduce((t, i) => t + cur[i], 0) / idx.length : -60; return Math.min(1.5, Math.max(0, (-avg - 40) / 60)); };
const headROS = () => (0.08 + 0.02 * windSpeed) * (1 + dryF());      // head-fire rate of spread, km/h (grows with wind and peat dryness)
function spread(t) {   // elliptical fire growth (Huygens' principle) around the initial burn area, t = hours
  const LB = 1 + 8.729 * Math.pow(1 - Math.exp(-0.03 * windSpeed), 2.155), e = Math.sqrt(LB * LB - 1) / LB;   // length-to-breadth ratio from wind
  const Rh = headROS(), Rb = Rh * (1 - e) / (1 + e), Rf = (Rh + Rb) / (2 * LB), grow = (Rh + Rb) / 2 * t;
  return { LB, Rh, Rb, Rf, a: R0 + grow, b: R0 + grow / LB, off: (Rh - Rb) / 2 * t };
}
const NOISE = p => 1 + .22 * Math.sin(3 * p + 1) + .12 * Math.sin(5 * p + 2);   // same irregularity as the burn-area outline (p = bearing, rad)
const ellipse = (c, a, b, brg, off) => {   // wind-stretched ellipse, then roughened like the burn scar (so it is NOT a smooth oval)
  const r = brg * Math.PI / 180, cl = Math.cos(c.latitude * Math.PI / 180), ring = [];
  for (let k = 0; k < 72; k++) { const t = k / 72 * 2 * Math.PI, x = a * Math.cos(t), y = b * Math.sin(t);
    let e = x * Math.sin(r) + y * Math.cos(r), n = x * Math.cos(r) - y * Math.sin(r);          // east/north from the ellipse centre (km)
    const f = NOISE(Math.atan2(e, n)) * (1.03 + .03 * Math.sin(11 * t + 3));                   // bearing-based roughness + small "fingers"
    e = e * f + off * Math.sin(r); n = n * f + off * Math.cos(r);                               // shift the centre downwind
    ring.push([c.longitude + e / (111.3 * cl), c.latitude + n / 110.6]); }
  ring.push(ring[0]); return { type: "polygon", rings: [ring], spatialReference: { wkid: 4326 } };
};
const inside = (ring, x, y) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {   // point-in-polygon
  const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
function checkImpacts() {   // alert when the spread polygon (or its 24 h projection) newly reaches a critical asset
  if (!alertsReady) return;
  assets.forEach(a => { const st = inside(spreadRing, a.lon, a.lat) ? 2 : inside(projRing, a.lon, a.lat) ? 1 : 0;
    if (st > a.state) pushAlert(st === 2 ? `Fire perimeter reached ${a.n}: ${a.why}` : `${a.n} inside the 24 h projected spread: ${a.why}`, st === 2 ? "crit" : "warn", a.lon, a.lat);
    if (st !== a.state) { a.state = st; a.g.symbol = aSym(ASSET_COL[st]); } });   // st < state = replay moved back in time: reset so it can alert again
}

function applyTime() {
  const ago = 48 * (1 - T);
  if (realWind) { windFrom = realWind.from; windSpeed = realWind.speed; } else { windFrom = 225 + 40 * Math.sin(T * 12.6); windSpeed = 14 + 6 * Math.sin(T * 9); }
  const to = (windFrom + 180) % 360, g = spread(48 * T), g24 = spread(48 * T + 24);
  Object.assign(fire, { a: g.a, b: g.b, off: g.off, a24: g24.a, b24: g24.b, off24: g24.off, to });
  const gs = ellipse(origin, g.a, g.b, to, g.off), gp = ellipse(origin, g24.a, g24.b, to, g24.off);
  spreadRing = gs.rings[0]; projRing = gp.rings[0]; footprint.geometry = gs; projection.geometry = gp; checkImpacts();
  set("sciLive", `Now: wind ${Math.round(windSpeed)} km/h from ${compass(windFrom)} · L:B ${g.LB.toFixed(1)} · head ${g.Rh.toFixed(2)} / flank ${g.Rf.toFixed(2)} / back ${g.Rb.toFixed(2)} km/h · burned ≈ ${Math.round(Math.PI * g.a * g.b * 100).toLocaleString()} ha`);
  const key = Math.round(ago * 2); if (key !== lastKey) { lastKey = key; hot.definitionExpression = hotExpr(ago); }   // only when the visible set changes
  set("timeLabel", T >= .999 ? "Now" : "-" + ago.toFixed(0) + " h");
  const live = $("live"); live.kind = T >= .999 ? "danger" : "warning"; set("live", T >= .999 ? "LIVE" : "REPLAY");
  stats();
}

function stats() {
  const ago = 48 * (1 - T), idx = sel(), avg = idx.length ? idx.reduce((s, i) => s + cur[i], 0) / idx.length : NaN;
  const n = H.filter(h => h.ago >= ago && (!F.conf || h.conf === F.conf)).length;
  set("kHot", n); const cv = selSensor >= 0 ? cur[selSensor] : avg; set("kTma", isNaN(cv) ? "–" : cv.toFixed(1)); set("kWind", Math.round(windSpeed));
  set("kDir", "km/h from " + compass(windFrom) + (realWind ? " (Oct avg)" : ""));
  const rr = isNaN(avg) || avg > -40 ? 0 : avg > -70 ? 1 : 2, cc = n < 8 ? 0 : n < 20 ? 1 : 2, sc = rr + cc;
  [...$("matrix").children].forEach(d => d.classList.toggle("on", +d.dataset.r === rr && +d.dataset.c === cc));
  $("riskBlock").description = `${["LOW", "LOW", "MODERATE", "HIGH", "EXTREME"][sc]} · peat ${isNaN(avg) ? "–" : avg.toFixed(0)} cm · ${n} hotspots`;
}

// Telemetry: ONE batched applyEdits every 5 s (was per-100ms work before).
setInterval(() => {
  const edits = [];
  S.forEach((s, i) => { const old = cur[i], nv = +Math.max(-140, Math.min(10, old + (rnd() - .55) * 1.6)).toFixed(1), ch = statusOf(old) !== statusOf(nv);
    cur[i] = nv; const now = { OBJECTID: i * 8 + 8, water_cm: nv }; if (ch) now.cur_status = statusOf(nv); edits.push(new Graphic({ attributes: now }));
    if (ch) { for (let k = 1; k <= 7; k++) edits.push(new Graphic({ attributes: { OBJECTID: i * 8 + k, cur_status: statusOf(nv) } }));
      if (nv < -80) pushAlert(`Sensor ${s.id} fell below -80 cm (critical)`, "crit", s.lon, s.lat); } });
  tmat.applyEdits({ updateFeatures: edits }).catch(() => {});
  updateChart(); stats();
}, 5000);

// ---------- 4) AREA THREAT ANALYSIS (popup card for fire footprint / peat units) ----------
const kmXY = (lon, lat) => [(lon - origin.longitude) * 111.3 * Math.cos(origin.latitude * Math.PI / 180), (lat - origin.latitude) * 110.6];
function threat(kind, at) {
  const ros = headROS();   // head-fire spread, km/h (same value the polygon uses)
  const r = fire.to * Math.PI / 180, el = document.createElement("div"); el.className = "threat";
  let html = "";
  if (kind === "fire") {
    html += `<b>Affected area:</b> ${Math.round(Math.PI * fire.a * fire.b * 100).toLocaleString()} ha now · ${Math.round(Math.PI * fire.a24 * fire.b24 * 100).toLocaleString()} ha projected (24 h)<br>`;
    html += `<b>Spread vector:</b> ~${ros.toFixed(1)} km/h toward ${compass(fire.to)} (${Math.round(fire.to)}°), wind ${Math.round(windSpeed)} km/h from ${compass(windFrom)}<br><b>Critical-infrastructure proximity</b><table>`;
    html += assets.map(a => { const [dx, dy] = kmXY(a.lon, a.lat), x = dx * Math.sin(r) + dy * Math.cos(r), y = dx * Math.cos(r) - dy * Math.sin(r);
      const d = Math.hypot((x - fire.off) / fire.a, y / fire.b), edge = Math.max(0, (d - 1) * Math.min(fire.a, fire.b)), eta = edge / ros;
      return { n: a.name, edge, eta }; }).sort((p, q) => p.eta - q.eta).slice(0, 4)
      .map(a => `<tr><td>${a.n}</td><td>${a.edge.toFixed(0)} km</td><td>${a.eta < 1 ? "<1" : a.eta.toFixed(0)} h</td><td class="${a.eta < 6 ? "hi" : a.eta < 24 ? "md" : "lo"}">${a.eta < 6 ? "HIGH" : a.eta < 24 ? "MEDIUM" : "LOW"}</td></tr>`).join("") + "</table>";
  } else if (kind === "burn") {
    html += `<b>Initial burn area:</b> ${Math.round(burnHa).toLocaleString()} ha – ignition at the strongest VIIRS hotspot (${top.frp} MW)<br>`;
    html += `<b>Now burning:</b> ${Math.round(Math.PI * fire.a * fire.b * 100).toLocaleString()} ha incl. simulated spread, heading ${compass(fire.to)} at ~${ros.toFixed(1)} km/h`;
  } else {
    const m = at.median_cm == null ? null : Number(at.median_cm), ha = Number(at.area_ha) || 0, ns = Number(at.n_stations) || 0;
    const cls = m == null ? "no recent sensor data" : m < -80 ? "critical" : m < -40 ? "dry – elevated" : "wet – low";
    html += `<b>Peat unit area:</b> ${Math.round(ha).toLocaleString()} ha<br><b>Median water table:</b> ${m == null ? "–" : m + " cm"} → fire risk <b>${cls}</b><br>`;
    html += `<b>Hectares at elevated risk:</b> ${m != null && m < -40 ? Math.round(ha).toLocaleString() : 0} ha<br><b>Spread if ignited:</b> ~${ros.toFixed(1)} km/h toward ${compass(fire.to)}<br>Sensors in unit: ${ns}`;
  }
  el.innerHTML = html + "<br><small>Simulated estimate for demonstration.</small>";
  if (kind !== "khg") { const b = document.createElement("calcite-button"); b.appearance = "transparent"; b.scale = "s"; b.iconStart = "information";
    b.textContent = "How is this simulated?"; b.addEventListener("click", () => { $("sci").expanded = true; }); el.appendChild(b); }
  return el;
}

function assetCard(i) {   // popup for a critical-infrastructure point
  const a = assets[i], el = document.createElement("div"); el.className = "threat";
  let edge = Infinity; spreadRing.forEach(([x, y]) => { edge = Math.min(edge, Math.hypot((x - a.lon) * 111.3 * cl0, (y - a.lat) * 110.6)); });
  const inSp = inside(spreadRing, a.lon, a.lat), inPr = inside(projRing, a.lon, a.lat), eta = edge / headROS();
  const [dx, dy] = kmXY(a.lon, a.lat), brg = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360, dev = Math.abs(((brg - fire.to + 540) % 360) - 180);
  const status = inSp ? '<span class="hi">INSIDE the fire perimeter</span>' : inPr ? `<span class="md">Inside the 24 h projected spread – about ${eta < 1 ? "<1" : eta.toFixed(0)} h to reach</span>`
    : `<span class="lo">Clear – ${edge.toFixed(1)} km from the fire edge (≈${eta.toFixed(0)} h at head-fire speed)</span>`;
  el.innerHTML = `<b>${a.info}</b><br><b>Status now:</b> ${status}<br><b>Distance from ignition:</b> ${Math.hypot(dx, dy).toFixed(1)} km<br>
    <b>Smoke plume:</b> ${dev < 35 ? '<span class="hi">in the downwind plume path</span>' : dev < 70 ? '<span class="md">at the plume edge</span>' : '<span class="lo">off the plume path</span>'}<br>
    <b>Why it matters:</b> ${a.why}<br><b>Suggested action:</b> ${a.act}<br><small>Simulated asset attributes for demonstration.</small>`;
  return el;
}

// ---------- 5) CALCITE UI ----------
// 5a) Tabs (action bar). Clicking the active tab again collapses the side panel.
const acts = [...document.querySelectorAll("calcite-action[data-panel]")];
const showTab = id => { $("tabPanels").hidden = false; acts.forEach(x => { x.active = x.dataset.panel === id; $(x.dataset.panel).hidden = x.dataset.panel !== id; }); };
acts.forEach(a => a.addEventListener("click", () => {            // clicking the active tab again hides the tab card
  if (a.active && !$("tabPanels").hidden) { $("tabPanels").hidden = true; a.active = false; return; }
  showTab(a.dataset.panel); }));

// 5b) Layers widget: visibility checkbox, opacity slider, up/down ordering.
function drawLayers() {
  const box = $("layerList"); box.innerHTML = "";
  ORDER.slice().reverse().forEach(l => {
    const row = document.createElement("div"); row.className = "lrow";
    row.innerHTML = `<calcite-label layout="inline"><calcite-checkbox ${l.visible ? "checked" : ""}></calcite-checkbox>${NAMES.get(l)}</calcite-label>
      <span class="mv"><calcite-button class="up" icon-start="chevron-up" appearance="transparent" scale="s" label="Move up"></calcite-button>
      <calcite-button class="dn" icon-start="chevron-down" appearance="transparent" scale="s" label="Move down"></calcite-button></span>
      <calcite-slider min="0" max="100" value="${Math.round((l === hot ? opHot : l.opacity) * 100)}" scale="s" label="Opacity"></calcite-slider>`;
    row.querySelector("calcite-checkbox").addEventListener("calciteCheckboxChange", e => { l.visible = e.target.checked; });
    row.querySelector("calcite-slider").addEventListener("calciteSliderInput", e => { const v = e.target.value / 100; if (l === hot) opHot = v; else l.opacity = v; });
    const mv = d => { const i = ORDER.indexOf(l), j = i + d; if (j < 0 || j >= ORDER.length) return; ORDER.splice(i, 1); ORDER.splice(j, 0, l); map.reorder(l, j); drawLayers(); };
    row.querySelector(".up").addEventListener("click", () => mv(1)); row.querySelector(".dn").addEventListener("click", () => mv(-1));
    box.appendChild(row); });
}
drawLayers();

// 5c) Header filters -> definitionExpression (runs inside the layer, no JS loops over graphics).
function applyFilters() {
  selSensor = -1;                                  // changing a filter clears the single-sensor selection
  hot.definitionExpression = hotExpr(48 * (1 - T));
  tmat.definitionExpression = F.status ? `cur_status = '${F.status}'` : "1=1";
  stats(); updateChart();
}
[["fConf", "conf"], ["fStatus", "status"]].forEach(([id, k]) => $(id).addEventListener("calciteSelectChange", e => { F[k] = e.target.value; applyFilters(); }));
$("fReset").addEventListener("click", () => { F.conf = F.status = ""; ["fConf", "fStatus"].forEach(id => { $(id).value = ""; }); applyFilters(); });

// 5d) Alerts: click -> fly to the sensor / hotspot.
const events = [];
function pushAlert(msg, kind, lon, lat) {
  events.unshift({ msg: ({ crit: "🔴 ", warn: "🟠 " }[kind] || "") + msg, lon, lat, t: new Date().toLocaleTimeString() }); events.length = Math.min(events.length, 10);
  $("alerts").innerHTML = events.map((e, i) => `<calcite-list-item data-i="${i}" label="${e.msg}" description="${e.t}${e.lon != null ? " · click to zoom" : ""}"></calcite-list-item>`).join("");
}
$("alerts").addEventListener("click", e => { const it = e.target.closest("calcite-list-item"), ev = it && events[it.dataset.i];
  if (ev && ev.lon != null) view.goTo({ target: new Point({ longitude: ev.lon, latitude: ev.lat }), zoom: 12, tilt: 60 }, { duration: 1800 }).catch(() => {}); });
S.map((s, i) => i).sort((a, b) => cur[b] - cur[a]).slice(0, 2).forEach(i => pushAlert(`Sensor ${S[i].id} at ${cur[i]} cm (${statusOf(cur[i]).toLowerCase()})`, "", S[i].lon, S[i].lat));
H.slice().sort((a, b) => a.frp - b.frp).slice(-3).forEach(h => pushAlert(`VIIRS hotspot ${h.frp} MW (${h.conf} confidence)`, "", h.lon, h.lat));

// 5e) Chart (Chart.js): average water table per day for the filtered stations vs thresholds.
const chart = new Chart($("chart"), { type: "line",
  data: { labels: DAYS, datasets: [
    { label: "Avg TMAT (cm)", data: [], borderColor: "#5eead4", backgroundColor: "rgba(94,234,212,.15)", fill: true, tension: .3, pointRadius: 2 },
    { label: "Caution -40", data: DAYS.map(() => -40), borderColor: "#facc15", borderDash: [5, 4], pointRadius: 0, borderWidth: 1 },
    { label: "Critical -80", data: DAYS.map(() => -80), borderColor: "#ef4444", borderDash: [5, 4], pointRadius: 0, borderWidth: 1 }] },
  options: { maintainAspectRatio: false, animation: false, plugins: { legend: { labels: { color: "#9db8d0", boxWidth: 12, font: { size: 10 } } } },
    scales: { x: { ticks: { color: "#7f9bb5", font: { size: 9 } } }, y: { ticks: { color: "#7f9bb5", font: { size: 9 } } } } } });
function updateChart() {
  const one = selSensor >= 0, idx = one ? [selSensor] : sel();       // one clicked sensor, or every sensor passing the filters
  chart.data.datasets[0].label = one ? `Sensor ${S[selSensor].id} (cm)` : "Avg TMAT (cm)";
  chart.data.datasets[0].data = DAYS.map((_, k) => idx.length ? +(idx.reduce((t, i) => t + (k < 7 ? S[i].series[k] : cur[i]), 0) / idx.length).toFixed(1) : null);
  $("wtBlock").heading = one ? `Water table – sensor ${S[selSensor].id}` : "Water table – 7 days vs thresholds"; $("clearSel").hidden = !one;
  chart.update("none"); }

// 5e2) Risk matrix grid (rows = peat dryness, columns = hotspot count)
for (let r = 2; r >= 0; r--) for (let c = 0; c < 3; c++) { const d = document.createElement("div"); d.className = "s" + (r + c); d.dataset.r = r; d.dataset.c = c; $("matrix").appendChild(d); }

// 5e3) Click a TMAT column -> chart + card show that sensor only (the default popup still opens too)
view.on("click", async e => {
  const hit = (await view.hitTest(e, { include: [tmat] })).results.find(x => (x.graphic && x.graphic.layer === tmat) || x.layer === tmat);
  if (!hit) return;
  selSensor = S.findIndex(s => s.id === hit.graphic.attributes.sensor_id); showTab("p-overview"); updateChart(); stats(); });
$("clearSel").addEventListener("click", () => { selSensor = -1; updateChart(); stats(); });

// 5e4) Search tool: look up peatland units and sensors by name (default geocoder needs an API key, so it is off)
try { const se = document.querySelector("arcgis-search"); if (se.componentOnReady) await se.componentOnReady();
  se.includeDefaultSources = false;
  se.sources = [{ layer: khg, searchFields: ["name"], displayField: "name", exactMatch: false, outFields: ["*"], name: "Peatland units", placeholder: "Search peatland unit" },
    { layer: tmat, filter: { where: "slice = 7" }, searchFields: ["sensor_id", "name"], displayField: "sensor_id", exactMatch: false, outFields: ["*"], name: "TMAT sensors", placeholder: "Search sensor ID" }];
} catch (err) { console.warn("Search sources not set", err); }

// 5g) Bookmarks (scene tool): fly to the predicted spread area, the ignition point or the overview.
//     The spread bookmark is recomputed from the CURRENT projected polygon each time it is clicked.
const ringBox = r => r.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [999, 999, -999, -999]);
function flyTo(which) {
  if (which === "home") return view.goTo(HOME, { duration: 1800 });
  const bx = ringBox(which === "spread" ? projRing : burnRing), lon = (bx[0] + bx[2]) / 2, lat = (bx[1] + bx[3]) / 2;
  const sizeKm = Math.max((bx[2] - bx[0]) * 111.3 * cl0, (bx[3] - bx[1]) * 110.6), z = Math.max(12000, sizeKm * 1300);
  const back = z * 1.43 / 1000, r = fire.to * Math.PI / 180;     // camera sits behind the fire and looks along the spread direction (tilt 55°)
  return view.goTo(new Camera({ position: { longitude: lon - back * Math.sin(r) / (111.3 * cl0), latitude: lat - back * Math.cos(r) / 110.6, z }, heading: fire.to, tilt: 55 }), { duration: 2200 });
}
$("bmList").innerHTML = [["spread", "Predicted fire spread area (24 h)"], ["burn", "Initial burn area"], ["home", "Full overview"]]
  .map(([k, l]) => `<calcite-list-item data-k="${k}" label="${l}" description="Click to pan and zoom"></calcite-list-item>`).join("");
$("bmList").addEventListener("click", e => { const it = e.target.closest("calcite-list-item"); if (it) flyTo(it.dataset.k).catch(() => {}); });

// 5h) Basemap switcher: a gallery limited to basemaps that need no API key.
try { const bg = document.querySelector("arcgis-basemap-gallery"); if (bg.componentOnReady) await bg.componentOnReady();
  bg.source = new LocalBasemapsSource({ basemaps: ["satellite", "hybrid", "dark-gray-vector", "gray-vector", "topo-vector", "streets-vector"].map(id => Basemap.fromId(id)) });
} catch (err) { console.warn("Basemap gallery source not set", err); }

// 5i) Faint SMOKE plume from the burn area. ~36 soft puffs are projected to the screen with view.toScreen and drawn on a
//     half-resolution 2D canvas over the scene. No 3D graphics are rebuilt, so the scene stays smooth. The plume leans downwind.
const cvs = $("smoke"), ctx = cvs.getContext("2d"), puff = document.createElement("canvas"); puff.width = puff.height = 64;
{ const g = puff.getContext("2d"), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, "rgba(225,225,230,1)"); gr.addColorStop(.5, "rgba(200,200,210,.45)"); gr.addColorStop(1, "rgba(190,190,200,0)"); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); }
const NP = 36, jit = Array.from({ length: NP }, () => { const a = rnd() * 6.283, r = Math.sqrt(rnd()) * R0 * .7; return [r * Math.sin(a), r * Math.cos(a)]; });
const sp = new Point({ x: 0, y: 0, z: 0, hasZ: true, spatialReference: { wkid: 4326 } });   // one reused point = no garbage
let smokeOn = true, lastSmoke = 0;
const scr = (lon, lat, z) => { sp.x = lon; sp.y = lat; sp.z = z; return view.toScreen(sp); };
function drawSmoke(t) {
  if (t - lastSmoke < 33) return; lastSmoke = t;                                              // ~30 fps
  const w = cvs.clientWidth >> 1, h = cvs.clientHeight >> 1; if (cvs.width !== w) { cvs.width = w; cvs.height = h; }
  ctx.clearRect(0, 0, cvs.width, cvs.height); if (!smokeOn || !fireLayer.visible) return;
  const o = scr(origin.longitude, origin.latitude, 0), o1 = scr(origin.longitude + 1 / (111.3 * cl0), origin.latitude, 0); if (!o || !o1) return;
  const pxKm = Math.hypot(o1.x - o.x, o1.y - o.y), rd = fire.to * Math.PI / 180, sx = Math.sin(rd), sy = Math.cos(rd), reach = 6 + windSpeed * .6;   // km
  for (let i = 0; i < NP; i++) {
    const age = (t / 16000 + i / NP) % 1, d = age * reach, e = jit[i][0] + d * sx, n = jit[i][1] + d * sy;
    const p = scr(origin.longitude + e / (111.3 * cl0), origin.latitude + n / 110.6, 200 + age * 3200); if (!p) continue;   // rises as it drifts
    const rad = (R0 * .35 + age * 2.4) * pxKm * .5;
    ctx.globalAlpha = .22 * Math.pow(Math.sin(Math.PI * age), .8);                           // faint, fades in and out
    ctx.drawImage(puff, p.x * .5 - rad, p.y * .5 - rad, rad * 2, rad * 2); }
  ctx.globalAlpha = 1;
}
$("smokeChk").addEventListener("calciteCheckboxChange", e => { smokeOn = e.target.checked; });

// 5f) Playback controls
$("play").addEventListener("click", () => { playing = !playing; if (playing && T >= .999) T = 0; $("play").iconStart = playing ? "pause" : "play"; });
let pend = false;
$("slider").addEventListener("calciteSliderInput", e => { T = e.target.value / 1000; if (!pend) { pend = true; requestAnimationFrame(() => { pend = false; applyTime(); }); } });

// ---------- 6) ONE light loop (~8 updates/s) ----------
let last = 0, acc = 0;
function loop(t) {
  requestAnimationFrame(loop); acc += t - last; last = t; if (acc < 125) return; acc = 0;
  if (PULSE) hot.opacity = opHot * (0.9 + 0.1 * Math.sin(t / 900));       // slow, subtle "breathing" (≈5.6 s cycle)
  if (playing) { T += .0005 * +$("speed").value; if (T > 1) T = 0; $("slider").value = Math.round(T * 1000); applyTime(); }
}
applyTime(); applyFilters(); requestAnimationFrame(loop);
requestAnimationFrame(function sl(t) { requestAnimationFrame(sl); drawSmoke(t); });
setTimeout(() => { alertsReady = true; checkImpacts(); }, 3000);   // wait for the wind lookup so impact alerts use the final asset positions
})();
