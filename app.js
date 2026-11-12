/* =====================================================================
   KALIMANTAN WILDFIRE COMMAND CENTER – app.js  (ArcGIS Maps SDK 5.x + Calcite)
   PERFORMANCE RULES used here (the old version broke all of them):
   1. No graphic/symbol is rebuilt per frame – styling lives in renderers (GPU), not in JS objects.
   2. One requestAnimationFrame loop, throttled to ~8 updates/s, doing tiny work (one opacity + one polygon).
   3. Data changes are batched: telemetry = ONE applyEdits every 5 s; filters = definitionExpression.
   4. The wind FlowRenderer runs at lower density (GPU cost scales with streamline count).
   Sections: 1 Setup · 2 Data & layers · 3 Simulation · 4 Threat analysis · 5 UI · 6 Loop
   ===================================================================== */
(async () => {
const [FeatureLayer, GeoJSONLayer, GraphicsLayer, Graphic, ImageryTileLayer, DimensionalDefinition, Camera, Extent, Point, TileLayer] =
  await $arcgis.import(["@arcgis/core/layers/FeatureLayer.js", "@arcgis/core/layers/GeoJSONLayer.js",
    "@arcgis/core/layers/GraphicsLayer.js", "@arcgis/core/Graphic.js", "@arcgis/core/layers/ImageryTileLayer.js",
    "@arcgis/core/layers/support/DimensionalDefinition.js", "@arcgis/core/Camera.js",
    "@arcgis/core/geometry/Extent.js", "@arcgis/core/geometry/Point.js", "@arcgis/core/layers/TileLayer.js"]);

const $ = id => document.getElementById(id);
const set = (id, v) => { const e = $(id); if (e.textContent !== String(v)) e.textContent = v; };   // write DOM only if changed
const rnd = (s => () => (s = s * 16807 % 2147483647) / 2147483647)(42);                         // repeatable "random"
const PULSE = true;               // gentle hotspot "breathing" (set false to disable)
const REG = { "Kalimantan Tengah": "Central Kalimantan", "Kalimantan Barat": "West Kalimantan",
  "Kalimantan Selatan": "South Kalimantan", "Kalimantan Timur": "East Kalimantan", "Kalimantan Utara": "North Kalimantan" };
const statusOf = v => v >= -40 ? "Normal" : v >= -80 ? "Dry" : "Critical";
const compass = b => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(((b % 360) + 360) % 360 / 45) % 8];

// ---------- 1) SETUP: 3D scene (<arcgis-scene> in index.html) ----------
const viewEl = document.querySelector("arcgis-scene");
await viewEl.viewOnReady();
const view = viewEl.view, map = viewEl.map;
view.qualityProfile = "medium";   // lighter 3D rendering = higher FPS
view.environment = { atmosphereEnabled: false, starsEnabled: false, background: { type: "color", color: "#050a12" },
  lighting: { type: "sun", date: new Date(Date.UTC(2026, 9, 15, 1, 0)), directShadowsEnabled: false } };   // low morning sun = visible relief
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
  attributes: { OBJECTID: i * 8 + k + 1, sensor_id: s.id, name: s.name, prov: s.prov, slice: k, day: DAYS[k],
    water_cm: v, cur_status: statusOf(cur[i]), battery: Math.round(55 + rnd() * 45) } }))));
const tmat = new FeatureLayer({
  title: "TMAT sensors", source: tmFeats, objectIdField: "OBJECTID", geometryType: "point", hasZ: true,
  spatialReference: { wkid: 4326 }, elevationInfo: { mode: "relative-to-ground" },
  fields: [["OBJECTID", "oid"], ["sensor_id", "string"], ["name", "string"], ["prov", "string"], ["slice", "integer"],
    ["day", "string"], ["water_cm", "double"], ["cur_status", "string"], ["battery", "integer"]].map(([name, type]) => ({ name, type })),
  renderer: { type: "simple",
    symbol: { type: "point-3d", symbolLayers: [{ type: "object", resource: { primitive: "cylinder" }, anchor: "bottom",
      width: 3200, height: 2100, depth: 3200, material: { color: "#22d3ee" } }] },
    visualVariables: [{ type: "color", field: "water_cm", stops: [{ value: -100, color: "#ff2d2d" },
      { value: -80, color: "#ff7a1a" }, { value: -40, color: "#ffd23f" }, { value: 0, color: "#22d3ee" }] }] },
  popupTemplate: { title: "TMAT {sensor_id} – {day}", content: "<b>{name}</b><br>Water level that day: <b>{water_cm} cm</b><br>Sensor now: {cur_status}<br>Battery: {battery}%" }
});

// 2b) VIIRS HOTSPOTS (simulated). A FeatureLayer styled by a renderer: size AND colour follow fire
//     radiative power (FRP, MW): small yellow = weak, larger orange/red = intense. Semi-transparent, no flashing.
const dry = S.filter((s, i) => cur[i] < -70), pool = dry.length ? dry : S, H = [];
for (let i = 0; i < 60; i++) { const b = pool[Math.floor(rnd() * pool.length)], frp = Math.round(4 + rnd() * rnd() * 90);
  H.push({ lon: b.lon + (rnd() - .5) * .3, lat: b.lat + (rnd() - .5) * .3, frp, ago: rnd() * 48, conf: frp > 25 ? "high" : "nominal", prov: b.prov }); }
const hot = new FeatureLayer({
  title: "VIIRS hotspots", objectIdField: "OBJECTID", geometryType: "point", spatialReference: { wkid: 4326 },
  elevationInfo: { mode: "relative-to-ground" },
  source: H.map((h, i) => new Graphic({ geometry: { type: "point", longitude: h.lon, latitude: h.lat },
    attributes: { OBJECTID: i + 1, frp: h.frp, hours_ago: h.ago, conf: h.conf, prov: h.prov, time: new Date(Date.now() - h.ago * 36e5).toLocaleString() } })),
  fields: [["OBJECTID", "oid"], ["frp", "double"], ["hours_ago", "double"], ["conf", "string"], ["prov", "string"], ["time", "string"]].map(([name, type]) => ({ name, type })),
  renderer: { type: "simple",
    symbol: { type: "point-3d", symbolLayers: [{ type: "object", resource: { primitive: "sphere" }, width: 2500, height: 2500, depth: 2500, material: { color: [255, 140, 40, 0.8] } }] },
    visualVariables: [
      { type: "size", field: "frp", valueUnit: "meters", stops: [{ value: 4, size: 1800 }, { value: 94, size: 5200 }] },
      { type: "color", field: "frp", stops: [{ value: 4, color: [255, 214, 70, 0.8] }, { value: 40, color: [255, 140, 40, 0.85] }, { value: 94, color: [235, 60, 40, 0.9] }] }] },
  popupTemplate: { title: "VIIRS thermal anomaly", content: "Detected: {time}<br>Fire radiative power: <b>{frp} MW</b><br>Confidence: {conf}<br>Province: {prov}" }
});
const top = H.reduce((a, h) => h.frp > a.frp ? h : a), origin = new Point({ longitude: top.lon, latitude: top.lat });

// 2c) PEATLAND UNITS (KHG), coloured by median water level of their sensors.
const khg = new GeoJSONLayer({
  url: "data/khg_kalimantan.geojson", title: "KHG", outFields: ["*"],
  renderer: { type: "simple", symbol: { type: "polygon-3d", symbolLayers: [{ type: "fill",
      material: { color: [120, 120, 120, 0.15] }, outline: { color: [255, 255, 255, 0.3], size: 0.6 } }] },
    visualVariables: [{ type: "color", field: "median_cm", stops: [{ value: -100, color: [255, 45, 45, 0.38] },
      { value: -70, color: [255, 140, 30, 0.30] }, { value: -40, color: [250, 210, 60, 0.20] }, { value: 0, color: [40, 200, 230, 0.15] }] }] },
  popupTemplate: { title: "Area Threat Analysis – {name}", content: f => threat("khg", f.graphic.attributes) }
});

// 2d) FIRE FOOTPRINT (red) + 24 h projection (outline) – only 2 graphics; geometry replaced ~8x/s at most.
const fireLayer = new GraphicsLayer({ title: "Fire footprint" });
const pop = { title: "Area Threat Analysis – fire footprint", content: () => threat("fire") };
const footprint = new Graphic({ popupTemplate: pop, symbol: { type: "polygon-3d", symbolLayers: [{ type: "fill",
  material: { color: [255, 60, 30, 0.4] }, outline: { color: [255, 120, 30, 1], size: 2 } }] } });
const projection = new Graphic({ popupTemplate: pop, symbol: { type: "polygon-3d", symbolLayers: [{ type: "fill",
  material: { color: [255, 160, 30, 0.08] }, outline: { color: [255, 190, 60, 0.9], size: 1.5 } }] } });
fireLayer.addMany([projection, footprint]);

// 2e) CRITICAL INFRASTRUCTURE (simulated) – used for the proximity-risk part of the threat card.
const assets = ["Settlement", "Trans-Kalimantan road", "Oil-palm mill", "Power substation", "Canal weir", "Airstrip"].map((n, i) => {
  const ang = (i * 60 + rnd() * 40) * Math.PI / 180, d = 14 + rnd() * 55;
  return { name: n + " (sim)", lon: origin.longitude + d * Math.sin(ang) / (111.3 * Math.cos(origin.latitude * Math.PI / 180)), lat: origin.latitude + d * Math.cos(ang) / 110.6 }; });
const infra = new GraphicsLayer({ title: "Infrastructure", elevationInfo: { mode: "relative-to-ground", offset: 2500 } });
infra.addMany(assets.map(a => new Graphic({ geometry: { type: "point", longitude: a.lon, latitude: a.lat },
  attributes: { name: a.name }, popupTemplate: { title: "{name}", content: "Simulated critical-infrastructure asset" },
  symbol: { type: "point-3d", symbolLayers: [{ type: "icon", resource: { primitive: "kite" }, size: 10, material: { color: "#22d3ee" }, outline: { color: "white", size: 1 } }] } })));

// 2f) WIND FLOW – Esri FlowRenderer on an ImageryTileLayer (Living Atlas monthly-average wind, Vector-MagDir).
//     Replace WIND_URL with your own Vector-UV/MagDir image service for live wind.
const WIND_URL = "https://tiledimageservices.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Average_Wind_Speeds_Month_Altitude/ImageServer";
const windDef = [new DimensionalDefinition({ variableName: "Vector-MagDir", dimensionName: "StdPressure", values: [100000], isSlice: true }),
  new DimensionalDefinition({ variableName: "Vector-MagDir", dimensionName: "StdTime", values: [10], isSlice: true })];   // surface, October
const windFlow = new ImageryTileLayer({ url: WIND_URL, title: "Wind flow", multidimensionalDefinition: windDef,
  elevationInfo: { mode: "relative-to-ground", offset: 800 },
  renderer: { type: "flow", density: 0.5, trailLength: 20, maxPathLength: 40, flowSpeed: 3, trailWidth: 2,   // lighter than before = less GPU work
    visualVariables: [{ type: "color", field: "Magnitude", stops: [{ value: 0, color: [30, 120, 255, 1] }, { value: 2, color: [34, 211, 238, 1] },
      { value: 4, color: [94, 234, 212, 1] }, { value: 7, color: [232, 255, 138, 1] }, { value: 12, color: [255, 255, 255, 1] }] }] } });

// Terrain hillshade (draped on the ground) makes relief readable under the dark basemap.
const hill = new TileLayer({ url: "https://services.arcgisonline.com/arcgis/rest/services/Elevation/World_Hillshade/MapServer", title: "Terrain hillshade", opacity: 0.3 });
// Draw order, bottom -> top. The Layers panel can change it.
const ORDER = [hill, khg, windFlow, infra, fireLayer, tmat, hot];
const NAMES = new Map([[hill, "Terrain hillshade"], [khg, "Peatland hydrological units (KHG)"], [windFlow, "Wind flow"], [infra, "Critical infrastructure (sim)"],
  [fireLayer, "Fire footprint"], [tmat, "TMAT groundwater sensors"], [hot, "VIIRS hotspots"]]);
map.addMany(ORDER);

// ---------- 3) SIMULATION STATE ----------
let T = 1, playing = false, windFrom = 225, windSpeed = 14, realWind = null, lastKey = -1, opHot = 1, selSensor = -1;   // T: 0 = 48 h ago … 1 = now
const F = { prov: "", conf: "", status: "" };                                                          // active filters
const fire = { a: 2, b: 1, off: 1, a24: 12, b24: 6, off24: 8, to: 45 };
const sel = () => S.map((s, i) => i).filter(i => (!F.prov || S[i].prov === F.prov) && (!F.status || statusOf(cur[i]) === F.status));
const hotExpr = ago => [`hours_ago >= ${(Math.round(ago * 2) / 2)}`, F.prov && `prov = '${F.prov}'`, F.conf && `conf = '${F.conf}'`].filter(Boolean).join(" AND ");

// Read the wind at the fire origin so cards & footprint match the streamlines (falls back to simulated wind).
windFlow.load().then(() => windFlow.identify(origin, { multidimensionalDefinition: windDef })).then(r => {
  const [mag, dir] = r.magdirValue || [];
  if (mag >= 0 && mag < 40 && dir >= 0 && dir <= 360) { realWind = { speed: mag * 3.6, from: dir }; applyTime(); }
}).catch(() => {});
windFlow.load().catch(() => pushAlert("Wind service unavailable – wind card is simulated", "warn"));

const ellipse = (c, a, b, brg, off) => {   // footprint shape stretched downwind
  const r = brg * Math.PI / 180, ring = [];
  for (let k = 0; k <= 36; k++) { const t = k / 36 * 2 * Math.PI, x = a * Math.cos(t) + off, y = b * Math.sin(t);
    ring.push([c.longitude + (x * Math.sin(r) + y * Math.cos(r)) / (111.3 * Math.cos(c.latitude * Math.PI / 180)), c.latitude + (x * Math.cos(r) - y * Math.sin(r)) / 110.6]); }
  return { type: "polygon", rings: [ring], spatialReference: { wkid: 4326 } };
};

function applyTime() {
  const ago = 48 * (1 - T);
  if (realWind) { windFrom = realWind.from; windSpeed = realWind.speed; } else { windFrom = 225 + 40 * Math.sin(T * 12.6); windSpeed = 14 + 6 * Math.sin(T * 9); }
  const a = 2 + 20 * T, a24 = a + 10, to = (windFrom + 180) % 360;
  Object.assign(fire, { a, b: a * .45, off: a * .6, a24, b24: a24 * .5, off24: a24 * .65, to });
  footprint.geometry = ellipse(origin, fire.a, fire.b, to, fire.off);
  projection.geometry = ellipse(origin, fire.a24, fire.b24, to, fire.off24);
  const key = Math.round(ago * 2); if (key !== lastKey) { lastKey = key; hot.definitionExpression = hotExpr(ago); }   // only when the visible set changes
  set("timeLabel", T >= .999 ? "Now" : "-" + ago.toFixed(0) + " h");
  const live = $("live"); live.kind = T >= .999 ? "danger" : "warning"; set("live", T >= .999 ? "LIVE" : "REPLAY");
  stats();
}

function stats() {
  const ago = 48 * (1 - T), idx = sel(), avg = idx.length ? idx.reduce((s, i) => s + cur[i], 0) / idx.length : NaN;
  const n = H.filter(h => h.ago >= ago && (!F.prov || h.prov === F.prov) && (!F.conf || h.conf === F.conf)).length;
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
  const idx = sel(), avg = idx.length ? idx.reduce((s, i) => s + cur[i], 0) / idx.length : -60;
  const dryF = Math.min(1.5, Math.max(0, (-avg - 40) / 60)), ros = Math.max(.3, windSpeed * .15) * (1 + dryF);   // estimated head-fire spread, km/h
  const r = fire.to * Math.PI / 180, el = document.createElement("div"); el.className = "threat";
  let html = "";
  if (kind === "fire") {
    html += `<b>Affected area:</b> ${Math.round(Math.PI * fire.a * fire.b * 100).toLocaleString()} ha now · ${Math.round(Math.PI * fire.a24 * fire.b24 * 100).toLocaleString()} ha projected (24 h)<br>`;
    html += `<b>Spread vector:</b> ~${ros.toFixed(1)} km/h toward ${compass(fire.to)} (${Math.round(fire.to)}°), wind ${Math.round(windSpeed)} km/h from ${compass(windFrom)}<br><b>Critical-infrastructure proximity</b><table>`;
    html += assets.map(a => { const [dx, dy] = kmXY(a.lon, a.lat), x = dx * Math.sin(r) + dy * Math.cos(r), y = dx * Math.cos(r) - dy * Math.sin(r);
      const d = Math.hypot((x - fire.off) / fire.a, y / fire.b), edge = Math.max(0, (d - 1) * Math.min(fire.a, fire.b)), eta = edge / ros;
      return { n: a.name, edge, eta }; }).sort((p, q) => p.eta - q.eta).slice(0, 4)
      .map(a => `<tr><td>${a.n}</td><td>${a.edge.toFixed(0)} km</td><td>${a.eta < 1 ? "<1" : a.eta.toFixed(0)} h</td><td class="${a.eta < 6 ? "hi" : a.eta < 24 ? "md" : "lo"}">${a.eta < 6 ? "HIGH" : a.eta < 24 ? "MEDIUM" : "LOW"}</td></tr>`).join("") + "</table>";
  } else {
    const m = at.median_cm == null ? null : Number(at.median_cm), ha = Number(at.area_ha) || 0, ns = Number(at.n_stations) || 0;
    const cls = m == null ? "no recent sensor data" : m < -80 ? "critical" : m < -40 ? "dry – elevated" : "wet – low";
    const nh = H.filter(h => h.prov === at.prov && h.ago >= 48 * (1 - T)).length;
    html += `<b>Peat unit area:</b> ${Math.round(ha).toLocaleString()} ha (${REG[at.prov] || at.prov || "–"})<br><b>Median water table:</b> ${m == null ? "–" : m + " cm"} → fire risk <b>${cls}</b><br>`;
    html += `<b>Hectares at elevated risk:</b> ${m != null && m < -40 ? Math.round(ha).toLocaleString() : 0} ha<br><b>Spread if ignited:</b> ~${ros.toFixed(1)} km/h toward ${compass(fire.to)}<br>Sensors in unit: ${ns} · active hotspots in province: ${nh}`;
  }
  el.innerHTML = html + "<br><small>Simulated estimate for demonstration.</small>"; return el;
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

// 5c) Filters -> definitionExpression (runs inside the layer, no JS loops over graphics).
[...new Set(S.map(s => s.prov))].sort().forEach(p => { const o = document.createElement("calcite-option"); o.value = p; o.label = REG[p] || p; $("fProv").appendChild(o); });
const q = v => v ? `prov = '${v}'` : "";
function applyFilters(zoom) {
  selSensor = -1;                                  // changing a filter clears the single-sensor selection
  hot.definitionExpression = hotExpr(48 * (1 - T));
  tmat.definitionExpression = [q(F.prov), F.status && `cur_status = '${F.status}'`].filter(Boolean).join(" AND ") || "1=1";
  khg.definitionExpression = q(F.prov) || "1=1";
  stats(); updateChart();
  if (zoom) { const m = S.filter(s => !F.prov || s.prov === F.prov);
    if (!F.prov) view.goTo(HOME, { duration: 1200 });
    else view.goTo(new Extent({ xmin: Math.min(...m.map(s => s.lon)), xmax: Math.max(...m.map(s => s.lon)), ymin: Math.min(...m.map(s => s.lat)),
      ymax: Math.max(...m.map(s => s.lat)), spatialReference: { wkid: 4326 } }).expand(1.5), { duration: 1200 }).catch(() => {}); }
}
[["fProv", "prov"], ["fConf", "conf"], ["fStatus", "status"]].forEach(([id, k]) => $(id).addEventListener("calciteSelectChange", e => { F[k] = e.target.value; applyFilters(k === "prov"); }));
$("fReset").addEventListener("click", () => { Object.keys(F).forEach(k => F[k] = ""); ["fProv", "fConf", "fStatus"].forEach(id => { $(id).value = ""; }); applyFilters(true); });

// 5d) Alerts: click -> fly to the sensor / hotspot.
const events = [];
function pushAlert(msg, kind, lon, lat) {
  events.unshift({ msg, lon, lat, t: new Date().toLocaleTimeString() }); events.length = Math.min(events.length, 8);
  $("alerts").innerHTML = events.map((e, i) => `<calcite-list-item data-i="${i}" label="${e.msg}" description="${e.t}${e.lon != null ? " · click to zoom" : ""}"></calcite-list-item>`).join("");
}
$("alerts").addEventListener("click", e => { const it = e.target.closest("calcite-list-item"), ev = it && events[it.dataset.i];
  if (ev && ev.lon != null) view.goTo({ target: new Point({ longitude: ev.lon, latitude: ev.lat }), zoom: 12, tilt: 60 }, { duration: 1800 }).catch(() => {}); });
S.map((s, i) => i).sort((a, b) => cur[b] - cur[a]).slice(0, 2).forEach(i => pushAlert(`Sensor ${S[i].id} at ${cur[i]} cm (${statusOf(cur[i]).toLowerCase()})`, "", S[i].lon, S[i].lat));
H.slice().sort((a, b) => a.frp - b.frp).slice(-3).forEach(h => pushAlert(`VIIRS hotspot ${h.frp} MW (${h.conf} confidence) – ${REG[h.prov] || h.prov}`, "", h.lon, h.lat));

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

// 5f) Playback controls
$("play").addEventListener("click", () => { playing = !playing; if (playing && T >= .999) T = 0; $("play").iconStart = playing ? "pause" : "play"; });
let pend = false;
$("slider").addEventListener("calciteSliderInput", e => { T = e.target.value / 1000; if (!pend) { pend = true; requestAnimationFrame(() => { pend = false; applyTime(); }); } });

// ---------- 6) ONE light loop (~8 updates/s) ----------
let last = 0, acc = 0;
function loop(t) {
  requestAnimationFrame(loop); acc += t - last; last = t; if (acc < 125) return; acc = 0;
  if (PULSE) hot.opacity = opHot * (0.86 + 0.12 * Math.sin(t / 900));       // slow, subtle "breathing" (≈5.6 s cycle)
  if (playing) { T += .0005 * +$("speed").value; if (T > 1) T = 0; $("slider").value = Math.round(T * 1000); applyTime(); }
}
applyTime(); applyFilters(false); requestAnimationFrame(loop);
})();
