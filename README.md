# Kalimantan Wildfire Command Center (demo)

3D ArcGIS Maps SDK for JavaScript (5.1) demo: TMAT peatland sensors, VIIRS hotspots, FlowRenderer wind streamlines,
KHG risk polygons, fire-spread footprint, dashboard and playback bar.

**Real data:** 150 Kalimantan TMAT station locations + last-7-day levels (SiTMAT, KLH) and 74 KHG polygons (in `data/`).
**Wind:** Esri FlowRenderer on the Living Atlas "Global Average Wind Speeds by Month and Altitude" service (October, surface) - a climatological average, not live. Set `WIND_URL` in `app.js` to your own Vector-UV/MagDir image service for live wind.
**Simulated:** live telemetry, VIIRS hotspots, fire footprint.
