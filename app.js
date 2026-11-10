/* =====================================================================
   KALIMANTAN WILDFIRE COMMAND CENTER  –  app.js
   Sections:  1) Setup  2) Data  3) Layers  4) Simulation  5) Dashboard UI
   NOTE: open this through a web server (e.g. GitHub Pages) – browsers block
   loading the data/*.json files when index.html is opened straight from disk.
   ===================================================================== */
(async () => {
  // Load the SDK classes we need (the SDK itself is loaded as a module in index.html).
  const [FeatureLayer, GeoJSONLayer, GraphicsLayer, Graphic, ImageryTileLayer, DimensionalDefinition, Camera] =
    await $arcgis.import(["@arcgis/core/layers/FeatureLayer.js", "@arcgis/core/layers/GeoJSONLayer.js",
      "@arcgis/core/layers/GraphicsLayer.js", "@arcgis/core/Graphic.js", "@arcgis/core/layers/ImageryTileLayer.js",
      "@arcgis/core/layers/support/DimensionalDefinition.js", "@arcgis/core/Camera.js"]);

  // ---------- 1) SETUP: the 3D scene (the <arcgis-scene> element in index.html) -------------
  // Its basemap ("dark-gray-vector", no API key needed) and terrain are set as attributes in index.html.
  const viewEl = document.querySelector("arcgis-scene");
  await viewEl.viewOnReady();                       // wait until the 3D view is ready
  const view = viewEl.view, map = viewEl.map;
  view.environment = { atmosphereEnabled: false, starsEnabled: false, background: { type: "color", color: "#050a12" } };
  // Starting camera: south of Central Kalimantan peatland, tilted, looking north.
  viewEl.camera = new Camera({ position: { longitude: 111.8, latitude: -5.8, z: 420000 }, tilt: 55, heading: 0 });

  // Small helpers
  const rand = (() => { let s = 42; return () => (s = (s * 16807) % 2147483647) / 2147483647; })(); // repeatable "random"
  const $ = id => document.getElementById(id);
  const compass = b => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(((b % 360) + 360) % 360 / 45) % 8];
  const statusOf = v => v >= -40 ? "Normal (wet)" : v >= -80 ? "Dry – watch" : "Critical (fire risk)";

  // ---------- 2) DATA: real SiTMAT stations (last 7 days) + KHG peatland polygons -------------
  const tma = await (await fetch("data/tma_stations.json")).json();
  {
    const stations = tma.stations;

    // ---------- 3) LAYERS ------------------------------------------------------------------

    // 3a) Peatland (KHG) risk polygons – coloured by the median water level of their sensors.
    const khg = new GeoJSONLayer({
      url: "data/khg_kalimantan.geojson", title: "Peatland hydrological units (KHG)",
      renderer: { type: "simple",
        symbol: { type: "polygon-3d", symbolLayers: [{ type: "fill",
          material: { color: [120, 120, 120, 0.15] }, outline: { color: [255, 255, 255, 0.3], size: 0.6 } }] },
        // Drier (more negative) = redder.
        visualVariables: [{ type: "color", field: "median_cm", stops: [
          { value: -100, color: [255, 45, 45, 0.38] }, { value: -70, color: [255, 140, 30, 0.30] },
          { value: -40, color: [250, 210, 60, 0.20] }, { value: 0, color: [40, 200, 230, 0.15] }] }] },
      popupTemplate: { title: "{name}", content: "{prov}<br>Area: {area_ha} ha<br>Median water level: {median_cm} cm<br>Sensors: {n_stations}" }
    });

    // 3b) TMAT sensors. In production this would be an ArcGIS Velocity StreamLayer, e.g.
    //     new StreamLayer({ url: "https://<your-velocity-host>/.../StreamServer" })
    //     Here a client-side FeatureLayer is updated every 3 s to behave the same way.
    const sensorGraphics = stations.map((s, i) => new Graphic({
      geometry: { type: "point", longitude: s.lon, latitude: s.lat },
      attributes: { OBJECTID: i + 1, sensor_id: s.id, name: s.name, water_cm: s.series[s.series.length - 1],
        battery: Math.round(55 + rand() * 45), updated: new Date().toLocaleTimeString(),
        status: statusOf(s.series[s.series.length - 1]) } }));
    const tmat = new FeatureLayer({
      title: "TMAT groundwater sensors (live)", source: sensorGraphics, objectIdField: "OBJECTID",
      geometryType: "point", spatialReference: { wkid: 4326 },
      fields: [{ name: "OBJECTID", type: "oid" }, { name: "sensor_id", type: "string" }, { name: "name", type: "string" },
        { name: "water_cm", type: "double" }, { name: "battery", type: "integer" }, { name: "updated", type: "string" },
        { name: "status", type: "string" }],
      // Glowing pillars; colour is driven by water_cm: cyan = wet, yellow = dry, red = critical.
      renderer: { type: "simple",
        symbol: { type: "point-3d", symbolLayers: [{ type: "object", resource: { primitive: "cylinder" },
          width: 1800, height: 9000, material: { color: "#22d3ee" } }] },
        visualVariables: [{ type: "color", field: "water_cm", stops: [
          { value: -100, color: "#ff2d2d" }, { value: -80, color: "#ff7a1a" },
          { value: -40, color: "#ffd23f" }, { value: 0, color: "#22d3ee" }] }] },
      popupTemplate: { title: "TMAT sensor {sensor_id}",
        content: "<b>{name}</b><br>Water level: <b>{water_cm} cm</b> – {status}<br>Battery: {battery}%<br>Last telemetry: {updated}" }
    });

    // 3c) VIIRS hotspots (simulated). Placed near the driest sensors; size follows fire radiative power.
    const hotLayer = new GraphicsLayer({ title: "VIIRS hotspots", elevationInfo: { mode: "relative-to-ground" } });
    const dry = stations.filter(s => s.series[s.series.length - 1] < -70);
    const base = dry.length ? dry : stations;
    for (let i = 0; i < 60; i++) {
      const b = base[Math.floor(rand() * base.length)], frp = 4 + rand() * rand() * 90, ago = rand() * 48;
      hotLayer.add(new Graphic({
        geometry: { type: "point", longitude: b.lon + (rand() - .5) * .3, latitude: b.lat + (rand() - .5) * .3 },
        attributes: { frp: Math.round(frp), hoursAgo: ago, size: 1500 + frp * 55, phase: rand() * 6,
          time: new Date(Date.now() - ago * 3600e3).toLocaleString(), conf: frp > 30 ? "high" : "nominal" },
        popupTemplate: { title: "VIIRS thermal anomaly", content: "Detected: {time}<br>Fire radiative power: <b>{frp} MW</b><br>Confidence: {conf}" } }));
    }
    // The strongest hotspot is where our simulated fire footprint starts.
    const origin = hotLayer.graphics.toArray().reduce((a, g) => g.attributes.frp > a.attributes.frp ? g : a).geometry;

    // 3d) Simulated fire footprint (red) and 24 h projection (orange outline), stretched downwind.
    const fireLayer = new GraphicsLayer({ title: "Fire spread footprint" });
    const footprint = new Graphic({ symbol: { type: "polygon-3d", symbolLayers: [{ type: "fill",
      material: { color: [255, 50, 20, 0.45] }, outline: { color: [255, 120, 30, 1], size: 2 } }] } });
    const projection = new Graphic({ symbol: { type: "polygon-3d", symbolLayers: [{ type: "fill",
      material: { color: [255, 160, 30, 0.08] }, outline: { color: [255, 190, 60, 0.9], size: 1.5 } }] } });
    fireLayer.addMany([projection, footprint]);

    // 3f) Fallback wind: 80 moving "streaks" (short lines) that drift in the current wind direction.
    const windLayer = new GraphicsLayer({ title: "Wind particles", elevationInfo: { mode: "absolute-height" } });
    const TRAIL = 9, parts = [];
    for (let i = 0; i < 80; i++) {
      const lon = 109.5 + rand() * 5.5, lat = -4 + rand() * 4.5;
      parts.push({ pts: Array(TRAIL).fill([lon, lat]), g: new Graphic({ symbol: { type: "line-3d",
        symbolLayers: [{ type: "line", size: 1.6, material: { color: [140, 225, 255, 0.75] } }] } }) });
    }
    windLayer.addMany(parts.map(p => p.g));
    windLayer.visible = false;   // fallback only: hidden while the FlowRenderer layer works
    // 3e) WIND FLOW – Esri's FlowRenderer on an ImageryTileLayer (animated streamlines draped in 3D).
    //     Data: Living Atlas "Global Average Wind Speeds by Month and Altitude" (a Vector-MagDir image service).
    //     It holds monthly AVERAGES (2005-2024), not live wind. To go real-time, point WIND_URL at your own
    //     Vector-UV / Vector-MagDir tiled image service (e.g. a forecast model published from ArcGIS Pro).
    const WIND_URL = "https://tiledimageservices.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Global_Average_Wind_Speeds_Month_Altitude/ImageServer";
    const WIND_PRESSURE = 100000, WIND_MONTH = 10;   // 100000 Pa = surface winds; month 10 = October (slices: 1, 4, 7, 10)
    const windDef = [
      new DimensionalDefinition({ variableName: "Vector-MagDir", dimensionName: "StdPressure", values: [WIND_PRESSURE], isSlice: true }),
      new DimensionalDefinition({ variableName: "Vector-MagDir", dimensionName: "StdTime", values: [WIND_MONTH], isSlice: true })];
    const windFlow = new ImageryTileLayer({
      url: WIND_URL, title: "Wind flow (FlowRenderer)", multidimensionalDefinition: windDef,
      elevationInfo: { mode: "relative-to-ground", offset: 1500 },   // float 1.5 km above the terrain
      renderer: { type: "flow", density: 1, trailLength: 30, maxPathLength: 60, flowSpeed: 3, trailWidth: 2.5,
        // Colour the streamlines by wind speed (m/s): blue = calm, yellow/white = strong.
        visualVariables: [{ type: "color", field: "Magnitude", stops: [
          { value: 0, color: [30, 120, 255, 1] }, { value: 2, color: [34, 211, 238, 1] }, { value: 4, color: [94, 234, 212, 1] },
          { value: 7, color: [232, 255, 138, 1] }, { value: 12, color: [255, 255, 255, 1] }] }] }
    });
    // Read the wind at the fire origin so the dashboard card and the fire footprint use the same wind
    // as the streamlines. If this lookup fails we silently keep the simulated wind.
    let realWind = null;
    windFlow.load().then(() => windFlow.identify(origin, { multidimensionalDefinition: windDef })).then(r => {
      const [mag, dir] = r.magdirValue || [];
      if (mag >= 0 && mag < 40 && dir >= 0 && dir <= 360) { realWind = { speed: mag * 3.6, from: dir }; applyTime(); }
    }).catch(() => {});
    // Safety net: if the wind service cannot be loaded, show the animated particle streaks instead.
    const useFallback = () => { windFlow.visible = false; windLayer.visible = true;
      pushEvent("Wind service unavailable - showing particle fallback", "warn"); };
    windFlow.load().catch(useFallback); view.whenLayerView(windFlow).catch(useFallback);
    map.addMany([khg, windFlow, tmat, fireLayer, windLayer, hotLayer]);

    // ---------- 4) SIMULATION STATE & LOOP ------------------------------------------------------
    let T = 1, playing = false, clock = 0;            // T: 0 = 48 h ago … 1 = now
    let windFrom = 225, windSpeed = 14;               // wind blowing FROM south-west at 14 km/h
    const events = [];

    // Build an ellipse (list of lon/lat) pointing in compass bearing `brg` – used for the fire shape.
    function ellipse(c, aKm, bKm, brg, off) {
      const r = brg * Math.PI / 180, ring = [];
      for (let k = 0; k <= 40; k++) {
        const t = k / 40 * 2 * Math.PI, x = aKm * Math.cos(t) + off, y = bKm * Math.sin(t);
        const e = x * Math.sin(r) + y * Math.cos(r), n = x * Math.cos(r) - y * Math.sin(r);
        ring.push([c.longitude + e / (111.3 * Math.cos(c.latitude * Math.PI / 180)), c.latitude + n / 110.6]);
      }
      return { type: "polygon", rings: [ring], spatialReference: { wkid: 4326 } };
    }

    // Re-draw everything that depends on the playback time T.
    function applyTime() {
      const ago = 48 * (1 - T);
      if (realWind) { windFrom = realWind.from; windSpeed = realWind.speed; }            // wind read from the flow data
      else { windFrom = 225 + 40 * Math.sin(T * 12.6); windSpeed = 14 + 6 * Math.sin(T * 9); }  // simulated
      let n = 0;
      hotLayer.graphics.forEach(g => { g.visible = g.attributes.hoursAgo >= ago; if (g.visible) n++; });
      const to = windFrom + 180, a = 2 + 20 * T, a24 = a + 10;       // footprint grows with time
      footprint.geometry = ellipse(origin, a, a * .45, to, a * .6);
      projection.geometry = ellipse(origin, a24, a24 * .5, to, a24 * .65);
      $("kHot").textContent = n; $("kWind").textContent = Math.round(windSpeed);
      $("kDir").textContent = "km/h from " + compass(windFrom) + (realWind ? " (Oct avg)" : "");
      $("timeLabel").textContent = T >= .999 ? "Now" : "-" + ago.toFixed(0) + " h";
      $("liveBadge").className = T >= .999 ? "" : "replay";
      $("liveBadge").textContent = T >= .999 ? "● LIVE" : "● REPLAY";
      updateRisk(n);
    }

    // Every 3 s: new simulated telemetry for each sensor (small random walk), pushed to the layer.
    function telemetryTick() {
      const edits = sensorGraphics.map(g => {
        const a = g.attributes, v = Math.max(-140, Math.min(10, a.water_cm + (rand() - .55) * 1.6));
        if (a.water_cm > -80 && v <= -80) pushEvent(`Sensor ${a.sensor_id} fell below -80 cm (critical)`, "crit");
        a.water_cm = +v.toFixed(1); a.status = statusOf(v); a.updated = new Date().toLocaleTimeString();
        a.battery = Math.max(5, a.battery - (rand() < .02 ? 1 : 0));
        return new Graphic({ attributes: { OBJECTID: a.OBJECTID, water_cm: a.water_cm, status: a.status, updated: a.updated, battery: a.battery } });
      });
      tmat.applyEdits({ updateFeatures: edits });
      const avg = sensorGraphics.reduce((s, g) => s + g.attributes.water_cm, 0) / sensorGraphics.length;
      $("kTma").textContent = avg.toFixed(1);
      chart.data.datasets[0].data[7] = +avg.toFixed(1); chart.update("none");
      updateRisk();
    }

    // Wind animation (10 frames per second) + pulsing hotspots.
    function frame() {
      clock += 100;
      if (playing) { T += .0006 * +$("speed").value; if (T > 1) T = 0; $("slider").value = T * 1000; applyTime(); }
      const to = (windFrom + 180) * Math.PI / 180, km = windSpeed * .04;
      if (windLayer.visible) parts.forEach(p => {
        let [lon, lat] = p.pts[p.pts.length - 1];
        lon += km * Math.sin(to) / 111.3; lat += km * Math.cos(to) / 110.6;
        if (lon < 109 || lon > 115.5 || lat < -4.3 || lat > 1) { lon = 109.5 + rand() * 5.5; lat = -4 + rand() * 4.5; p.pts = Array(TRAIL).fill([lon, lat]); }
        p.pts = p.pts.slice(1).concat([[lon, lat]]);
        p.g.geometry = { type: "polyline", hasZ: true, spatialReference: { wkid: 4326 }, paths: [p.pts.map(q => [q[0], q[1], 2500])] };
      });
      hotLayer.graphics.forEach(g => {                     // pulse = size oscillates
        if (!g.visible) return;
        const s = g.attributes.size * (1 + .3 * Math.sin(clock / 260 + g.attributes.phase));
        g.symbol = { type: "point-3d", symbolLayers: [{ type: "object", resource: { primitive: "sphere" },
          width: s, height: s, depth: s, material: { color: [255, 70 + 60 * Math.sin(clock / 260 + g.attributes.phase), 20, 0.92] } }] };
      });
    }

    // ---------- 5) DASHBOARD UI ----------------------------------------------------------------
    // Chart: real 7-day average of all Kalimantan sensors + the live "Now" point + two thresholds.
    const days = tma.dates.map(d => d.slice(5)).concat("Now");
    const avgs = tma.dates.map((_, i) => +(stations.reduce((s, x) => s + x.series[i], 0) / stations.length).toFixed(1));
    const chart = new Chart($("chart"), { type: "line",
      data: { labels: days, datasets: [
        { label: "Avg TMAT (cm)", data: avgs.concat(avgs[6]), borderColor: "#5eead4", backgroundColor: "rgba(94,234,212,.15)", fill: true, tension: .3, pointRadius: 2 },
        { label: "Caution -40", data: days.map(() => -40), borderColor: "#facc15", borderDash: [5, 4], pointRadius: 0, borderWidth: 1 },
        { label: "Critical -80", data: days.map(() => -80), borderColor: "#ef4444", borderDash: [5, 4], pointRadius: 0, borderWidth: 1 }] },
      options: { maintainAspectRatio: false, plugins: { legend: { labels: { color: "#9db8d0", boxWidth: 12, font: { size: 10 } } } },
        scales: { x: { ticks: { color: "#7f9bb5", font: { size: 9 } }, grid: { color: "rgba(255,255,255,.05)" } },
                  y: { ticks: { color: "#7f9bb5", font: { size: 9 } }, grid: { color: "rgba(255,255,255,.05)" } } } } });

    // Risk matrix: rows = how dry the peat is, columns = how many hotspots are active.
    const matrix = $("matrix");
    for (let r = 2; r >= 0; r--) for (let c = 0; c < 3; c++) {
      const d = document.createElement("div"); d.className = "s" + (r + c); d.dataset.r = r; d.dataset.c = c; matrix.appendChild(d); }
    let lastHot = 0;
    function updateRisk(n) {
      if (n !== undefined) lastHot = n;
      const avg = sensorGraphics.reduce((s, g) => s + g.attributes.water_cm, 0) / sensorGraphics.length;
      const r = avg > -40 ? 0 : avg > -70 ? 1 : 2, c = lastHot < 15 ? 0 : lastHot < 30 ? 1 : 2;
      [...matrix.children].forEach(d => d.classList.toggle("on", +d.dataset.r === r && +d.dataset.c === c));
      const lvl = ["LOW", "LOW", "MODERATE", "HIGH", "EXTREME"][r + c];
      $("riskLevel").textContent = lvl;
    }

    // Alert ticker: newest message on top, keep the last 5.
    function pushEvent(msg, cls) {
      events.unshift({ msg, cls, t: new Date().toLocaleTimeString() }); events.length = Math.min(events.length, 5);
      $("ticker").innerHTML = events.map(e => `<li class="${e.cls || ""}"><b>${e.t}</b> ${e.msg}</li>`).join("");
    }
    pushEvent("VIIRS pass detected new thermal anomalies near Katingan peat dome", "warn");
    pushEvent("Velocity feed connected – 150 TMAT sensors reporting");

    // Playback controls
    $("play").onclick = () => { playing = !playing; $("play").textContent = playing ? "❚❚" : "▶"; if (playing && T >= .999) T = 0; };
    $("slider").oninput = e => { T = e.target.value / 1000; applyTime(); };

    // Start everything once the 3D view is ready
    view.when(() => {
      applyTime(); telemetryTick();
      setInterval(telemetryTick, 3000);   // sensor telemetry every 3 s
      setInterval(frame, 100);            // animation 10 fps
    });
  }
})();
