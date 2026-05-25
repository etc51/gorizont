const EARTH_RADIUS_M = 6371000;
const LIGHT_SPEED = 299792458;
const TILE_SIZE = 256;
const DEFAULT_FREQUENCY_MHZ = 5800;
const DEFAULT_CLEARANCE_RATIO = 0.6;
const DEFAULT_K_FACTOR = 1.33;
const EDGE_IGNORE_RATIO = 0.1;
const DEM_SAMPLE_COUNT = 60;
const CACHE_PREFIX = "rf-calc-cache-v2:";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const state = {
  placing: "A",
  zoom: 10,
  center: { lat: 48.015883, lng: 37.80285 },
  pointA: null,
  pointB: null,
  places: [],
  placeKey: "",
  placeRequestId: 0,
  placeTimer: null,
  profile: null,
  profileKey: "",
  profileRequestId: 0,
  drag: null,
};

const elements = {
  map: document.querySelector("#map"),
  distanceOut: document.querySelector("#distanceOut"),
  commentOut: document.querySelector("#commentOut"),
  setA: document.querySelector("#setA"),
  setB: document.querySelector("#setB"),
  heightA: document.querySelector("#heightA"),
};

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("./sw.js?v=20260524-final2").catch((error) => {
    console.error("Service worker registration failed", error);
  });
}

const mapLayers = document.createElement("div");
mapLayers.className = "plain-map-layers";
const placeLayer = document.createElement("div");
placeLayer.className = "plain-place-layer";
const markerLayer = document.createElement("div");
markerLayer.className = "plain-marker-layer";
const lineLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
lineLayer.classList.add("plain-line-layer");
const zoomControl = document.createElement("div");
zoomControl.className = "plain-zoom";
zoomControl.innerHTML = '<button type="button" data-zoom="in">+</button><button type="button" data-zoom="out">-</button>';

elements.map.append(mapLayers, placeLayer, lineLayer, markerLayer, zoomControl);

elements.setA.addEventListener("click", () => setPlacementMode("A"));
elements.setB.addEventListener("click", () => setPlacementMode("B"));
document.querySelector("#settings").addEventListener("input", update);

zoomControl.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  setZoom(state.zoom + (button.dataset.zoom === "in" ? 1 : -1));
});

elements.map.addEventListener("wheel", (event) => {
  event.preventDefault();
  setZoom(state.zoom + (event.deltaY < 0 ? 1 : -1));
}, { passive: false });

elements.map.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  elements.map.setPointerCapture(event.pointerId);
  state.drag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startCenterPx: latLngToPixel(state.center, state.zoom),
    moved: false,
  };
});

elements.map.addEventListener("pointermove", (event) => {
  if (!state.drag || state.drag.pointerId !== event.pointerId) return;
  const dx = event.clientX - state.drag.startX;
  const dy = event.clientY - state.drag.startY;
  if (Math.abs(dx) + Math.abs(dy) > 4) state.drag.moved = true;
  const nextCenterPx = {
    x: state.drag.startCenterPx.x - dx,
    y: state.drag.startCenterPx.y - dy,
  };
  state.center = pixelToLatLng(nextCenterPx, state.zoom);
  renderMap();
});

elements.map.addEventListener("pointerup", (event) => {
  if (!state.drag || state.drag.pointerId !== event.pointerId) return;
  const wasDrag = state.drag.moved;
  state.drag = null;
  if (wasDrag || event.target.closest(".plain-zoom")) return;
  const point = screenToLatLng(event.clientX, event.clientY);

  if (state.placing === "A") {
    state.pointA = point;
  } else {
    state.pointB = point;
  }

  refreshTerrainProfile();
  update();
  renderMap();
});

window.addEventListener("resize", renderMap);

function setPlacementMode(mode) {
  state.placing = mode;
  elements.setA.classList.toggle("active", mode === "A");
  elements.setB.classList.toggle("active", mode === "B");
}

function setZoom(zoom) {
  state.zoom = Math.max(2, Math.min(18, zoom));
  renderMap();
}

function renderMap() {
  const rect = elements.map.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const centerPx = latLngToPixel(state.center, state.zoom);
  const topLeft = {
    x: centerPx.x - rect.width / 2,
    y: centerPx.y - rect.height / 2,
  };
  const minTileX = Math.floor(topLeft.x / TILE_SIZE) - 1;
  const minTileY = Math.floor(topLeft.y / TILE_SIZE) - 1;
  const maxTileX = Math.floor((topLeft.x + rect.width) / TILE_SIZE) + 1;
  const maxTileY = Math.floor((topLeft.y + rect.height) / TILE_SIZE) + 1;
  const worldTiles = 2 ** state.zoom;
  const fragment = document.createDocumentFragment();

  for (let x = minTileX; x <= maxTileX; x += 1) {
    for (let y = minTileY; y <= maxTileY; y += 1) {
      if (y < 0 || y >= worldTiles) continue;
      const wrappedX = ((x % worldTiles) + worldTiles) % worldTiles;
      const left = Math.round(x * TILE_SIZE - topLeft.x);
      const top = Math.round(y * TILE_SIZE - topLeft.y);
      fragment.append(createTile(state.zoom, wrappedX, y, left, top));
    }
  }

  mapLayers.replaceChildren(fragment);
  schedulePlaceLoad();
  renderPlaces(topLeft);
  renderMarkersAndLine(topLeft);
}

function createTile(z, x, y, left, top) {
  const img = document.createElement("img");
  img.className = "plain-tile";
  img.alt = "";
  img.decoding = "async";
  img.draggable = false;
  img.style.transform = `translate(${left}px, ${top}px)`;
  img.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
  return img;
}

function renderPlaces(topLeft) {
  placeLayer.replaceChildren();
  if (!state.places.length) return;

  const rect = elements.map.getBoundingClientRect();
  for (const place of state.places) {
    const screen = latLngToScreen(place, topLeft);
    if (screen.x < -80 || screen.y < -24 || screen.x > rect.width + 80 || screen.y > rect.height + 24) continue;

    const label = document.createElement("div");
    label.className = `place-label place-${place.kind || "settlement"}`;
    label.textContent = place.name;
    label.style.transform = `translate(${Math.round(screen.x)}px, ${Math.round(screen.y)}px)`;
    placeLayer.append(label);
  }
}

function schedulePlaceLoad() {
  clearTimeout(state.placeTimer);
  state.placeTimer = setTimeout(loadPlaceLabels, 450);
}

async function loadPlaceLabels() {
  const bounds = getMapBounds();
  const placeKinds = getPlaceKindsForZoom(state.zoom);
  const key = [
    state.zoom,
    placeKinds,
    bounds.south.toFixed(3),
    bounds.west.toFixed(3),
    bounds.north.toFixed(3),
    bounds.east.toFixed(3),
  ].join(",");

  if (key === state.placeKey) return;
  state.placeKey = key;
  const requestId = ++state.placeRequestId;
  const cacheKey = `places:${key}`;
  const cached = readCache(cacheKey);
  if (cached) {
    state.places = cached;
    renderMap();
    return;
  }

  try {
    const query = `
      [out:json][timeout:12];
      (
        node["place"~"^(${placeKinds})$"]["name:ru"](${bounds.south},${bounds.west},${bounds.north},${bounds.east});
      );
      out tags center 120;
    `;
    const data = await fetchPlaceData(query, bounds);
    if (requestId !== state.placeRequestId) return;

    state.places = uniquePlaces((data.elements || [])
      .map((item) => ({
        lat: item.lat,
        lng: item.lon,
        name: cleanPlaceName(item.tags && item.tags["name:ru"]),
        kind: item.tags && item.tags.place,
      }))
      .filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lng) && place.name))
      .slice(0, getPlaceLimitForZoom(state.zoom));
    if (state.places.length > 0) writeCache(cacheKey, state.places);
    renderMap();
  } catch (error) {
    if (requestId !== state.placeRequestId) return;
    state.places = [];
    state.placeKey = "";
    renderMap();
    console.error(error);
  }
}

function getPlaceKindsForZoom(zoom) {
  if (zoom <= 10) return "city|town";
  if (zoom <= 12) return "city|town|village";
  return "city|town|village|hamlet|suburb";
}

function getPlaceLimitForZoom(zoom) {
  if (zoom <= 10) return 35;
  if (zoom <= 12) return 70;
  return 120;
}

function cleanPlaceName(name) {
  if (!name) return "";
  return name.replace(/\s*\(.+?\)\s*/g, "").trim();
}

function uniquePlaces(places) {
  const seen = new Set();
  return places.filter((place) => {
    const key = place.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchPlaceData(overpassQuery, bounds) {
  try {
    return await fetchOverpass(overpassQuery);
  } catch (error) {
    console.error(error);
    return await fetchWikidataPlaces(bounds);
  }
}

async function fetchOverpass(query) {
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];

  for (const endpoint of endpoints) {
    const url = `${endpoint}?${new URLSearchParams({ data: query })}`;
    try {
      const response = await fetchWithTimeout(url, 8000);
      if (!response.ok) throw new Error(`Overpass returned ${response.status}`);
      return await response.json();
    } catch (error) {
      if (endpoint === endpoints[endpoints.length - 1]) throw error;
    }
  }

  throw new Error("Overpass request failed");
}

async function fetchWikidataPlaces(bounds) {
  const query = `
    SELECT ?place ?placeLabel ?coord WHERE {
      SERVICE wikibase:box {
        ?place wdt:P625 ?coord.
        bd:serviceParam wikibase:cornerSouthWest "Point(${bounds.west} ${bounds.south})"^^geo:wktLiteral.
        bd:serviceParam wikibase:cornerNorthEast "Point(${bounds.east} ${bounds.north})"^^geo:wktLiteral.
      }
      VALUES ?type { wd:Q515 wd:Q3957 wd:Q532 wd:Q5084 wd:Q2983893 wd:Q486972 }
      ?place wdt:P31/wdt:P279* ?type.
      SERVICE wikibase:label { bd:serviceParam wikibase:language "ru". }
    }
    LIMIT 120
  `;
  const url = `https://query.wikidata.org/sparql?${new URLSearchParams({ query, format: "json" })}`;
  const response = await fetchWithTimeout(url, 10000, { headers: { Accept: "application/sparql-results+json" } });
  if (!response.ok) throw new Error(`Wikidata returned ${response.status}`);
  const data = await response.json();
  const elements = (data.results && data.results.bindings ? data.results.bindings : [])
    .map((item) => {
      const match = item.coord && item.coord.value && item.coord.value.match(/Point\(([-\d.]+) ([-\d.]+)\)/);
      return {
        lat: match ? Number(match[2]) : NaN,
        lon: match ? Number(match[1]) : NaN,
        tags: { "name:ru": item.placeLabel && item.placeLabel.value, place: "settlement" },
      };
    })
    .filter((item) => item.tags["name:ru"] && !/поселение/i.test(item.tags["name:ru"]));
  return { elements };
}

async function fetchWithTimeout(url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function getMapBounds() {
  const rect = elements.map.getBoundingClientRect();
  const topLeft = screenToLatLng(rect.left, rect.top);
  const bottomRight = screenToLatLng(rect.right, rect.bottom);
  return {
    north: topLeft.lat,
    south: bottomRight.lat,
    west: topLeft.lng,
    east: bottomRight.lng,
  };
}

function renderMarkersAndLine(topLeft) {
  markerLayer.replaceChildren();
  lineLayer.replaceChildren();

  const markerA = state.pointA ? createMarker("A", state.pointA, topLeft) : null;
  const markerB = state.pointB ? createMarker("B", state.pointB, topLeft) : null;
  if (markerA) markerLayer.append(markerA);
  if (markerB) markerLayer.append(markerB);

  if (state.pointA && state.pointB) {
    const a = latLngToScreen(state.pointA, topLeft);
    const b = latLngToScreen(state.pointB, topLeft);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", a.x);
    line.setAttribute("y1", a.y);
    line.setAttribute("x2", b.x);
    line.setAttribute("y2", b.y);
    line.setAttribute("stroke", "#0f766e");
    line.setAttribute("stroke-width", "4");
    line.setAttribute("stroke-linecap", "round");
    lineLayer.append(line);
  }
}

function createMarker(label, point, topLeft) {
  const screen = latLngToScreen(point, topLeft);
  const marker = document.createElement("div");
  marker.className = `point-icon point-${label.toLowerCase()}`;
  marker.textContent = label;
  marker.style.transform = `translate(${Math.round(screen.x - 15)}px, ${Math.round(screen.y - 15)}px)`;
  return marker;
}

function update() {
  if (!state.pointA || !state.pointB) {
    elements.distanceOut.textContent = "-";
    elements.commentOut.textContent = "Поставьте точки A и B на карте. Первый режим выбирается кнопками, затем клик по карте переносит выбранную точку.";
    return;
  }

  const distanceM = distanceBetween(state.pointA, state.pointB);
  const params = readParams();
  const requiredHeightB = state.profile
    ? calculateRequiredHeightBWithTerrain(distanceM, params, state.profile)
    : calculateRequiredHeightB(distanceM, params);

  elements.distanceOut.textContent = formatDistance(distanceM);
  elements.commentOut.textContent = buildComment(requiredHeightB);
}

function readParams() {
  return {
    frequencyMHz: DEFAULT_FREQUENCY_MHZ,
    heightA: clampNumber(elements.heightA.value, 0, 10000, 2),
    clearanceRatio: DEFAULT_CLEARANCE_RATIO,
    kFactor: DEFAULT_K_FACTOR,
  };
}

function buildComment(requiredHeightB) {
  if (!state.profile) {
    return "Идет загрузка рельефа. До загрузки DEM результат является грубой оценкой по гладкой Земле.";
  }

  const height = formatCeilMeters(requiredHeightB);
  return `Над точкой B видео расчетно пропадет ниже ${height} м над землей. Не опускаться ниже ${height} м.`;
}

function calculateRequiredHeightB(distanceM, params) {
  if (distanceM <= 0) return 0;

  const wavelengthM = LIGHT_SPEED / (params.frequencyMHz * 1_000_000);
  const effectiveEarthRadiusM = EARTH_RADIUS_M * params.kFactor;
  let required = 0;

  for (let i = 1; i <= 1000; i += 1) {
    const x = (distanceM * i) / 1000;
    const t = x / distanceM;
    if (t < EDGE_IGNORE_RATIO || t > 1 - EDGE_IGNORE_RATIO) continue;
    const d1 = x;
    const d2 = distanceM - x;
    const fresnelRadiusM = Math.sqrt((wavelengthM * d1 * d2) / distanceM);
    const earthBulgeM = (d1 * d2) / (2 * effectiveEarthRadiusM);
    const currentAContributionM = params.heightA * (1 - x / distanceM);
    const neededAtXM = params.clearanceRatio * fresnelRadiusM + earthBulgeM - currentAContributionM;
    const projectedHeightB = neededAtXM * (distanceM / x);
    required = Math.max(required, projectedHeightB);
  }

  return Math.max(0, required);
}

function calculateRequiredHeightBWithTerrain(distanceM, params, profile) {
  if (distanceM <= 0 || profile.elevations.length < 2) return 0;

  const wavelengthM = LIGHT_SPEED / (params.frequencyMHz * 1_000_000);
  const effectiveEarthRadiusM = EARTH_RADIUS_M * params.kFactor;
  const elevations = profile.elevations;
  const elevationA = elevations[0];
  const elevationB = elevations[elevations.length - 1];
  const antennaAAsl = elevationA + params.heightA;
  let required = 0;

  for (let i = 1; i < elevations.length; i += 1) {
    const t = i / (elevations.length - 1);
    if (t < EDGE_IGNORE_RATIO || t > 1 - EDGE_IGNORE_RATIO) continue;
    const d1 = distanceM * t;
    const d2 = distanceM - d1;
    const fresnelRadiusM = Math.sqrt((wavelengthM * d1 * d2) / distanceM);
    const earthBulgeM = (d1 * d2) / (2 * effectiveEarthRadiusM);
    const requiredLineAsl = elevations[i] + earthBulgeM + params.clearanceRatio * fresnelRadiusM;
    const fixedLinePart = antennaAAsl * (1 - t) + elevationB * t;
    const projectedHeightB = (requiredLineAsl - fixedLinePart) / t;
    required = Math.max(required, projectedHeightB);
  }

  return Math.max(0, required);
}

async function refreshTerrainProfile() {
  if (!state.pointA || !state.pointB) {
    state.profile = null;
    return;
  }

  const key = [
    state.pointA.lat.toFixed(6),
    state.pointA.lng.toFixed(6),
    state.pointB.lat.toFixed(6),
    state.pointB.lng.toFixed(6),
  ].join(",");

  if (key === state.profileKey && state.profile) return;

  state.profile = null;
  state.profileKey = key;
  const requestId = ++state.profileRequestId;
  const cacheKey = `dem:${key}:samples${DEM_SAMPLE_COUNT}`;
  const cached = readCache(cacheKey);
  if (cached && Array.isArray(cached.points) && Array.isArray(cached.elevations)) {
    state.profile = cached;
    update();
    return;
  }

  try {
    const points = sampleLine(state.pointA, state.pointB, DEM_SAMPLE_COUNT);
    const data = await fetchElevationProfile(points);
    const elevations = Array.isArray(data.elevation) ? data.elevation.map(Number) : [];
    if (elevations.length !== points.length || elevations.some((value) => !Number.isFinite(value))) {
      throw new Error("Elevation API returned an invalid profile");
    }

    if (requestId !== state.profileRequestId) return;

    state.profile = { points, elevations };
    writeCache(cacheKey, state.profile);
    update();
  } catch (error) {
    if (requestId !== state.profileRequestId) return;
    state.profile = null;
    elements.commentOut.textContent = "Не удалось загрузить профиль рельефа. Проверьте интернет или повторно поставьте точку B.";
    console.error(error);
  }
}

function readCache(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || Date.now() - entry.time > CACHE_TTL_MS) {
      localStorage.removeItem(CACHE_PREFIX + key);
      return null;
    }
    return entry.value;
  } catch {
    return null;
  }
}

function writeCache(key, value) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ time: Date.now(), value }));
  } catch {
    pruneCache();
    try {
      localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ time: Date.now(), value }));
    } catch {
      // Cache is optional; calculations should keep working without it.
    }
  }
}

function pruneCache() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key && key.startsWith(CACHE_PREFIX)) keys.push(key);
  }
  keys.slice(0, Math.ceil(keys.length / 2)).forEach((key) => localStorage.removeItem(key));
}

async function fetchElevationProfile(points) {
  const elevations = [];
  const chunkSize = 20;

  for (let index = 0; index < points.length; index += chunkSize) {
    const chunk = points.slice(index, index + chunkSize);
    const data = await fetchElevationChunk(chunk);
    if (!Array.isArray(data.elevation)) {
      throw new Error("Elevation API returned no elevation array");
    }
    elevations.push(...data.elevation);
  }

  return { elevation: elevations };
}

async function fetchElevationChunk(points) {
  const latitudes = points.map((point) => point.lat.toFixed(6)).join(",");
  const longitudes = points.map((point) => point.lng.toFixed(6)).join(",");
  const params = new URLSearchParams({ latitude: latitudes, longitude: longitudes });
  const url = `https://api.open-meteo.com/v1/elevation?${params}`;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Elevation API returned ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
    }
  }

  throw new Error("Elevation API chunk request failed");
}

function sampleLine(pointA, pointB, count) {
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    const t = i / (count - 1);
    samples.push({
      lat: pointA.lat + (pointB.lat - pointA.lat) * t,
      lng: pointA.lng + (pointB.lng - pointA.lng) * t,
    });
  }
  return samples;
}

function screenToLatLng(clientX, clientY) {
  const rect = elements.map.getBoundingClientRect();
  const centerPx = latLngToPixel(state.center, state.zoom);
  const pointPx = {
    x: centerPx.x - rect.width / 2 + (clientX - rect.left),
    y: centerPx.y - rect.height / 2 + (clientY - rect.top),
  };
  return pixelToLatLng(pointPx, state.zoom);
}

function latLngToScreen(point, topLeft) {
  const pixel = latLngToPixel(point, state.zoom);
  return {
    x: pixel.x - topLeft.x,
    y: pixel.y - topLeft.y,
  };
}

function latLngToPixel(point, zoom) {
  const scale = TILE_SIZE * 2 ** zoom;
  const sinLat = Math.sin(toRadians(Math.max(-85.05112878, Math.min(85.05112878, point.lat))));
  return {
    x: ((point.lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale,
  };
}

function pixelToLatLng(point, zoom) {
  const scale = TILE_SIZE * 2 ** zoom;
  const lng = (point.x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * point.y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lng };
}

function distanceBetween(pointA, pointB) {
  const lat1 = toRadians(pointA.lat);
  const lat2 = toRadians(pointB.lat);
  const deltaLat = toRadians(pointB.lat - pointA.lat);
  const deltaLng = toRadians(pointB.lng - pointA.lng);
  const a = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function formatDistance(meters) {
  if (meters < 1000) return `${formatMeters(meters)} м`;
  return `${(meters / 1000).toFixed(meters >= 10000 ? 1 : 2)} км`;
}

function formatMeters(meters) {
  const abs = Math.abs(meters);
  if (abs >= 100) return meters.toFixed(0);
  if (abs >= 10) return meters.toFixed(1);
  return meters.toFixed(2);
}

function formatCeilMeters(meters) {
  return String(Math.max(0, Math.ceil(meters)));
}

renderMap();
update();
