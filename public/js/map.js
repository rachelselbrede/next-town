// Leaflet map for the route screen. Draws the ranked localities as dots sized by affinity (gold ring
// when the town over-indexes), the home city as a star, the planned loop as a coral polyline whose
// legs show drive hours on hover, and, when toggled, grey dots for the "obvious route" cities.
//
// Contract: createMap(el) -> { setLocalities, setRoute, setObvious, setHome, focus, destroy }
// Leaflet 1.9.4 is loaded as a global (window.L) by index.html; tiles come from CARTO light.

// Basemap. The build contract named CARTO light (basemaps.cartocdn.com/light_all), but as of
// October 2026 CARTO serves an "API KEY REQUIRED" watermark tile to keyless requests from any
// referrer, so the map uses Esri's keyless Light Gray Canvas instead: a base layer without labels
// plus a reference layer with place names, both attributed as Esri requires.
const TILE_BASE = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}";
const TILE_LABELS = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}";
const TILE_ATTRIBUTION = 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const TILE_MAX_ZOOM = 16;

const COLORS = { forest: "#1f4d3a", gold: "#c8962e", coral: "#e8694f", grey: "#9aa09b", white: "#ffffff" };
const US_CENTER = [38.5, -90];

// Coordinates for the usual-suspects list in data/obvious-route.json. These cities are hand-maintained
// (not from Qloo), so their coordinates live here too; Qloo-ranked localities carry their own lat/lon.
const USUAL_SUSPECT_COORDS = {
  "New York, NY": [40.7128, -74.006],
  "Brooklyn, NY": [40.6782, -73.9442],
  "Los Angeles, CA": [34.0522, -118.2437],
  "Chicago, IL": [41.8781, -87.6298],
  "Nashville, TN": [36.1627, -86.7816],
  "Austin, TX": [30.2672, -97.7431],
  "Philadelphia, PA": [39.9526, -75.1652],
  "Washington, DC": [38.9072, -77.0369],
  "Atlanta, GA": [33.749, -84.388],
  "Boston, MA": [42.3601, -71.0589],
  "Seattle, WA": [47.6062, -122.3321],
  "Portland, OR": [45.5152, -122.6784],
  "Denver, CO": [39.7392, -104.9903],
  "San Francisco, CA": [37.7749, -122.4194],
  "Minneapolis, MN": [44.9778, -93.265],
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtHours = (h) => (h >= 10 ? Math.round(h) : Math.round(h * 10) / 10) + " h";
const fmtMiles = (m) => Math.round(m).toLocaleString() + " mi";
const fmtPop = (p) => (typeof p === "number" ? p.toLocaleString() : "—");

export function createMap(el) {
  const L = window.L;
  if (!L) throw new Error("Leaflet did not load; the map needs cdnjs to be reachable.");

  const map = L.map(el, { zoomControl: true, scrollWheelZoom: false, attributionControl: true }).setView(US_CENTER, 4);
  L.tileLayer(TILE_BASE, { attribution: TILE_ATTRIBUTION, maxZoom: TILE_MAX_ZOOM }).addTo(map);
  L.tileLayer(TILE_LABELS, { maxZoom: TILE_MAX_ZOOM, opacity: 0.85, pane: "shadowPane" }).addTo(map);
  // Scroll-wheel zoom only once the map has been clicked, so the page keeps scrolling naturally.
  map.on("focus click", () => map.scrollWheelZoom.enable());
  map.on("blur", () => map.scrollWheelZoom.disable());

  // One layer group per concern so each setter can replace just its own drawing.
  const layers = {
    obvious: L.layerGroup().addTo(map),
    localities: L.layerGroup().addTo(map),
    route: L.layerGroup().addTo(map),
    home: L.layerGroup().addTo(map),
  };

  // label -> { marker, locality } so focus(label) can find a dot, and setObvious can reuse coords.
  const dots = new Map();
  let localityList = [];
  let homePoint = null;
  let routePoints = [];

  function setLocalities(localities) {
    layers.localities.clearLayers();
    dots.clear();
    localityList = (localities || []).filter((l) => typeof l.lat === "number" && typeof l.lon === "number");
    if (!localityList.length) return;

    const affs = localityList.map((l) => l.affinity ?? 0);
    const lo = Math.min(...affs);
    const hi = Math.max(...affs);
    const radiusFor = (a) => 4 + (hi > lo ? ((a - lo) / (hi - lo)) * 10 : 5);

    // Draw lowest-ranked first so the strongest towns sit on top.
    [...localityList].reverse().forEach((loc) => {
      const marker = L.circleMarker([loc.lat, loc.lon], {
        radius: radiusFor(loc.affinity ?? 0),
        color: loc.overIndex ? COLORS.gold : COLORS.white,
        weight: loc.overIndex ? 3 : 1.5,
        fillColor: COLORS.forest,
        fillOpacity: loc.overIndex ? 0.9 : 0.7,
      });
      marker.bindTooltip(localityTip(loc), { className: "nt-tip", direction: "top", offset: [0, -4] });
      marker.addTo(layers.localities);
      dots.set(loc.label, { marker, locality: loc });
    });

    fitAll();
  }

  function localityTip(loc) {
    const why = (loc.why || []).slice(0, 3).join(" · ");
    return `<span class="tip-title">${esc(loc.label)}</span>` +
      `#${esc(loc.rank)} · affinity ${Math.round((loc.affinity ?? 0) * 100)}%` +
      (loc.overIndex ? ` · <span class="tip-gold">over-index</span>` : "") +
      `<br>pop. ${fmtPop(loc.population)}` +
      (loc.topRoom?.name ? `<br>top room: ${esc(loc.topRoom.name)}` : "") +
      (why ? `<br><span class="tip-why">because ${esc(why)}</span>` : "");
  }

  function setHome(home) {
    layers.home.clearLayers();
    homePoint = null;
    if (!home || typeof home.lat !== "number") return;
    homePoint = [home.lat, home.lon];
    const icon = L.divIcon({
      className: "marker-home",
      iconSize: [28, 28],
      iconAnchor: [14, 14],
      html: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" stroke="#fff" stroke-width="1.2" d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"/></svg>`,
    });
    L.marker(homePoint, { icon, zIndexOffset: 500 })
      .bindTooltip(`<span class="tip-title">${esc(home.label)}</span>home`, { className: "nt-tip", direction: "top" })
      .addTo(layers.home);
  }

  function setRoute(route) {
    layers.route.clearLayers();
    routePoints = [];
    if (!route || !route.stops?.length) return;
    if (route.home && typeof route.home.lat === "number") setHome(route.home);

    // Home -> stop 1 -> ... -> last stop -> home. Each leg is its own polyline so hover shows that leg.
    const points = [];
    if (homePoint) points.push({ latlng: homePoint, label: route.home.label });
    route.stops.forEach((s) => points.push({ latlng: [s.lat, s.lon], label: s.label, stop: s }));
    if (homePoint) points.push({ latlng: homePoint, label: route.home.label, returnLeg: true });
    routePoints = points.map((p) => p.latlng);

    for (let i = 1; i < points.length; i++) {
      const from = points[i - 1];
      const to = points[i];
      const stop = to.stop;
      const hours = stop ? stop.legHours : legHoursHome(route, from, to);
      const miles = stop ? stop.legMiles : null;
      const line = L.polyline([from.latlng, to.latlng], {
        color: COLORS.coral,
        weight: 4,
        opacity: 0.9,
        lineCap: "round",
        dashArray: stop?.driveDay ? "2 8" : null,
      });
      line.bindTooltip(
        `<span class="tip-title">${esc(from.label)} → ${esc(to.label)}</span>` +
          (hours != null ? `${fmtHours(hours)} est. drive` : "drive home") +
          (miles != null ? ` · ${fmtMiles(miles)}` : "") +
          (stop?.driveDay ? `<br><span class="tip-why">over the daily cap: a drive day comes first</span>` : ""),
        { className: "nt-tip", sticky: true },
      );
      line.on("mouseover", () => line.setStyle({ weight: 7 }));
      line.on("mouseout", () => line.setStyle({ weight: 4 }));
      line.addTo(layers.route);
    }

    // Day-number badges on each stop.
    route.stops.forEach((s) => {
      const icon = L.divIcon({ className: "", iconSize: [24, 24], iconAnchor: [12, 12], html: `<div class="marker-day" data-label="${esc(s.label)}">${s.day}</div>` });
      L.marker([s.lat, s.lon], { icon, zIndexOffset: 400 })
        .bindTooltip(`<span class="tip-title">Day ${s.day}: ${esc(s.label)}</span>${s.legHours ? fmtHours(s.legHours) + " est. from the last stop" : "first stop"}` +
          (s.overIndex ? ` · <span class="tip-gold">over-index</span>` : ""), { className: "nt-tip", direction: "top", offset: [0, -10] })
        .addTo(layers.route);
    });

    fitAll();
  }

  // The closing leg back home is not a RouteStop, so estimate it from the route totals when possible.
  function legHoursHome(route, from, to) {
    const stopsHours = route.stops.reduce((sum, s) => sum + (s.legHours || 0), 0);
    const rest = (route.totalHours || 0) - stopsHours;
    return rest > 0 ? rest : null;
  }

  function setObvious(cities, on) {
    layers.obvious.clearLayers();
    if (!on) return;
    (cities || []).forEach((label) => {
      const known = dots.get(label)?.locality;
      const latlng = known ? [known.lat, known.lon] : USUAL_SUSPECT_COORDS[label];
      if (!latlng) return;
      L.circleMarker(latlng, { radius: 9, color: COLORS.white, weight: 1.5, fillColor: COLORS.grey, fillOpacity: 0.85 })
        .bindTooltip(`<span class="tip-title">${esc(label)}</span>on the obvious route` + (known ? ` · Qloo rank #${esc(known.rank)}` : " · not in your top 50"), { className: "nt-tip", direction: "top" })
        .addTo(layers.obvious);
    });
  }

  function focus(label) {
    const hit = dots.get(label);
    if (!hit) return;
    map.flyTo(hit.marker.getLatLng(), Math.max(map.getZoom(), 7), { duration: 0.6 });
    hit.marker.openTooltip();
    setTimeout(() => hit.marker.closeTooltip(), 2500);
  }

  // Once the user pans or zooms by hand, resizes stop re-fitting so we never fight them.
  let userMoved = false;
  let fitting = false;
  map.on("dragstart", () => (userMoved = true));
  map.on("zoomstart", () => {
    if (!fitting) userMoved = true;
  });

  function fitAll() {
    const pts = [];
    if (routePoints.length) pts.push(...routePoints);
    else {
      dots.forEach(({ marker }) => pts.push(marker.getLatLng()));
      if (homePoint) pts.push(homePoint);
    }
    if (pts.length < 2) return;
    userMoved = false;
    fitting = true;
    // No animation: several fits can land within a few frames (localities, route, resize), and an
    // interrupted zoom animation leaves Leaflet's tiles frozen at the wrong scale.
    map.stop();
    map.fitBounds(L.latLngBounds(pts), { padding: [32, 32], maxZoom: 8, animate: false });
    setTimeout(() => (fitting = false), 0);
  }

  function destroy() {
    ro?.disconnect();
    map.remove();
  }

  // Let the container resize (phone rotation, column changes, screen switches) without leaving grey
  // tiles, and keep the whole loop in view until the user takes over.
  const ro =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          map.invalidateSize();
          if (!userMoved && el.clientWidth > 0) fitAll();
        })
      : null;
  ro?.observe(el);

  return { setLocalities, setRoute, setObvious, setHome, focus, destroy, fitAll };
}
