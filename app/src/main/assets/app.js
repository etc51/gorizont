const EARTH_RADIUS_M = 6371000;
const LIGHT_SPEED = 299792458;
const TILE_SIZE = 256;
const DEFAULT_FREQUENCY_MHZ = 5800;
const DEFAULT_CLEARANCE_RATIO = 0.6;
const DEFAULT_K_FACTOR = 1.33;
const EDGE_IGNORE_RATIO = 0.1;
const DEM_SAMPLE_COUNT = 60;
const DEM_CHUNK_SIZE = 60;
const PAN_SPEED_MULTIPLIER = 3;
const TILE_PRELOAD_DELAY_MS = 350;
const MAX_RETAINED_TILES = 128;
const CACHE_PREFIX = "rf-calc-cache-v2:";
const CACHE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const TILE_RUNTIME_CACHE = "radiovidimost-tiles-v1";
const DEFAULT_VIEWPORT = { zoom: 10, center: { lat: 48.015883, lng: 37.80285 } };
const VIEWPORT_CACHE_KEY = "viewport";
const ROUTE_CACHE_KEY = "route";
const SETTINGS_CACHE_KEY = "settings";
const LAST_PLACES_CACHE_KEY = "places:last";
const PLACE_BANK_CACHE_KEY = "places:bank";
const MAX_PLACE_BANK_SIZE = 5000;
const PLACE_KIND_WEIGHT = {
  city: 0,
  town: 1,
  village: 2,
  settlement: 2,
  suburb: 3,
  hamlet: 4,
};
const MIN_DRAG_DISTANCE_PX = 4;
const PINCH_ZOOM_STEP_RATIO = 1.18;
const DEFAULT_PLACES = [
  { lat: 48.0028, lng: 37.8053, name: "Донецк", kind: "city" },
  { lat: 48.0478, lng: 37.9258, name: "Макеевка", kind: "city" },
  { lat: 48.1298, lng: 37.8594, name: "Ясиноватая", kind: "town" },
  { lat: 48.1399, lng: 37.7425, name: "Авдеевка", kind: "town" },
  { lat: 48.3071, lng: 38.0296, name: "Горловка", kind: "city" },
  { lat: 47.8903, lng: 38.0631, name: "Моспино", kind: "town" },
  { lat: 47.831, lng: 37.936, name: "Ларино", kind: "town" },
  { lat: 47.7508, lng: 37.6792, name: "Докучаевск", kind: "town" },
  { lat: 47.833, lng: 37.66, name: "Еленовка", kind: "town" },
  { lat: 48.042, lng: 38.147, name: "Харцызск", kind: "town" },
  { lat: 47.925, lng: 38.202, name: "Иловайск", kind: "town" },
  { lat: 47.752, lng: 38.03, name: "Старобешево", kind: "town" },
  { lat: 47.76, lng: 37.59, name: "Новотроицкое", kind: "town" },
  { lat: 47.924, lng: 37.88, name: "Александровка", kind: "town" },
];

const initialViewport = readInitialViewport();
const initialRoute = readInitialRoute();
const initialSettings = readInitialSettings();
const initialPlaces = readInitialPlaces();
const initialPlaceBank = mergePlaces(DEFAULT_PLACES, readInitialPlaceBank(), initialPlaces);

const state = {
  placing: "A",
  zoom: initialViewport.zoom,
  center: initialViewport.center,
  pointA: initialRoute.pointA,
  pointB: initialRoute.pointB,
  places: initialPlaces.length ? mergePlaces(initialPlaces, DEFAULT_PLACES) : DEFAULT_PLACES,
  placeBank: initialPlaceBank,
  placeKey: "",
  placeRequestId: 0,
  placeTimer: null,
  profile: null,
  profileKey: "",
  profileRequestId: 0,
  pointers: new Map(),
  drag: null,
  pinch: null,
  saveTimer: null,
  renderFrame: 0,
  tiles: new Map(),
  tileSerial: 0,
  tilePreloadTimer: null,
  tileWarmups: new Set(),
  tileWarmupQueue: [],
  tileWarmupActive: 0,
};
writeCache(PLACE_BANK_CACHE_KEY, state.placeBank);

const elements = {
  map: document.querySelector("#map"),
  distanceOut: document.querySelector("#distanceOut"),
  commentOut: document.querySelector("#commentOut"),
  setA: document.querySelector("#setA"),
  setB: document.querySelector("#setB"),
  heightA: document.querySelector("#heightA"),
};

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("./sw.js?v=20260526-cache12").catch((error) => {
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
const compass = document.createElement("div");
compass.className = "map-compass";
compass.setAttribute("aria-label", "Север");
compass.innerHTML = '<span aria-hidden="true"></span><strong>N</strong>';

elements.map.append(mapLayers, placeLayer, lineLayer, markerLayer, zoomControl, compass);
elements.heightA.value = initialSettings.heightA;

elements.setA.addEventListener("click", () => setPlacementMode("A"));
elements.setB.addEventListener("click", () => setPlacementMode("B"));
document.querySelector("#settings").addEventListener("input", () => {
  saveSettings();
  update();
});

zoomControl.addEventListener("pointerdown", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  setZoom(state.zoom + (button.dataset.zoom === "in" ? 1 : -1));
});

zoomControl.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
});

elements.map.addEventListener("wheel", (event) => {
  event.preventDefault();
  setZoom(state.zoom + (event.deltaY < 0 ? 1 : -1), event.clientX, event.clientY);
}, { passive: false });

elements.map.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  if (event.target.closest(".plain-zoom")) return;
  event.preventDefault();
  try {
    elements.map.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture is best effort in older Android WebView builds.
  }
  state.pointers.set(event.pointerId, getPointerPosition(event));

  if (state.pointers.size >= 2) {
    finishDragOffset();
    state.drag = null;
    startPinch();
    return;
  }

  state.drag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startCenterPx: latLngToPixel(state.center, state.zoom),
    moved: false,
  };
});

elements.map.addEventListener("pointermove", (event) => {
  if (!state.pointers.has(event.pointerId)) return;
  event.preventDefault();

  state.pointers.set(event.pointerId, getPointerPosition(event));

  if (state.pinch && state.pointers.size >= 2) {
    updatePinch();
    return;
  }

  if (!state.drag || state.drag.pointerId !== event.pointerId) return;

  const dx = event.clientX - state.drag.startX;
  const dy = event.clientY - state.drag.startY;
  if (!state.drag.moved && Math.abs(dx) + Math.abs(dy) <= MIN_DRAG_DISTANCE_PX) return;
  state.drag.moved = true;
  const mapDx = dx * PAN_SPEED_MULTIPLIER;
  const mapDy = dy * PAN_SPEED_MULTIPLIER;
  const nextCenterPx = {
    x: state.drag.startCenterPx.x - mapDx,
    y: state.drag.startCenterPx.y - mapDy,
  };
  state.center = pixelToLatLng(nextCenterPx, state.zoom);
  scheduleDragOffset(mapDx, mapDy);
});

elements.map.addEventListener("pointerup", (event) => {
  if (!state.pointers.has(event.pointerId)) return;
  event.preventDefault();

  const wasPinch = Boolean(state.pinch);
  const wasDrag = Boolean(state.drag && state.drag.pointerId === event.pointerId && state.drag.moved);
  const wasTap = Boolean(state.drag && state.drag.pointerId === event.pointerId && !state.drag.moved);
  state.pointers.delete(event.pointerId);

  if (wasPinch) {
    endPinch();
    return;
  }

  if (!wasTap && !wasDrag) return;

  finishDragOffset();
  state.drag = null;
  if (wasDrag) {
    renderMap();
    saveViewportSoon();
    return;
  }
  if (event.target.closest(".plain-zoom")) return;
  const point = screenToLatLng(event.clientX, event.clientY);

  if (state.placing === "A") {
    state.pointA = point;
  } else {
    state.pointB = point;
  }

  saveRoute();
  refreshTerrainProfile();
  update();
  renderMap();
});

elements.map.addEventListener("pointercancel", (event) => {
  state.pointers.delete(event.pointerId);
  if (state.pinch) {
    endPinch();
    return;
  }
  if (state.drag && state.drag.pointerId === event.pointerId) {
    finishDragOffset();
    state.drag = null;
    renderMap();
    saveViewportSoon();
  }
});

window.addEventListener("resize", () => {
  renderMap();
  saveViewportSoon();
});
window.addEventListener("beforeunload", () => {
  saveViewport();
  saveRoute();
  saveSettings();
});

function setPlacementMode(mode) {
  state.placing = mode;
  elements.setA.classList.toggle("active", mode === "A");
  elements.setB.classList.toggle("active", mode === "B");
}

function setZoom(zoom, focusClientX, focusClientY) {
  const nextZoom = clampZoom(zoom);
  if (nextZoom === state.zoom) return;

  const hasFocus = Number.isFinite(focusClientX) && Number.isFinite(focusClientY);
  const focusPoint = hasFocus ? screenToLatLng(focusClientX, focusClientY) : null;

  state.zoom = nextZoom;
  if (focusPoint) {
    keepPointUnderScreenPosition(focusPoint, focusClientX, focusClientY);
  }

  renderMap();
  saveViewportSoon();
}

function clampZoom(zoom) {
  return Math.max(2, Math.min(18, Math.round(zoom)));
}

function keepPointUnderScreenPosition(point, clientX, clientY) {
  const rect = elements.map.getBoundingClientRect();
  const pointPx = latLngToPixel(point, state.zoom);
  const centerPx = {
    x: pointPx.x - (clientX - rect.left) + rect.width / 2,
    y: pointPx.y - (clientY - rect.top) + rect.height / 2,
  };
  state.center = pixelToLatLng(centerPx, state.zoom);
}

function getPointerPosition(event) {
  return {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
  };
}

function startPinch() {
  const points = getPinchPoints();
  if (points.length < 2) return;
  state.pinch = {
    startDistance: getPointDistance(points[0], points[1]),
    changed: false,
  };
}

function updatePinch() {
  const points = getPinchPoints();
  if (points.length < 2) return;
  if (!state.pinch) startPinch();
  if (!state.pinch || state.pinch.startDistance <= 0) return;

  const distance = getPointDistance(points[0], points[1]);
  if (distance <= 0) return;

  const ratio = distance / state.pinch.startDistance;
  if (ratio < PINCH_ZOOM_STEP_RATIO && ratio > 1 / PINCH_ZOOM_STEP_RATIO) return;

  const midpoint = getPointMidpoint(points[0], points[1]);
  const direction = ratio > 1 ? 1 : -1;
  const previousZoom = state.zoom;
  setZoom(state.zoom + direction, midpoint.x, midpoint.y);

  state.pinch.startDistance = distance;
  if (state.zoom !== previousZoom) state.pinch.changed = true;
}

function endPinch() {
  const changed = Boolean(state.pinch && state.pinch.changed);
  state.pinch = null;
  finishDragOffset();
  state.drag = null;

  const remaining = getPinchPoints()[0];
  if (remaining) {
    state.drag = {
      pointerId: remaining.id,
      startX: remaining.x,
      startY: remaining.y,
      startCenterPx: latLngToPixel(state.center, state.zoom),
      moved: true,
    };
  }

  if (changed) {
    renderMap();
    saveViewportSoon();
  }
}

function getPinchPoints() {
  return Array.from(state.pointers.values()).slice(0, 2);
}

function getPointDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function getPointMidpoint(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

function renderMap() {
  if (state.renderFrame) {
    cancelAnimationFrame(state.renderFrame);
    state.renderFrame = 0;
  }
  const rect = elements.map.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  clearLayerOffset();
  lineLayer.setAttribute("width", rect.width);
  lineLayer.setAttribute("height", rect.height);
  lineLayer.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);

  const centerPx = latLngToPixel(state.center, state.zoom);
  const topLeft = {
    x: centerPx.x - rect.width / 2,
    y: centerPx.y - rect.height / 2,
  };
  const minTileX = Math.floor(topLeft.x / TILE_SIZE);
  const minTileY = Math.floor(topLeft.y / TILE_SIZE);
  const maxTileX = Math.floor((topLeft.x + rect.width) / TILE_SIZE);
  const maxTileY = Math.floor((topLeft.y + rect.height) / TILE_SIZE);
  const worldTiles = 2 ** state.zoom;
  const activeTileKeys = new Set();
  const visibleTiles = [];

  for (let x = minTileX; x <= maxTileX; x += 1) {
    for (let y = minTileY; y <= maxTileY; y += 1) {
      if (y < 0 || y >= worldTiles) continue;
      const wrappedX = ((x % worldTiles) + worldTiles) % worldTiles;
      const left = Math.round(x * TILE_SIZE - topLeft.x);
      const top = Math.round(y * TILE_SIZE - topLeft.y);
      const key = getTileKey(state.zoom, wrappedX, y);
      activeTileKeys.add(key);
      visibleTiles.push({
        z: state.zoom,
        x: wrappedX,
        y,
        left,
        top,
        key,
        distance: Math.hypot(
          left + TILE_SIZE / 2 - rect.width / 2,
          top + TILE_SIZE / 2 - rect.height / 2,
        ),
      });
    }
  }

  visibleTiles
    .sort((a, b) => a.distance - b.distance)
    .forEach((tile) => placeTile(tile.z, tile.x, tile.y, tile.left, tile.top, tile.key));

  parkUnusedTiles(activeTileKeys);
  scheduleNeighborTilePreload(state.zoom, minTileX, minTileY, maxTileX, maxTileY, worldTiles);
  restoreCachedPlacesForCurrentView();
  schedulePlaceLoad();
  renderPlaces(topLeft);
  renderMarkersAndLine(topLeft);
}

function placeTile(z, x, y, left, top, key = getTileKey(z, x, y)) {
  let img = state.tiles.get(key);
  if (!img) {
    img = createTile(z, x, y);
    state.tiles.set(key, img);
    mapLayers.append(img);
  }
  img.hidden = false;
  img.dataset.active = "1";
  img.dataset.lastUsed = String(++state.tileSerial);
  img.style.transform = `translate(${left}px, ${top}px)`;
}

function createTile(z, x, y) {
  const img = document.createElement("img");
  img.className = "plain-tile";
  img.alt = "";
  img.decoding = "async";
  img.loading = "eager";
  img.draggable = false;
  img.setAttribute("fetchpriority", "high");
  img.addEventListener("load", () => warmTileCache(img.currentSrc || img.src), { once: true });
  img.src = getTileUrl(z, x, y);
  return img;
}

function parkUnusedTiles(activeTileKeys) {
  for (const [key, img] of state.tiles) {
    if (activeTileKeys.has(key)) continue;
    img.hidden = true;
    img.dataset.active = "0";
  }

  if (state.tiles.size <= MAX_RETAINED_TILES) return;
  const unusedTiles = Array.from(state.tiles.entries())
    .filter(([, img]) => img.dataset.active !== "1")
    .sort(([, a], [, b]) => Number(a.dataset.lastUsed || 0) - Number(b.dataset.lastUsed || 0));
  const removeCount = state.tiles.size - MAX_RETAINED_TILES;
  unusedTiles.slice(0, removeCount).forEach(([key, img]) => {
    img.remove();
    state.tiles.delete(key);
  });
}

function scheduleNeighborTilePreload(zoom, minTileX, minTileY, maxTileX, maxTileY, worldTiles) {
  clearTimeout(state.tilePreloadTimer);
  state.tilePreloadTimer = setTimeout(() => {
    const preload = [];
    for (let x = minTileX - 1; x <= maxTileX + 1; x += 1) {
      for (let y = minTileY - 1; y <= maxTileY + 1; y += 1) {
        if (y < 0 || y >= worldTiles) continue;
        if (x >= minTileX && x <= maxTileX && y >= minTileY && y <= maxTileY) continue;
        const wrappedX = ((x % worldTiles) + worldTiles) % worldTiles;
        preload.push({
          url: getTileUrl(zoom, wrappedX, y),
          distance: Math.min(
            Math.abs(x - minTileX),
            Math.abs(x - maxTileX),
          ) + Math.min(
            Math.abs(y - minTileY),
            Math.abs(y - maxTileY),
          ),
        });
      }
    }
    preload
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 32)
      .forEach((tile) => warmTileCache(tile.url));
  }, TILE_PRELOAD_DELAY_MS);
}

function getTileKey(z, x, y) {
  return `${z}/${x}/${y}`;
}

function getTileUrl(z, x, y) {
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
}

function scheduleDragOffset(dx, dy) {
  if (!state.drag) return;
  state.drag.offsetX = dx;
  state.drag.offsetY = dy;
  if (state.drag.raf) return;

  state.drag.raf = requestAnimationFrame(() => {
    if (!state.drag) return;
    state.drag.raf = 0;
    setLayerOffset(state.drag.offsetX || 0, state.drag.offsetY || 0);
  });
}

function finishDragOffset() {
  if (state.drag && state.drag.raf) {
    cancelAnimationFrame(state.drag.raf);
    state.drag.raf = 0;
  }
  clearLayerOffset();
}

function setLayerOffset(dx, dy) {
  const transform = `translate(${Math.round(dx)}px, ${Math.round(dy)}px)`;
  mapLayers.style.transform = transform;
  placeLayer.style.transform = transform;
  lineLayer.style.transform = transform;
  markerLayer.style.transform = transform;
}

function clearLayerOffset() {
  mapLayers.style.transform = "";
  placeLayer.style.transform = "";
  lineLayer.style.transform = "";
  markerLayer.style.transform = "";
}

function renderPlaces(topLeft) {
  placeLayer.replaceChildren();
  if (!state.places.length) return;

  const rect = elements.map.getBoundingClientRect();
  const occupied = [];
  for (const place of state.places) {
    const screen = latLngToScreen(place, topLeft);
    if (screen.x < -80 || screen.y < -24 || screen.x > rect.width + 80 || screen.y > rect.height + 24) continue;
    const isMajorPlace = place.kind === "city" || place.kind === "town";
    const labelWidth = Math.min(190, Math.max(46, place.name.length * (isMajorPlace ? 8.2 : 7.1) + 12));
    const labelHeight = isMajorPlace ? 22 : 18;
    const box = {
      left: screen.x - labelWidth / 2,
      right: screen.x + labelWidth / 2,
      top: screen.y - labelHeight / 2,
      bottom: screen.y + labelHeight / 2,
    };
    if (occupied.some((item) => boxesOverlap(item, box))) continue;
    occupied.push(box);

    const label = document.createElement("div");
    label.className = `place-label place-${place.kind || "settlement"}`;
    label.textContent = place.name;
    label.style.transform = `translate(${Math.round(screen.x)}px, ${Math.round(screen.y)}px)`;
    placeLayer.append(label);
  }
}

function schedulePlaceLoad() {
  clearTimeout(state.placeTimer);
  state.placeTimer = setTimeout(loadPlaceLabels, state.places.length ? 80 : 20);
}

async function loadPlaceLabels() {
  const { bounds, placeKinds, key, cacheKey } = getPlaceCacheInfo();

  if (key === state.placeKey) return;
  state.placeKey = key;
  const requestId = ++state.placeRequestId;
  const cached = readCache(cacheKey);
  if (cached) {
    rememberPlaces(cached);
    state.places = getStoredPlacesForBounds(bounds);
    writeCache(LAST_PLACES_CACHE_KEY, { key, places: state.places });
    renderCurrentOverlays();
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

    const loadedPlaces = uniquePlaces((data.elements || [])
      .map((item) => ({
        lat: item.lat,
        lng: item.lon,
        name: cleanPlaceName(item.tags && item.tags["name:ru"]),
        kind: item.tags && item.tags.place,
      }))
      .filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lng) && place.name))
      .sort(comparePlaces)
      .slice(0, getPlaceLimitForZoom(state.zoom));
    if (loadedPlaces.length > 0) {
      rememberPlaces(loadedPlaces);
      state.places = getStoredPlacesForBounds(bounds);
      writeCache(cacheKey, loadedPlaces);
      writeCache(LAST_PLACES_CACHE_KEY, { key, places: state.places });
    }
    renderCurrentOverlays();
  } catch (error) {
    if (requestId !== state.placeRequestId) return;
    if (!state.places.length) {
      const last = readCache(LAST_PLACES_CACHE_KEY);
      state.places = Array.isArray(last && last.places) ? last.places : [];
    }
    state.placeKey = "";
    renderCurrentOverlays();
    console.error(error);
  }
}

function restoreCachedPlacesForCurrentView() {
  const { bounds, cacheKey } = getPlaceCacheInfo();
  const stored = getStoredPlacesForBounds(bounds);
  if (stored.length) {
    state.places = stored;
  }

  const cached = readCache(cacheKey);
  if (cached) {
    rememberPlaces(cached);
    state.places = getStoredPlacesForBounds(bounds);
    return;
  }

  if (!state.places.length) {
    const last = readCache(LAST_PLACES_CACHE_KEY);
    if (last && Array.isArray(last.places)) state.places = last.places;
  }
}

function getPlaceCacheInfo() {
  const bounds = snapBoundsToGrid(getMapBounds(), getPlaceGridSizeForZoom(state.zoom));
  const placeKinds = getPlaceKindsForZoom(state.zoom);
  const key = [
    state.zoom,
    placeKinds,
    bounds.south.toFixed(3),
    bounds.west.toFixed(3),
    bounds.north.toFixed(3),
    bounds.east.toFixed(3),
  ].join(",");

  return {
    bounds,
    placeKinds,
    key,
    cacheKey: `places:${key}`,
  };
}

function getStoredPlacesForBounds(bounds) {
  return uniquePlaces(state.placeBank.filter((place) => isPlaceInsideBounds(place, bounds)))
    .sort(comparePlaces)
    .slice(0, getPlaceLimitForZoom(state.zoom));
}

function isPlaceInsideBounds(place, bounds) {
  return place.lat >= bounds.south &&
    place.lat <= bounds.north &&
    place.lng >= bounds.west &&
    place.lng <= bounds.east;
}

function rememberPlaces(places) {
  if (!Array.isArray(places) || !places.length) return;
  state.placeBank = mergePlaces(places, state.placeBank).slice(0, MAX_PLACE_BANK_SIZE);
  writeCache(PLACE_BANK_CACHE_KEY, state.placeBank);
}

function renderCurrentOverlays() {
  const rect = elements.map.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const centerPx = latLngToPixel(state.center, state.zoom);
  const topLeft = {
    x: centerPx.x - rect.width / 2,
    y: centerPx.y - rect.height / 2,
  };
  renderPlaces(topLeft);
  renderMarkersAndLine(topLeft);
}

function getPlaceKindsForZoom(zoom) {
  if (zoom <= 8) return "city";
  if (zoom <= 10) return "city|town";
  if (zoom <= 12) return "city|town|village";
  return "city|town|village|hamlet|suburb";
}

function getPlaceLimitForZoom(zoom) {
  if (zoom <= 8) return 18;
  if (zoom <= 10) return 35;
  if (zoom <= 12) return 70;
  return 120;
}

function getPlaceGridSizeForZoom(zoom) {
  if (zoom <= 7) return 2;
  if (zoom <= 9) return 1;
  if (zoom <= 11) return 0.25;
  if (zoom <= 13) return 0.1;
  return 0.05;
}

function snapBoundsToGrid(bounds, grid) {
  return {
    north: clampLatitude(Math.ceil(bounds.north / grid) * grid),
    south: clampLatitude(Math.floor(bounds.south / grid) * grid),
    west: clampLongitude(Math.floor(bounds.west / grid) * grid),
    east: clampLongitude(Math.ceil(bounds.east / grid) * grid),
  };
}

function clampLatitude(value) {
  return Math.max(-85, Math.min(85, value));
}

function clampLongitude(value) {
  return Math.max(-180, Math.min(180, value));
}

function boxesOverlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function cleanPlaceName(name) {
  if (!name) return "";
  return name.replace(/\s*\(.+?\)\s*/g, "").trim();
}

function mergePlaces(...groups) {
  const seen = new Set();
  const result = [];

  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const place of group) {
      const normalized = normalizePlace(place);
      if (!normalized) continue;
      const key = [
        normalized.name.toLowerCase(),
        normalized.lat.toFixed(3),
        normalized.lng.toFixed(3),
      ].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(normalized);
    }
  }

  return result;
}

function normalizePlace(place) {
  if (!place) return null;
  const normalized = {
    lat: Number(place.lat),
    lng: Number(place.lng),
    name: cleanPlaceName(place.name),
    kind: place.kind || "settlement",
  };
  if (!Number.isFinite(normalized.lat) || !Number.isFinite(normalized.lng) || !normalized.name) return null;
  return normalized;
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

function comparePlaces(a, b) {
  const weightA = PLACE_KIND_WEIGHT[a.kind] ?? 5;
  const weightB = PLACE_KIND_WEIGHT[b.kind] ?? 5;
  if (weightA !== weightB) return weightA - weightB;
  return a.name.localeCompare(b.name, "ru");
}

async function fetchPlaceData(overpassQuery, bounds) {
  try {
    return await fetchOverpass(overpassQuery);
  } catch (error) {
    return await fetchWikidataPlaces(bounds);
  }
}

async function fetchOverpass(query) {
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];

  const requests = endpoints.map(async (endpoint) => {
    const url = `${endpoint}?${new URLSearchParams({ data: query })}`;
    const response = await fetchWithTimeout(url, 6500);
    if (!response.ok) throw new Error(`Overpass returned ${response.status}`);
    return await response.json();
  });

  if (Promise.any) {
    return await Promise.any(requests);
  }

  const results = await Promise.allSettled(requests);
  const firstSuccess = results.find((result) => result.status === "fulfilled");
  if (firstSuccess) return firstSuccess.value;
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
  elements.commentOut.textContent = buildComment(requiredHeightB, Boolean(state.profile));
}

function readParams() {
  return {
    frequencyMHz: DEFAULT_FREQUENCY_MHZ,
    heightA: clampNumber(elements.heightA.value, 0, 10000, 2),
    clearanceRatio: DEFAULT_CLEARANCE_RATIO,
    kFactor: DEFAULT_K_FACTOR,
  };
}

function buildComment(requiredHeightB, hasTerrain) {
  const height = formatCeilMeters(requiredHeightB);
  if (!hasTerrain) {
    return `Предварительно без рельефа: над точкой B видео расчетно пропадет ниже ${height} м. Уточняю по рельефу...`;
  }

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

  const key = getProfileKey(state.pointA, state.pointB);

  if (key === state.profileKey && state.profile) return;

  state.profile = null;
  state.profileKey = key;
  const requestId = ++state.profileRequestId;
  const cacheKey = getProfileCacheKey(state.pointA, state.pointB);
  const cached = readCache(cacheKey);
  if (cached && Array.isArray(cached.points) && Array.isArray(cached.elevations)) {
    state.profile = cached;
    update();
    return;
  }

  const reverseCached = readCache(getProfileCacheKey(state.pointB, state.pointA));
  if (reverseCached && Array.isArray(reverseCached.points) && Array.isArray(reverseCached.elevations)) {
    state.profile = {
      points: [...reverseCached.points].reverse(),
      elevations: [...reverseCached.elevations].reverse(),
    };
    writeCache(cacheKey, state.profile);
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

function getProfileKey(pointA, pointB) {
  return [
    pointA.lat.toFixed(4),
    pointA.lng.toFixed(4),
    pointB.lat.toFixed(4),
    pointB.lng.toFixed(4),
  ].join(",");
}

function getProfileCacheKey(pointA, pointB) {
  return `dem:${getProfileKey(pointA, pointB)}:samples${DEM_SAMPLE_COUNT}`;
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
  const protectedKeys = new Set([
    CACHE_PREFIX + VIEWPORT_CACHE_KEY,
    CACHE_PREFIX + ROUTE_CACHE_KEY,
    CACHE_PREFIX + SETTINGS_CACHE_KEY,
    CACHE_PREFIX + LAST_PLACES_CACHE_KEY,
    CACHE_PREFIX + PLACE_BANK_CACHE_KEY,
  ]);
  const entries = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(CACHE_PREFIX) || protectedKeys.has(key)) continue;
    let time = 0;
    try {
      const parsed = JSON.parse(localStorage.getItem(key));
      time = Number(parsed && parsed.time) || 0;
    } catch {
      time = 0;
    }
    entries.push({ key, time });
  }
  entries
    .sort((a, b) => a.time - b.time)
    .slice(0, Math.max(1, Math.ceil(entries.length / 2)))
    .forEach((entry) => localStorage.removeItem(entry.key));
}

function readInitialViewport() {
  const saved = readCache(VIEWPORT_CACHE_KEY);
  if (
    saved &&
    Number.isFinite(saved.zoom) &&
    isLatLng(saved.center)
  ) {
    return {
      zoom: Math.max(2, Math.min(18, Math.round(saved.zoom))),
      center: saved.center,
    };
  }

  return DEFAULT_VIEWPORT;
}

function readInitialRoute() {
  const saved = readCache(ROUTE_CACHE_KEY);
  return {
    pointA: saved && isLatLng(saved.pointA) ? saved.pointA : null,
    pointB: saved && isLatLng(saved.pointB) ? saved.pointB : null,
  };
}

function readInitialSettings() {
  const saved = readCache(SETTINGS_CACHE_KEY);
  return {
    heightA: saved && Number.isFinite(Number(saved.heightA)) ? String(saved.heightA) : "2",
  };
}

function readInitialPlaces() {
  const saved = readCache(LAST_PLACES_CACHE_KEY);
  return saved && Array.isArray(saved.places) ? saved.places : [];
}

function readInitialPlaceBank() {
  const saved = readCache(PLACE_BANK_CACHE_KEY);
  return Array.isArray(saved) ? saved : [];
}

function isLatLng(point) {
  return point &&
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) &&
    point.lat >= -85 &&
    point.lat <= 85 &&
    point.lng >= -180 &&
    point.lng <= 180;
}

function saveViewportSoon() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveViewport, 250);
}

function saveViewport() {
  writeCache(VIEWPORT_CACHE_KEY, {
    zoom: state.zoom,
    center: state.center,
  });
}

function saveRoute() {
  writeCache(ROUTE_CACHE_KEY, {
    pointA: state.pointA,
    pointB: state.pointB,
  });
}

function saveSettings() {
  writeCache(SETTINGS_CACHE_KEY, {
    heightA: elements.heightA.value,
  });
}

function warmTileCache(url) {
  if (!("caches" in window) || !url) return;
  if (state.tileWarmups.has(url)) return;
  if (state.tileWarmups.size > 2000) state.tileWarmups.clear();
  state.tileWarmups.add(url);
  state.tileWarmupQueue.push(url);
  processTileWarmupQueue();
}

function processTileWarmupQueue() {
  if (state.tileWarmupActive >= 2) return;
  const url = state.tileWarmupQueue.shift();
  if (!url) return;

  state.tileWarmupActive += 1;
  const run = async () => {
    let storedOrCached = false;
    try {
      const cache = await caches.open(TILE_RUNTIME_CACHE);
      const cached = await cache.match(url);
      if (!cached) {
        const response = await fetch(url, { mode: "no-cors", cache: "force-cache" });
        if (response.ok || response.type === "opaque") {
          await cache.put(url, response.clone());
          storedOrCached = true;
        }
      } else {
        storedOrCached = true;
      }
    } catch {
      // Service worker caching still covers normal online use; this is only a first-run warmup.
    } finally {
      if (!storedOrCached) state.tileWarmups.delete(url);
      state.tileWarmupActive -= 1;
      processTileWarmupQueue();
    }
  };

  if ("requestIdleCallback" in window) {
    requestIdleCallback(run, { timeout: 2000 });
  } else {
    setTimeout(run, 0);
  }
}

async function fetchElevationProfile(points) {
  const chunks = [];

  for (let index = 0; index < points.length; index += DEM_CHUNK_SIZE) {
    chunks.push(points.slice(index, index + DEM_CHUNK_SIZE));
  }

  const elevations = [];
  const results = await Promise.all(chunks.map((chunk) => fetchElevationChunk(chunk)));

  for (const data of results) {
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
if (state.pointA && state.pointB) refreshTerrainProfile();
