const API = "https://api.gbif.org/v1";
const MAX_QUERY_WKT_LENGTH = 7500;
const MOBILE_BREAKPOINT = 860;
const FRAME_LEFT = 0.1;
const FRAME_TOP = 0.2;
const FRAME_WIDTH = 0.8;
const FRAME_HEIGHT = 0.6;
const WEB_MERCATOR_LAT_LIMIT = 85.051129;

// This token is domain restricted, don't bother trying to steal it!
const MAPBOX_ACCESS_TOKEN =
  "pk.eyJ1IjoicmtlbXBlciIsImEiOiJjbWMycmZtd24wYWpvMmxwemR6MWltNzZrIn0.I_ZpY7zFkX0nZOspc32xZg";
const FACETS = [
  "speciesKey",
  "datasetKey",
  "publishingOrg",
  "year",
  "basisOfRecord",
];
const RESOLVE_ROUTES = {
  speciesKey: (key) => `/species/${key}`,
  datasetKey: (key) => `/dataset/${key}`,
  publishingOrg: (key) => `/organization/${key}`,
};

const drawBtn = document.getElementById("drawBtn");
const clearBtn = document.getElementById("clearBtn");
const submitBtn = document.getElementById("submitBtn");
const drawHint = document.getElementById("drawHint");
const geojsonInput = document.getElementById("geojsonInput");
const dropOverlay = document.getElementById("dropOverlay");
const drawFrameLayer = document.getElementById("drawFrameLayer");
const confirmFrameBtn = document.getElementById("confirmFrameBtn");
const mapWrap = document.querySelector(".map-wrap");
const occurrenceCount = document.getElementById("occurrenceCount");
const tableSearch = document.getElementById("tableSearch");
const exportBtn = document.getElementById("exportBtn");
const resultsBody = document.getElementById("resultsBody");
const statusMessage = document.getElementById("statusMessage");
const tabs = document.querySelectorAll(".tab");

let map;
let drawMode = false;
let dragStart = null;
let currentArea = null;
let inventory = null;
let activeTab = "species";
let dragDepth = 0;

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    activeTab = tab.dataset.tab;
    tabs.forEach((button) => button.classList.toggle("active", button === tab));
    tableSearch.value = "";
    renderTable();
  });
});

tableSearch.addEventListener("input", renderTable);
drawBtn.addEventListener("click", toggleDrawMode);
confirmFrameBtn.addEventListener("click", confirmMobileFrame);
clearBtn.addEventListener("click", clearArea);
submitBtn.addEventListener("click", runQuery);
geojsonInput.addEventListener("change", onGeoJSONSelected);
exportBtn.addEventListener("click", exportToXls);
bindDropHandlers();

initMap();

function initMap() {
  mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN;

  map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/outdoors-v12",
    center: [0, 20],
    zoom: 1.8,
    projection: "mercator",
  });

  map.addControl(new mapboxgl.NavigationControl(), "top-right");

  map.on("load", () => {
    map.resize();

    map.addSource("bbox", {
      type: "geojson",
      data: emptyFeatureCollection(),
    });

    map.addLayer({
      id: "bbox-fill",
      type: "fill",
      source: "bbox",
      paint: {
        "fill-color": "#2f7d4b",
        "fill-opacity": 0.18,
      },
    });

    map.addLayer({
      id: "bbox-line",
      type: "line",
      source: "bbox",
      paint: {
        "line-color": "#2f7d4b",
        "line-width": 2,
      },
    });

    setStatus("");
    bindDrawHandlers();
  });

  map.on("error", (event) => {
    if (event?.error?.message?.includes("access token")) {
      setStatus("Mapbox token looks invalid. Check your access token.", true);
    }
  });

  window.addEventListener("resize", () => {
    map.resize();
    if (drawMode && !isMobileViewport()) {
      setMobileFrameVisible(false);
      map.getCanvas().style.cursor = "crosshair";
      drawHint.textContent = "Drag on the map to define your query area.";
    } else if (drawMode && isMobileViewport()) {
      setMobileFrameVisible(true);
      map.getCanvas().style.cursor = "";
      drawHint.textContent =
        "Pan and zoom until the area fits inside the frame.";
    }
  });
}

function isMobileViewport() {
  return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
}

function setMobileFrameVisible(visible) {
  drawFrameLayer.hidden = !visible;
  if (visible) {
    updateAreaFeature(null);
  } else if (currentArea?.geojson) {
    updateAreaFeature(currentArea.geojson);
  }
}

function exitDrawMode() {
  drawMode = false;
  drawBtn.classList.remove("active");
  setMobileFrameVisible(false);
  if (map) {
    map.getCanvas().style.cursor = "";
  }
  drawHint.textContent = "Draw a box or drop GeoJSON on the map.";
}

function bindDrawHandlers() {
  map.on("mousedown", onMouseDown);
  map.on("mousemove", onMouseMove);
  map.on("mouseup", onMouseUp);
}

function toggleDrawMode() {
  drawMode = !drawMode;
  drawBtn.classList.toggle("active", drawMode);

  if (isMobileViewport()) {
    setMobileFrameVisible(drawMode);
    drawHint.textContent = drawMode
      ? "Pan and zoom until the area fits inside the frame."
      : "Draw a box or drop GeoJSON on the map.";
    if (map) {
      map.getCanvas().style.cursor = "";
    }
    return;
  }

  setMobileFrameVisible(false);
  if (map) {
    map.getCanvas().style.cursor = drawMode ? "crosshair" : "";
  }
  drawHint.textContent = drawMode
    ? "Drag on the map to define your query area."
    : "Draw a box or drop GeoJSON on the map.";
}

function confirmMobileFrame() {
  if (!map || !drawMode) return;

  const canvas = map.getCanvas();
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const corners = [
    map.unproject([w * FRAME_LEFT, h * FRAME_TOP]),
    map.unproject([w * (FRAME_LEFT + FRAME_WIDTH), h * FRAME_TOP]),
    map.unproject([
      w * (FRAME_LEFT + FRAME_WIDTH),
      h * (FRAME_TOP + FRAME_HEIGHT),
    ]),
    map.unproject([w * FRAME_LEFT, h * (FRAME_TOP + FRAME_HEIGHT)]),
  ];
  const lngs = corners.map((point) => point.lng);

  if (crossesAntimeridian(lngs)) {
    setStatus(
      "This frame crosses the antimeridian. Pan the map and try again.",
      true,
    );
    return;
  }

  const bounds = boundsFromCorners(corners);
  if (!bounds) {
    setStatus("Area too small. Zoom out or pan to a larger region.", true);
    return;
  }

  setStatus("");
  exitDrawMode();
  setQueryArea({
    wkt: bboxToWkt(bounds),
    geojson: bboxFeature(bounds),
    label: formatBounds(bounds),
  });
}

function crossesAntimeridian(lngs) {
  return lngs.some((lng) => lng < -180 || lng > 180);
}

function clampLatitude(lat) {
  return Math.min(
    Math.max(lat, -WEB_MERCATOR_LAT_LIMIT),
    WEB_MERCATOR_LAT_LIMIT,
  );
}

function boundsFromCorners(corners) {
  const lngs = corners.map((point) => point.lng);
  const lats = corners.map((point) => point.lat);
  const west = Math.min(...lngs);
  const east = Math.max(...lngs);
  const south = clampLatitude(Math.min(...lats));
  const north = clampLatitude(Math.max(...lats));

  if (south >= north || west >= east) {
    return null;
  }

  return {
    west,
    east,
    south,
    north,
    width: east - west,
    height: north - south,
  };
}

function onMouseDown(event) {
  if (!drawMode || isMobileViewport() || event.originalEvent.button !== 0) return;
  event.preventDefault();
  dragStart = event.lngLat;
  map.dragPan.disable();
  document.addEventListener("mouseup", onDocumentMouseUp);
}

function onMouseMove(event) {
  if (!dragStart) return;
  updateAreaFeature(bboxFeature(boundsFromPoints(dragStart, event.lngLat)));
}

function onMouseUp(event) {
  finalizeDrag(event.lngLat);
}

function onDocumentMouseUp() {
  finalizeDrag(null);
}

function finalizeDrag(endPoint) {
  document.removeEventListener("mouseup", onDocumentMouseUp);
  if (!dragStart) return;

  const end = endPoint ?? dragStart;
  const bounds = boundsFromPoints(dragStart, end);
  dragStart = null;
  map.dragPan.enable();

  if (bounds.width < 1e-6 || bounds.height < 1e-6) {
    updateAreaFeature(currentArea?.geojson ?? null);
    return;
  }

  setQueryArea({
    wkt: bboxToWkt(bounds),
    geojson: bboxFeature(bounds),
    label: formatBounds(bounds),
  });
  exitDrawMode();
}

function clearArea() {
  exitDrawMode();
  currentArea = null;
  inventory = null;
  updateAreaFeature(null);
  clearBtn.disabled = true;
  submitBtn.disabled = true;
  tableSearch.disabled = true;
  tableSearch.value = "";
  exportBtn.disabled = true;
  geojsonInput.value = "";
  occurrenceCount.textContent = "—";
  resultsBody.innerHTML =
    '<tr class="placeholder-row"><td colspan="2">Draw an area or drop GeoJSON, then query GBIF.</td></tr>';
  drawHint.textContent = "Draw a box or drop GeoJSON on the map.";
  setStatus("");
}

function setQueryArea(area) {
  currentArea = area;
  updateAreaFeature(area.geojson);
  clearBtn.disabled = false;
  submitBtn.disabled = false;
  drawHint.textContent = area.label;

  const bounds = boundsFromGeoJSON(area.geojson);
  if (bounds) {
    map.fitBounds(
      [
        [bounds.west, bounds.south],
        [bounds.east, bounds.north],
      ],
      { padding: 48, duration: 800 },
    );
  }
}

async function runQuery() {
  if (!currentArea) return;

  submitBtn.disabled = true;
  tableSearch.disabled = true;
  setStatus("Querying GBIF…");

  try {
    const { wkt, usedBboxFallback } = wktForQuery(currentArea);
    inventory = await searchInventory(wkt, 50, true);
    occurrenceCount.textContent = formatCount(inventory.occurrence_count);
    tableSearch.disabled = false;
    exportBtn.disabled = false;
    renderTable();

    if (usedBboxFallback) {
      setStatus(
        "Results use the bounding box of your GeoJSON. The polygon was too complex for a direct GBIF browser query.",
      );
      return;
    }

    setStatus(`Geometry: ${inventory.geometry}`);
  } catch (error) {
    setStatus(formatQueryError(error, currentArea.wkt), true);
  } finally {
    submitBtn.disabled = false;
  }
}

async function searchInventory(wkt, facetLimit, resolve) {
  const payload = await getJson("/occurrence/search", {
    geometry: wkt,
    limit: 0,
    facet: FACETS,
    facetLimit,
  });

  const facets = facetMap(payload);

  const [species, datasets, publishers] = await Promise.all([
    enrich("SPECIES_KEY", facets.SPECIES_KEY || [], resolve),
    enrich("DATASET_KEY", facets.DATASET_KEY || [], resolve),
    enrich("PUBLISHING_ORG", facets.PUBLISHING_ORG || [], resolve),
  ]);

  return {
    geometry: wkt,
    occurrence_count: payload.count || 0,
    species,
    datasets,
    publishers,
    years: (facets.YEAR || []).map((entry) => ({
      year: Number(entry.name),
      count: entry.count,
    })),
    basis_of_record: (facets.BASIS_OF_RECORD || []).map((entry) => ({
      basisOfRecord: entry.name,
      count: entry.count,
    })),
  };
}

async function enrich(field, counts, resolve) {
  const fieldKey = {
    SPECIES_KEY: "speciesKey",
    DATASET_KEY: "datasetKey",
    PUBLISHING_ORG: "publishingOrg",
  }[field];

  if (!resolve || !fieldKey) {
    return counts.map((entry) => ({ key: entry.name, count: entry.count }));
  }

  const names = await Promise.all(
    counts.map((entry) => resolveName(fieldKey, entry.name)),
  );

  return counts.map((entry, index) => ({
    key: entry.name,
    name: names[index],
    count: entry.count,
  }));
}

async function resolveName(kind, key) {
  const route = RESOLVE_ROUTES[kind]?.(key);
  if (!route) return key;

  try {
    const data = await getJson(route);
    return data.scientificName || data.title || key;
  } catch {
    return key;
  }
}

function facetMap(payload) {
  return Object.fromEntries(
    (payload.facets || []).map((facet) => [facet.field, facet.counts || []]),
  );
}

async function getJson(path, params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      value.forEach((entry) => search.append(key, String(entry)));
    } else if (value !== undefined && value !== null) {
      search.set(key, String(value));
    }
  }

  const query = search.toString();
  const url = `${API}${path}${query ? `?${query}` : ""}`;

  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new QueryError("network", error, params.geometry);
  }

  if (response.status === 414) {
    throw new QueryError("url_too_long", null, params.geometry);
  }

  if (response.status === 400) {
    throw new QueryError("bad_geometry", null, params.geometry);
  }

  if (!response.ok) {
    throw new QueryError("http", { status: response.status }, params.geometry);
  }

  return response.json();
}

class QueryError extends Error {
  constructor(kind, detail, geometry) {
    super(kind);
    this.name = "QueryError";
    this.kind = kind;
    this.detail = detail;
    this.geometry = geometry;
  }
}

function wktForQuery(area) {
  if (area.wkt.length <= MAX_QUERY_WKT_LENGTH) {
    return { wkt: area.wkt, usedBboxFallback: false };
  }

  const bounds = boundsFromGeoJSON(area.geojson);
  if (!bounds) {
    throw new QueryError("no_bounds", null, area.wkt);
  }

  return { wkt: bboxToWkt(bounds), usedBboxFallback: true };
}

function formatQueryError(error, geometry = "") {
  const wktLength = geometry?.length ?? 0;

  if (error instanceof QueryError) {
    switch (error.kind) {
      case "network":
        if (wktLength > MAX_QUERY_WKT_LENGTH) {
          return "Could not reach GBIF. The selected geometry is very complex and may exceed browser URL limits. Try drawing a simpler bounding box instead.";
        }
        return "Could not reach GBIF. Check your internet connection, ad blockers, or try again in a moment.";
      case "url_too_long":
        return "GBIF rejected the query because the geometry URL was too long. Try drawing a bounding box instead of uploading a detailed polygon.";
      case "bad_geometry":
        return "GBIF could not parse the query geometry. Check that the GeoJSON is valid and in WGS84 (EPSG:4326).";
      case "no_bounds":
        return "Could not derive a bounding box from the selected geometry.";
      case "http":
        return `GBIF request failed (HTTP ${error.detail.status}). Try a smaller area or simpler geometry.`;
      default:
        break;
    }
  }

  if (error?.message === "Failed to fetch") {
    if (wktLength > MAX_QUERY_WKT_LENGTH) {
      return "Could not reach GBIF. The selected geometry is very complex and may exceed browser URL limits. Try drawing a simpler bounding box instead.";
    }
    return "Could not reach GBIF. Check your internet connection or try again in a moment.";
  }

  return error?.message || "GBIF query failed.";
}

function renderTable() {
  if (!inventory) return;

  const rows = rowsForTab(activeTab);
  const filter = tableSearch.value.trim().toLowerCase();
  const filtered = filter
    ? rows.filter((row) => row.label.toLowerCase().includes(filter))
    : rows;

  if (!filtered.length) {
    resultsBody.innerHTML =
      '<tr class="placeholder-row"><td colspan="2">No rows match your filter.</td></tr>';
    return;
  }

  resultsBody.innerHTML = filtered
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.label)}</td>
          <td class="col-count">${formatCount(row.count)}</td>
        </tr>
      `,
    )
    .join("");
}

function rowsForTab(tab) {
  const labelKeys = {
    species: ["name", "key"],
    datasets: ["name", "key"],
    publishers: ["name", "key"],
    years: ["year"],
    basis_of_record: ["basisOfRecord"],
  };

  return itemsForTab(tab).map((item) => ({
    label: String(
      labelKeys[tab].map((key) => item[key]).find(Boolean) ?? item.key ?? "",
    ),
    count: item.count,
  }));
}

function itemsForTab(tab) {
  const items = inventory?.[tab] || [];
  if (tab === "years") {
    return [...items].sort((a, b) => Number(b.year) - Number(a.year));
  }
  return items;
}

const EXPORT_SHEETS = [
  {
    tab: "species",
    name: "Species",
    headers: ["Name", "Key", "Count"],
    rows: (items) =>
      items.map((item) => [item.name || item.key, item.key, item.count]),
  },
  {
    tab: "datasets",
    name: "Datasets",
    headers: ["Name", "Key", "Count"],
    rows: (items) =>
      items.map((item) => [item.name || item.key, item.key, item.count]),
  },
  {
    tab: "publishers",
    name: "Publishers",
    headers: ["Name", "Key", "Count"],
    rows: (items) =>
      items.map((item) => [item.name || item.key, item.key, item.count]),
  },
  {
    tab: "years",
    name: "Years",
    headers: ["Year", "Count"],
    rows: (items) => items.map((item) => [item.year, item.count]),
  },
  {
    tab: "basis_of_record",
    name: "Basis of record",
    headers: ["Basis of record", "Count"],
    rows: (items) => items.map((item) => [item.basisOfRecord, item.count]),
  },
];

function exportToXls() {
  if (!inventory || typeof XLSX === "undefined") return;

  const workbook = XLSX.utils.book_new();

  for (const sheet of EXPORT_SHEETS) {
    const items = itemsForTab(sheet.tab);
    const data = [sheet.headers, ...sheet.rows(items)];
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(data),
      sheet.name,
    );
  }

  const date = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(workbook, `gbif-geometry-inventory-${date}.xlsx`);
}

function bboxToWkt(bounds) {
  const { west, south, east, north } = bounds;
  const coords = [
    [west, south],
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ]
    .map(([lon, lat]) => `${lon} ${lat}`)
    .join(",");

  return `POLYGON((${coords}))`;
}

function boundsFromPoints(a, b) {
  return {
    west: Math.min(a.lng, b.lng),
    east: Math.max(a.lng, b.lng),
    south: Math.min(a.lat, b.lat),
    north: Math.max(a.lat, b.lat),
    width: Math.abs(a.lng - b.lng),
    height: Math.abs(a.lat - b.lat),
  };
}

function updateAreaFeature(geojson) {
  if (!map?.getSource("bbox")) return;

  map.getSource("bbox").setData(geojson ?? emptyFeatureCollection());
}

function bboxFeature(bounds) {
  const { west, south, east, north } = bounds;
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [west, south],
              [west, north],
              [east, north],
              [east, south],
              [west, south],
            ],
          ],
        },
      },
    ],
  };
}

function emptyFeatureCollection() {
  return { type: "FeatureCollection", features: [] };
}

function formatBounds(bounds) {
  return `W ${bounds.west.toFixed(4)}, S ${bounds.south.toFixed(4)}, E ${bounds.east.toFixed(4)}, N ${bounds.north.toFixed(4)}`;
}

function bindDropHandlers() {
  ["dragenter", "dragover", "dragleave", "drop"].forEach((eventName) => {
    mapWrap.addEventListener(eventName, (event) => event.preventDefault());
  });

  mapWrap.addEventListener("dragenter", () => {
    dragDepth += 1;
    dropOverlay.classList.add("visible");
    dropOverlay.setAttribute("aria-hidden", "false");
  });

  mapWrap.addEventListener("dragleave", () => {
    dragDepth -= 1;
    if (dragDepth <= 0) {
      dragDepth = 0;
      dropOverlay.classList.remove("visible");
      dropOverlay.setAttribute("aria-hidden", "true");
    }
  });

  mapWrap.addEventListener("drop", async (event) => {
    dragDepth = 0;
    dropOverlay.classList.remove("visible");
    dropOverlay.setAttribute("aria-hidden", "true");

    const file = [...event.dataTransfer.files].find(isGeoJSONFile);
    if (!file) {
      setStatus("Drop a .geojson or .json file.", true);
      return;
    }

    await loadGeoJSONFile(file);
  });
}

function onGeoJSONSelected(event) {
  const file = event.target.files?.[0];
  if (file) {
    loadGeoJSONFile(file);
  }
}

async function loadGeoJSONFile(file) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    applyGeoJSON(parsed, file.name);
    setStatus("");
  } catch {
    setStatus("Could not read that GeoJSON file.", true);
  }
}

function applyGeoJSON(input, label) {
  const polygons = collectPolygons(input);
  let geojson;
  let wkt;

  if (polygons.length) {
    geojson = polygonsToFeatureCollection(polygons);
    wkt = polygonsToWkt(polygons);
  } else {
    const bounds = boundsFromGeoJSON(input);
    if (!bounds) {
      throw new Error("No coordinates found in GeoJSON.");
    }

    geojson = bboxFeature(bounds);
    wkt = bboxToWkt(bounds);
  }

  exitDrawMode();

  setQueryArea({
    wkt,
    geojson,
    label: label || "GeoJSON area",
  });
}

function isGeoJSONFile(file) {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".geojson") ||
    name.endsWith(".json") ||
    file.type.includes("json")
  );
}

function collectPolygons(input) {
  const polygons = [];

  const visit = (geometry) => {
    if (!geometry) return;

    switch (geometry.type) {
      case "Polygon":
        polygons.push(geometry.coordinates);
        break;
      case "MultiPolygon":
        geometry.coordinates.forEach((polygon) => polygons.push(polygon));
        break;
      case "GeometryCollection":
        geometry.geometries.forEach(visit);
        break;
      default:
        break;
    }
  };

  const visitFeature = (feature) => visit(feature?.geometry ?? feature);

  if (input.type === "FeatureCollection") {
    input.features.forEach(visitFeature);
  } else if (input.type === "Feature") {
    visitFeature(input);
  } else {
    visitFeature(input);
  }

  return polygons;
}

function polygonsToFeatureCollection(polygons) {
  return {
    type: "FeatureCollection",
    features: polygons.map((coordinates) => ({
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates },
    })),
  };
}

function polygonsToWkt(polygons) {
  const parts = polygons.map(polygonToWkt);
  if (parts.length === 1) {
    return `POLYGON${parts[0]}`;
  }
  return `MULTIPOLYGON(${parts.join(", ")})`;
}

function polygonToWkt(coordinates) {
  const rings = coordinates
    .map((ring) => `(${ring.map(([lon, lat]) => `${lon} ${lat}`).join(", ")})`)
    .join(", ");
  return `(${rings})`;
}

function boundsFromGeoJSON(geojson) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  const visitCoords = (coords) => {
    if (typeof coords[0] === "number") {
      const [lon, lat] = coords;
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
      return;
    }

    coords.forEach(visitCoords);
  };

  const visitGeometry = (geometry) => {
    if (!geometry) return;

    if (geometry.type === "GeometryCollection") {
      geometry.geometries.forEach(visitGeometry);
      return;
    }

    if (geometry.coordinates) {
      visitCoords(geometry.coordinates);
    }
  };

  if (geojson.type === "FeatureCollection") {
    geojson.features.forEach((feature) => visitGeometry(feature.geometry));
  } else if (geojson.type === "Feature") {
    visitGeometry(geojson.geometry);
  } else {
    visitGeometry(geojson);
  }

  if (!Number.isFinite(west)) {
    return null;
  }

  return { west, south, east, north };
}

function formatCount(value) {
  return Number(value).toLocaleString();
}

function setStatus(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.classList.toggle("error", isError);
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
