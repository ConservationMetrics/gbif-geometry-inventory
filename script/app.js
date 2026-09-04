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
const FACET_PAGE_SIZE = 1000;
const TABLE_PAGE_SIZE = 100;
const RESOLVE_CONCURRENCY = 8;
const TAB_LABELS = {
  species: "Species",
  datasets: "Datasets",
  publishers: "Publishers",
  years: "Years",
  basis_of_record: "Basis of record",
};
const RESOLVE_ROUTES = {
  speciesKey: (key) => `/species/${key}`,
  datasetKey: (key) => `/dataset/${key}`,
  publishingOrg: (key) => `/organization/${key}`,
};
const WIKIDATA_SPARQL_URL = "https://query.wikidata.org/sparql";
const WIKIPEDIA_API_URL = "https://en.wikipedia.org/w/api.php";
const WIKIPEDIA_ARTICLE_BASE = "https://en.wikipedia.org/wiki/";
const WIKIPEDIA_TITLES_PER_REQUEST = 50;
const WIKIMEDIA_TIMEOUT_MS = 10000;

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
const viewOnGbifBtn = document.getElementById("viewOnGbifBtn");
const resultsBody = document.getElementById("resultsBody");
const tablePagination = document.getElementById("tablePagination");
const tablePrev = document.getElementById("tablePrev");
const tableNext = document.getElementById("tableNext");
const tablePageInfo = document.getElementById("tablePageInfo");
const statusMessage = document.getElementById("statusMessage");
const statusSpinner = document.getElementById("statusSpinner");
const statusText = document.getElementById("statusText");
const queryLoaderText = document.getElementById("queryLoaderText");
const tabs = document.querySelectorAll(".tab");

const prefersReducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
);

// Loading phases surfaced in the query button, in pipeline order. Kept
// short so the longest label fits the loading pill without truncation.
const QUERY_PHASE_LABELS = {
  scan: "Scanning area",
  resolve: "Resolving taxa",
  wiki: "Gathering context",
};

let map;
let drawMode = false;
let dragStart = null;
let currentArea = null;
let inventory = null;
let activeTab = "datasets";
let tablePage = 0;
let dragDepth = 0;
let speciesLoading = false;

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    setActiveTab(tab.dataset.tab);
    renderTable();
  });
});

tableSearch.addEventListener("input", () => {
  tablePage = 0;
  renderTable();
});
tablePrev.addEventListener("click", () => {
  tablePage -= 1;
  renderTable();
});
tableNext.addEventListener("click", () => {
  tablePage += 1;
  renderTable();
});
drawBtn.addEventListener("click", toggleDrawMode);
confirmFrameBtn.addEventListener("click", confirmMobileFrame);
clearBtn.addEventListener("click", clearArea);
submitBtn.addEventListener("click", runQuery);
geojsonInput.addEventListener("change", onGeoJSONSelected);
exportBtn.addEventListener("click", exportToXls);
viewOnGbifBtn.addEventListener("click", openOnGbif);

// Species card: hover on pointer devices, tap on touch, keyboard focus plus
// Enter/Space. Shows the Wikipedia thumbnail, short description, and links.
// A click (or Enter) pins the card open so its links stay reachable without
// holding the pointer on the row; clicking the row, pressing Escape, or
// clicking anywhere else releases it.
const speciesCard = document.createElement("div");
speciesCard.className = "species-card";
// Interactive popover, not a passive tooltip: focusable (tabindex -1) so
// keyboard activation can hand focus to it, announced as a dialog.
speciesCard.setAttribute("role", "dialog");
speciesCard.setAttribute("aria-label", "Species details");
speciesCard.tabIndex = -1;
document.body.appendChild(speciesCard);

const canHover = window.matchMedia("(hover: hover)");
// Browsers without :focus-visible predate it and never focus rows on tap,
// so focusin there is always keyboard and may preview unconditionally.
const supportsFocusVisible = CSS.supports?.("selector(:focus-visible)") ?? false;

resultsBody.addEventListener("mouseover", (event) => {
  if (!canHover.matches) return;
  // A pinned card ignores the pointer entirely: hover keeps it, only an
  // explicit click (another row, the same row, or outside) changes it.
  if (speciesCard.classList.contains("pinned")) return;
  const row = event.target.closest("tr[data-summary]");
  if (row) showSpeciesCard(row);
});

// The card floats below the row, outside it in the DOM, so moving the
// pointer from row to card fires mouseout on the row. Hiding must be
// delayed and cancellable, or the card (and its Wikipedia link) could
// never be reached on pointer devices.
resultsBody.addEventListener("mouseout", (event) => {
  if (!canHover.matches) return;
  const row = event.target.closest("tr[data-summary]");
  if (
    row &&
    !row.contains(event.relatedTarget) &&
    !speciesCard.contains(event.relatedTarget)
  ) {
    scheduleSpeciesCardHide();
  }
});

speciesCard.addEventListener("mouseover", cancelSpeciesCardHide);
speciesCard.addEventListener("mouseout", (event) => {
  if (!speciesCard.contains(event.relatedTarget)) scheduleSpeciesCardHide();
});
speciesCard.addEventListener("focusin", cancelSpeciesCardHide);
speciesCard.addEventListener("focusout", (event) => {
  if (!speciesCard.contains(event.relatedTarget)) scheduleSpeciesCardHide();
});

resultsBody.addEventListener("click", (event) => {
  if (event.target.closest("a")) return;
  const row = event.target.closest("tr[data-summary]");
  if (!row) {
    hideSpeciesCard();
    return;
  }
  // Pointer devices: click pins/toggles. Touch keeps the show/hide toggle.
  if (canHover.matches) {
    toggleSpeciesCard(row);
    return;
  }
  // Only a tap-opened card toggles closed on the next tap; one opened by
  // focus-preview or hover becomes tap-opened instead, then closes next tap.
  if (
    speciesCard.classList.contains("visible") &&
    speciesCard.dataset.key === row.dataset.key &&
    speciesCardOpener === "tap"
  ) {
    hideSpeciesCard();
  } else {
    showSpeciesCard(row, { source: "tap" });
  }
});

// Keyboard parity for the card: focusing a row previews it like hover,
// Enter or Space pins it like a click (focus moves onto the card so its
// links are one Tab away), Escape closes it.
resultsBody.addEventListener("focusin", (event) => {
  // Restoring focus after a close re-enters here synchronously; without
  // this guard Escape would instantly reopen what it just closed.
  if (restoringCardFocus) return;
  if (speciesCard.classList.contains("pinned")) return;
  const row = event.target.closest("tr[data-summary]");
  // :focus-visible filters to keyboard focus: taps also focus the row on
  // touch devices, and a tap belongs to the click toggle, not a preview.
  if (
    row &&
    (!supportsFocusVisible || event.target.matches(":focus-visible"))
  ) {
    speciesCardInvoker = row;
    showSpeciesCard(row, { source: "focus" });
  }
});

resultsBody.addEventListener("focusout", (event) => {
  const row = event.target.closest("tr[data-summary]");
  if (
    row &&
    !row.contains(event.relatedTarget) &&
    !speciesCard.contains(event.relatedTarget)
  ) {
    scheduleSpeciesCardHide();
  }
});

resultsBody.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest("tr[data-summary]");
  if (!row) return;
  event.preventDefault();
  toggleSpeciesCard(row);
  if (
    speciesCard.classList.contains("visible") &&
    speciesCard.dataset.key === row.dataset.key
  ) {
    (speciesCard.querySelector(".card-links a") ?? speciesCard).focus();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideSpeciesCard();
});

document.addEventListener("click", (event) => {
  if (
    !speciesCard.contains(event.target) &&
    !event.target.closest("#resultsBody")
  ) {
    hideSpeciesCard();
  }
});

// Capture on document, not window: the results table scrolls inside
// .table-wrap, and element scroll events never bubble up to the window.
// Scrolling the card's own overflow-y body must not dismiss it.
document.addEventListener(
  "scroll",
  (event) => {
    if (!speciesCard.contains(event.target)) hideSpeciesCard();
  },
  { passive: true, capture: true },
);
window.addEventListener("resize", hideSpeciesCard, { passive: true });

let speciesCardHideTimer = null;

function scheduleSpeciesCardHide(delay = 250) {
  // A pinned card ignores pointer drift; only an explicit click hides it.
  if (speciesCard.classList.contains("pinned")) return;
  clearTimeout(speciesCardHideTimer);
  speciesCardHideTimer = setTimeout(hideSpeciesCard, delay);
}

function cancelSpeciesCardHide() {
  if (speciesCardHideTimer === null) return;
  clearTimeout(speciesCardHideTimer);
  speciesCardHideTimer = null;
}

function showSpeciesCard(row, { pin = false, source = "hover" } = {}) {
  cancelSpeciesCardHide();
  // mouseover bubbles from every child of the row; rebuilding the card each
  // time would restart the image load. Same row while visible: nothing to do
  // except promoting a hover-shown card to pinned.
  if (
    speciesCard.classList.contains("visible") &&
    speciesCard.dataset.key === row.dataset.key
  ) {
    if (pin) speciesCard.classList.add("pinned");
    speciesCardOpener = pin ? "pin" : source;
    return;
  }

  let data;
  try {
    data = JSON.parse(row.dataset.summary);
  } catch {
    hideSpeciesCard();
    return;
  }

  speciesCard.dataset.key = row.dataset.key;
  speciesCard.setAttribute("aria-label", String(data.n || "Species details"));
  // Hovering a different row replaces the card and releases any previous
  // pin; only a click keeps it latched.
  speciesCard.classList.toggle("pinned", pin);
  speciesCardOpener = pin ? "pin" : source;
  // Wikipedia supplies what it has; GBIF fills the gaps (photo for species
  // without a thumbnail, classification, taxon and Wikidata links).
  const gbifKey = row.dataset.key;
  const cardLink = (href, label) =>
    `<a class="card-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label} <span aria-hidden="true">↗</span></a>`;
  const links = [
    data.w ? cardLink(data.w, "Wikipedia") : "",
    data.q ? cardLink(data.q, "Wikidata") : "",
    gbifKey
      ? cardLink(
          `https://www.gbif.org/species/${encodeURIComponent(gbifKey)}`,
          "GBIF",
        )
      : "",
  ]
    .filter(Boolean)
    .join("");
  const childTaxa = data.k
    ? `<span class="card-children">· ${escapeHtml(String(data.k))} child taxa</span>`
    : "";

  speciesCard.innerHTML = `
    ${data.t || gbifKey ? `<div class="card-img" data-photo>${data.t ? `<img src="${escapeHtml(data.t)}" alt="" referrerpolicy="no-referrer" />` : ""}</div>` : ""}
    <div class="card-name">${escapeHtml(String(data.n ?? ""))}</div>
    ${data.d ? `<p class="card-desc">${escapeHtml(data.d)}</p>` : ""}
    ${data.c ? `<p class="card-class">${escapeHtml(data.c)} ${childTaxa}</p>` : childTaxa ? `<p class="card-class">${childTaxa}</p>` : ""}
    ${links ? `<div class="card-links">${links}</div>` : ""}
  `;
  speciesCard.classList.add("visible");

  if (!data.t && gbifKey) {
    loadGbifPhoto(gbifKey).then((url) => {
      if (speciesCard.dataset.key !== row.dataset.key) return;
      const box = speciesCard.querySelector("[data-photo]");
      if (!box) return;
      if (!url) {
        // No usable photo: drop the reserved box instead of showing an
        // empty placeholder. Removing it shrinks the card, so the position
        // computed below (based on the taller, photo-reserving layout) must
        // be redone or the card can end up stranded away from the row.
        box.remove();
        if (speciesCard.classList.contains("visible")) positionSpeciesCard(row);
        return;
      }
      if (!speciesCard.classList.contains("visible")) return;
      box.innerHTML = `<img src="${escapeHtml(url)}" alt="" referrerpolicy="no-referrer" />`;
      positionSpeciesCard(row);
    });
  }

  positionSpeciesCard(row);
}

// Sizes and coordinates the popover against the row it belongs to. Called
// again whenever the card's content changes height after the initial paint
// (e.g. the reserved photo box is dropped or filled in asynchronously),
// since a stale top/left would leave the card floating away from the row.
function positionSpeciesCard(row) {
  // hideSpeciesCard() doesn't clear dataset.key, so a re-render between
  // opening the card and an async reposition (e.g. loadGbifPhoto resolving)
  // can pass a detached row here; its rect would be all-zero and snap the
  // card to the viewport corner.
  if (!row.isConnected) return;
  const pad = 12;
  const rowRect = row.getBoundingClientRect();
  const cardRect = speciesCard.getBoundingClientRect();
  const left = Math.max(
    pad,
    Math.min(rowRect.left, window.innerWidth - cardRect.width - pad),
  );
  // A 1px overlap, not a gap: rows sit flush with no dead zone between them,
  // so a real gap here lets the pointer land on the next row (swapping the
  // card) or the table background (triggering the hide timer) before it
  // ever reaches the card.
  let top = rowRect.bottom - 1;
  if (top + cardRect.height > window.innerHeight - pad) {
    top = Math.max(pad, rowRect.top - cardRect.height + 1);
  }
  speciesCard.style.left = `${left}px`;
  speciesCard.style.top = `${top}px`;
}

let speciesCardInvoker = null;
let speciesCardOpener = null;
let restoringCardFocus = false;

function hideSpeciesCard() {
  cancelSpeciesCardHide();
  // Keyboard activation parks focus inside the card; capture the restore
  // target before display:none, or the browser drops focus to <body> and
  // the next Tab restarts from the page top. preventScroll keeps the
  // restore from yanking the invoker row back into view mid-scroll, and
  // the flag stops the synchronous focusin from reopening the card.
  const restoreFocus = speciesCard.contains(document.activeElement);
  speciesCard.classList.remove("visible", "pinned");
  if (restoreFocus) {
    restoringCardFocus = true;
    speciesCardInvoker?.focus({ preventScroll: true });
    restoringCardFocus = false;
  }
  speciesCardInvoker = null;
  speciesCardOpener = null;
}

// Pointer-device click and keyboard activation share this: open-and-pin,
// or close when the same row's card is already pinned.
function toggleSpeciesCard(row) {
  speciesCardInvoker = row;
  const isOpen =
    speciesCard.classList.contains("visible") &&
    speciesCard.dataset.key === row.dataset.key;
  if (isOpen && speciesCard.classList.contains("pinned")) {
    hideSpeciesCard();
  } else {
    showSpeciesCard(row, { pin: true });
  }
}
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
  speciesLoading = false;
  updateAreaFeature(null);
  clearBtn.disabled = true;
  submitBtn.disabled = true;
  tableSearch.disabled = true;
  tableSearch.value = "";
  exportBtn.disabled = true;
  viewOnGbifBtn.disabled = true;
  geojsonInput.value = "";
  tablePage = 0;
  tablePagination.hidden = true;
  occurrenceCount.textContent = "—";
  setActiveTab("datasets");
  resetTabLabels();
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
  exportBtn.disabled = true;
  viewOnGbifBtn.disabled = true;
  setStatus("Querying GBIF…", false, true);

  try {
    // Inside the try so a throw here still reaches the catch/finally and
    // cannot strand the button disabled with the pulse loop running.
    beginQueryAnimation();
    const { wkt, usedBboxFallback } = wktForQuery(currentArea);
    setQueryPhase("resolve");
    inventory = await searchInventoryCore(wkt);
    occurrenceCount.textContent = formatCount(inventory.occurrence_count);
    updateTabLabels(inventory.totals);
    setActiveTab("datasets");
    tableSearch.disabled = false;
    viewOnGbifBtn.disabled = false;
    renderTable();
    submitBtn.disabled = false;

    endQueryAnimation(true);

    setStatus("Loading species names…", false, true);

    setQueryPhase("wiki");
    loadSpeciesInventory(wkt).then(() => {
      exportBtn.disabled = false;
      if (usedBboxFallback) {
        setGeometryStatus(
          wkt,
          "Results use the bounding box of your GeoJSON. The polygon was too complex for a direct GBIF browser query.",
        );
        return;
      }
      setGeometryStatus(wkt);
    });
  } catch (error) {
    setStatus(formatQueryError(error, currentArea.wkt), true);
    endQueryAnimation(false);
    submitBtn.disabled = false;
  }
}

// Query button loading choreography. Back-to-back queries restart the grow:
// .is-loading is dropped too before the forced reflow, so re-adding it
// restarts the one-shot forwards animations instead of no-opping on a
// button still inside endQueryAnimation's cleanup window.
let queryAnimTimer = null;
let queryPhaseTimer = null;

function beginQueryAnimation() {
  clearTimeout(queryAnimTimer);
  clearTimeout(queryPhaseTimer);
  submitBtn.setAttribute("aria-busy", "true");
  submitBtn.classList.remove("is-loading", "is-done", "is-error");
  void submitBtn.offsetWidth;
  submitBtn.classList.add("is-loading");
  queryLoaderText.classList.remove("swap");
  queryLoaderText.textContent = QUERY_PHASE_LABELS.scan;
  startAreaPulse();
}

function endQueryAnimation(succeeded) {
  submitBtn.removeAttribute("aria-busy");
  clearTimeout(queryPhaseTimer);
  stopAreaPulse();
  if (prefersReducedMotion.matches) {
    submitBtn.classList.remove("is-loading");
    return;
  }
  submitBtn.classList.add(succeeded ? "is-done" : "is-error");
  if (succeeded) spawnLeafBurst();
  queryAnimTimer = setTimeout(() => {
    submitBtn.classList.remove("is-loading", "is-done", "is-error");
  }, 650);
}

function setQueryPhase(phase) {
  // Tracked and cleared: a pending swap from the previous query would
  // otherwise overwrite the reset "Scanning area" label.
  clearTimeout(queryPhaseTimer);
  const label = QUERY_PHASE_LABELS[phase];
  if (!label || queryLoaderText.textContent === label) return;
  queryLoaderText.classList.add("swap");
  queryPhaseTimer = setTimeout(() => {
    queryLoaderText.textContent = label;
    queryLoaderText.classList.remove("swap");
  }, 180);
}

// Success flourish: leaves scatter out of the button on an upward arc.
// Web Animations API keeps the cleanup trivial (remove on finish).
// Saturated greens only — the burst flies over the light page background,
// where pale greens would wash out.
function spawnLeafBurst() {
  const colors = ["#2f7d4b", "#25633c", "#4ea06f", "#3c9a63", "#1e5233"];
  for (let i = 0; i < 12; i++) {
    const leaf = document.createElement("span");
    leaf.className = "burst-leaf";
    leaf.innerHTML = `<svg viewBox="0 0 20 20"><path d="M17 2 C 8 3.5, 3.5 8, 2 17 C 11 15.5, 15.5 11, 17 2 Z" fill="${colors[i % colors.length]}"/></svg>`;
    leaf.style.opacity = "0";
    submitBtn.appendChild(leaf);

    // Upward fan from the sprout: leaves clear the pill quickly and arc
    // over the light toolbar, where the saturated greens read best.
    const theta = (i / 11 - 0.5) * 2.6 + (Math.random() - 0.5) * 0.2;
    const dist = 64 + Math.random() * 52;
    const dx = Math.sin(theta) * dist;
    const dy = -Math.cos(theta) * dist;
    const spin = (Math.random() * 2 - 1) * 420;
    const baseTilt = Math.random() * 360;
    leaf
      .animate(
        [
          {
            transform: `translate(-50%, -50%) translate(0, 0) rotate(${baseTilt}deg) scale(0.7)`,
            opacity: 1,
          },
          {
            transform: `translate(-50%, -50%) translate(${dx * 0.55}px, ${dy * 0.75}px) rotate(${baseTilt + spin * 0.5}deg) scale(1.1)`,
            opacity: 1,
            offset: 0.75,
          },
          {
            transform: `translate(-50%, -50%) translate(${dx}px, ${dy + 30}px) rotate(${baseTilt + spin}deg) scale(0.9)`,
            opacity: 0,
          },
        ],
        {
          duration: 750 + Math.random() * 300,
          easing: "cubic-bezier(0.1, 0.7, 0.3, 1)",
          delay: i * 10,
          fill: "backwards",
        },
      )
      .onfinish = () => leaf.remove();
  }
}

// While the query runs, the drawn area breathes on the map — a soft
// fill/line pulse. The resting paint is snapshotted before the first write
// and restored after, so it can never drift from initMap's layer style.
let areaPulseFrame = null;
let areaPulseRest = null;

function startAreaPulse() {
  if (prefersReducedMotion.matches || !map?.getLayer("bbox-fill")) return;
  areaPulseRest = {
    fillOpacity: map.getPaintProperty("bbox-fill", "fill-opacity"),
    lineWidth: map.getPaintProperty("bbox-line", "line-width"),
  };
  const start = performance.now();
  const paint = (now) => {
    if (!map.getLayer("bbox-fill")) return;
    const wave =
      0.5 - 0.5 * Math.cos((((now - start) % 1600) / 1600) * Math.PI * 2);
    map.setPaintProperty("bbox-fill", "fill-opacity", 0.12 + 0.16 * wave);
    map.setPaintProperty("bbox-line", "line-width", 2 + 1.6 * wave);
    areaPulseFrame = requestAnimationFrame(paint);
  };
  areaPulseFrame = requestAnimationFrame(paint);
}

function stopAreaPulse() {
  if (areaPulseFrame) cancelAnimationFrame(areaPulseFrame);
  areaPulseFrame = null;
  if (map?.getLayer("bbox-fill") && areaPulseRest) {
    if (areaPulseRest.fillOpacity != null) {
      map.setPaintProperty("bbox-fill", "fill-opacity", areaPulseRest.fillOpacity);
    }
    if (areaPulseRest.lineWidth != null) {
      map.setPaintProperty("bbox-line", "line-width", areaPulseRest.lineWidth);
    }
  }
  areaPulseRest = null;
}

async function searchInventoryCore(wkt) {
  const countPayload = await getJson("/occurrence/search", {
    geometry: wkt,
    limit: 0,
  });

  setStatus("Fetching results from GBIF…", false, true);

  const [datasetCounts, publisherCounts, yearCounts, basisCounts] =
    await Promise.all([
      fetchAllFacetValues(wkt, "datasetKey"),
      fetchAllFacetValues(wkt, "publishingOrg"),
      fetchAllFacetValues(wkt, "year"),
      fetchAllFacetValues(wkt, "basisOfRecord"),
    ]);

  setStatus("Resolving names…", false, true);

  const [datasets, publishers] = await Promise.all([
    enrich("DATASET_KEY", datasetCounts, true),
    enrich("PUBLISHING_ORG", publisherCounts, true),
  ]);

  const totals = {
    datasets: datasets.length,
    publishers: publishers.length,
    years: yearCounts.length,
    basis_of_record: basisCounts.length,
    species: null,
  };

  return {
    geometry: wkt,
    occurrence_count: countPayload.count || 0,
    totals,
    species: [],
    speciesError: null,
    datasets,
    publishers,
    years: yearCounts.map((entry) => ({
      year: Number(entry.name),
      count: entry.count,
    })),
    basis_of_record: basisCounts.map((entry) => ({
      basisOfRecord: entry.name,
      count: entry.count,
    })),
  };
}

async function loadSpeciesInventory(wkt) {
  speciesLoading = true;
  updateSpeciesTabLabel();

  try {
    const speciesCounts = await fetchAllFacetValues(wkt, "speciesKey");
    inventory.totals.species = speciesCounts.length;
    updateTabLabels(inventory.totals);
    const rawSpecies = await enrich("SPECIES_KEY", speciesCounts, true);

    // One shared Wikimedia budget covers link resolution and summaries, so
    // slow secondary services can only ever delay species loading by one
    // timeout window in total.
    const wikiDeadline = Date.now() + WIKIMEDIA_TIMEOUT_MS;
    const species = await enrichSpeciesWithWikipedia(rawSpecies, wikiDeadline);
    await attachWikipediaSummaries(species, wikiDeadline);
    inventory.species = species;
  } catch (error) {
    inventory.speciesError = formatQueryError(error, wkt);
  } finally {
    speciesLoading = false;
    updateSpeciesTabLabel();
    if (activeTab === "species") {
      renderTable();
    }
  }
}

async function fetchAllFacetValues(wkt, facet) {
  let offset = 0;
  const all = [];

  while (true) {
    const payload = await getJson("/occurrence/search", {
      geometry: wkt,
      limit: 0,
      facet: [facet],
      facetLimit: FACET_PAGE_SIZE,
      facetOffset: offset,
    });
    const batch = payload.facets?.[0]?.counts ?? [];
    all.push(...batch);

    if (batch.length < FACET_PAGE_SIZE) {
      return all;
    }

    offset += FACET_PAGE_SIZE;
  }
}

function setActiveTab(tabKey) {
  activeTab = tabKey;
  tablePage = 0;
  tabs.forEach((button) =>
    button.classList.toggle("active", button.dataset.tab === tabKey),
  );
  tableSearch.value = "";
}

function updateTabLabels(totals) {
  tabs.forEach((tab) => {
    const key = tab.dataset.tab;
    if (key === "species") {
      updateSpeciesTabLabel(totals);
      return;
    }

    const base = TAB_LABELS[key];
    const total = totals?.[key];
    tab.textContent =
      total != null ? `${base} (${formatCount(total)})` : base;
  });
}

function updateSpeciesTabLabel(totals = inventory?.totals) {
  const tab = document.querySelector('.tab[data-tab="species"]');
  if (!tab) return;

  const base = TAB_LABELS.species;
  const total = totals?.species;
  const label = total != null ? `${base} (${formatCount(total)})` : base;

  if (speciesLoading) {
    tab.innerHTML = `${escapeHtml(label)} <span class="tab-spinner" aria-hidden="true"></span>`;
    tab.setAttribute("aria-busy", "true");
    return;
  }

  tab.textContent = label;
  tab.removeAttribute("aria-busy");
}

function resetTabLabels() {
  speciesLoading = false;
  tabs.forEach((tab) => {
    tab.textContent = TAB_LABELS[tab.dataset.tab];
    tab.removeAttribute("aria-busy");
  });
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

  const names = await mapPool(
    counts,
    (entry) => resolveName(fieldKey, entry.name),
    RESOLVE_CONCURRENCY,
  );

  return counts.map((entry, index) => ({
    key: entry.name,
    name: names[index].name,
    canonical: names[index].canonical,
    kingdom: names[index].kingdom,
    phylum: names[index].phylum,
    taxonClass: names[index].taxonClass,
    order: names[index].order,
    family: names[index].family,
    genus: names[index].genus,
    childTaxa: names[index].childTaxa,
    count: entry.count,
  }));
}

async function mapPool(items, mapper, concurrency) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return results;
}

const EMPTY_NAME = {
  name: null,
  canonical: null,
  kingdom: null,
  phylum: null,
  taxonClass: null,
  order: null,
  family: null,
  genus: null,
  childTaxa: null,
};

async function resolveName(kind, key) {
  const route = RESOLVE_ROUTES[kind]?.(key);
  if (!route) return { ...EMPTY_NAME, name: key };

  try {
    const data = await getJson(route);
    const isSpecies = kind === "speciesKey";
    return {
      ...EMPTY_NAME,
      name: data.scientificName || data.title || key,
      canonical: isSpecies ? data.canonicalName || null : null,
      kingdom: isSpecies ? data.kingdom || null : null,
      phylum: isSpecies ? data.phylum || null : null,
      taxonClass: isSpecies ? data.class || null : null,
      order: isSpecies ? data.order || null : null,
      family: isSpecies ? data.family || null : null,
      genus: isSpecies ? data.genus || null : null,
      childTaxa: isSpecies
        ? Number.isFinite(data.numDescendants) && data.numDescendants > 0
          ? data.numDescendants
          : null
        : null,
    };
  } catch {
    return { ...EMPTY_NAME, name: key };
  }
}

// Wikipedia enrichment is best-effort: any Wikimedia failure leaves the
// GBIF species untouched with wikipediaUrl null, never fails the inventory.
// One shared deadline bounds the total wait across both resolution phases.
async function enrichSpeciesWithWikipedia(
  species,
  deadline = Date.now() + WIKIMEDIA_TIMEOUT_MS,
) {
  const enriched = species.map((item) => ({
    ...item,
    wikipediaUrl: null,
    wikidataUrl: null,
  }));
  if (!enriched.length) return enriched;

  try {
    const matchesByGbifId = await wikipediaMatchesByGbifId(enriched, deadline);
    for (const item of enriched) {
      const match = matchesByGbifId.get(String(item.key));
      if (match?.article) item.wikipediaUrl = match.article;
      if (match?.wikidata) item.wikidataUrl = match.wikidata;
    }
  } catch {
    // Keep GBIF results as-is.
  }

  try {
    const unresolved = [
      ...new Map(
        enriched
          .filter(
            (item) =>
              !item.wikipediaUrl &&
              ((item.canonical && item.canonical !== item.key) ||
                (item.name && item.name !== item.key)),
          )
          .map((item) => [item.canonical || item.name, item]),
      ).values(),
    ];
    if (!unresolved.length) return enriched;

    const urlsByTitle = await wikipediaUrlsByTitle(
      unresolved.map((item) => item.canonical || item.name),
      deadline,
    );
    // Iterate every still-unresolved species: several keys can share one
    // canonical name, and all of them get the verified article URL.
    for (const item of enriched) {
      if (item.wikipediaUrl) continue;
      const url = urlsByTitle.get(item.canonical || item.name);
      if (url) item.wikipediaUrl = url;
    }
  } catch {
    // Fallback is optional too.
  }

  return enriched;
}

// GBIF taxon ID -> Wikidata item (+ optional English Wikipedia sitelink),
// batched into a single SPARQL request. The sitelink is OPTIONAL so a taxon
// with no English article still yields its Wikidata item for the card. When
// an ID matches both the legacy P846 and the newer P14607 statement, the
// P14607 binding wins deterministically; fields missing from the winner are
// still filled from the loser.
async function wikipediaMatchesByGbifId(species, deadline) {
  const matches = new Map();
  const ids = [
    ...new Set(species.map((item) => String(item.key)).filter(isSafeTaxonId)),
  ];
  if (!ids.length) return matches;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return matches;

  const values = ids.map((id) => `"${id}"`).join(" ");
  // The matched property is selected as a variable (VALUES on ?prop) instead
  // of BIND inside a UNION branch: Blazegraph hangs on the latter form.
  const query = `SELECT ?gbif ?article ?prop ?taxon WHERE {
  VALUES ?gbif { ${values} }
  ?taxon ?prop ?gbif.
  VALUES ?prop { wdt:P14607 wdt:P846 }
  OPTIONAL {
    ?article schema:about ?taxon;
      schema:isPartOf <https://en.wikipedia.org/>.
  }
}`;
  const params = new URLSearchParams({ query, format: "json" });
  const data = await fetchJsonWithTimeout(
    `${WIKIDATA_SPARQL_URL}?${params}`,
    remaining,
    { headers: { Accept: "application/sparql-results+json" } },
  );

  const merge = (a, b) => ({
    article: a?.article ?? b?.article ?? null,
    wikidata: a?.wikidata ?? b?.wikidata ?? null,
  });
  const legacy = new Map();
  const collect = (map, id, entry) => map.set(id, merge(map.get(id), entry));

  for (const binding of data?.results?.bindings || []) {
    const id = binding.gbif?.value;
    if (!isSafeTaxonId(id)) continue;
    const entry = {
      article: wikipediaArticleUrl(binding.article?.value),
      wikidata: wikidataEntityUrl(binding.taxon?.value),
    };
    if (binding.prop?.value.endsWith("/P14607")) {
      collect(matches, id, entry);
    } else {
      collect(legacy, id, entry);
    }
  }
  for (const [id, entry] of legacy) {
    collect(matches, id, entry);
  }
  return matches;
}

// Scientific-name fallback: batched Wikipedia API lookup that follows
// normalization and redirects, so only verified article URLs come back.
async function wikipediaUrlsByTitle(titles, deadline) {
  const urls = new Map();
  const unique = [...new Set(titles.filter(Boolean))];

  for (let i = 0; i < unique.length; i += WIKIPEDIA_TITLES_PER_REQUEST) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const batch = unique.slice(i, i + WIKIPEDIA_TITLES_PER_REQUEST);
    const params = new URLSearchParams({
      action: "query",
      format: "json",
      formatversion: "2",
      redirects: "1",
      origin: "*",
      titles: batch.join("|"),
    });

    let data;
    try {
      data = await fetchJsonWithTimeout(
        `${WIKIPEDIA_API_URL}?${params}`,
        remaining,
      );
    } catch {
      continue;
    }

    const hops = new Map();
    for (const link of data?.query?.normalized || []) {
      hops.set(link.from, link.to);
    }
    for (const link of data?.query?.redirects || []) {
      hops.set(link.from, link.to);
    }
    const pages = new Map(
      (data?.query?.pages || []).map((page) => [page.title, page]),
    );

    for (const title of batch) {
      const page = pages.get(followHops(hops, title));
      if (!page || page.missing || page.invalid || page.ns !== 0) continue;
      const url = wikipediaArticleUrl(wikipediaArticleUrlFromTitle(page.title));
      if (url) urls.set(title, url);
    }
  }

  return urls;
}

// Wikipedia thumbnails + short descriptions for the species card, batched
// per 50 titles. Best-effort like the links: failures leave the card empty.
async function attachWikipediaSummaries(
  species,
  deadline = Date.now() + WIKIMEDIA_TIMEOUT_MS,
) {
  const withTitle = species
    .filter((item) => item.wikipediaUrl)
    .map((item) => [wikipediaTitleFromUrl(item.wikipediaUrl), item])
    .filter(([title]) => Boolean(title));

  try {
    for (let i = 0; i < withTitle.length; i += WIKIPEDIA_TITLES_PER_REQUEST) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const batch = withTitle.slice(i, i + WIKIPEDIA_TITLES_PER_REQUEST);
      const params = new URLSearchParams({
        action: "query",
        format: "json",
        formatversion: "2",
        redirects: "1",
        origin: "*",
        prop: "pageimages|pageterms",
        piprop: "thumbnail",
        pithumbsize: "240",
        wbptterms: "description",
        titles: batch.map(([title]) => title).join("|"),
      });

      let data;
      try {
        data = await fetchJsonWithTimeout(
          `${WIKIPEDIA_API_URL}?${params}`,
          remaining,
        );
      } catch {
        continue;
      }

      const hops = new Map();
      for (const link of data?.query?.normalized || []) {
        hops.set(link.from, link.to);
      }
      for (const link of data?.query?.redirects || []) {
        hops.set(link.from, link.to);
      }
      const pages = new Map(
        (data?.query?.pages || []).map((page) => [page.title, page]),
      );

      for (const [title, item] of batch) {
        const page = pages.get(followHops(hops, title));
        const thumbnail = wikimediaImageUrl(page?.thumbnail?.source);
        const description = page?.terms?.description?.[0];
        if (thumbnail) item.thumbnail = thumbnail;
        if (description) item.description = String(description);
      }
    }
  } catch {
    // Summaries are optional too.
  }
}

function wikipediaTitleFromUrl(url) {
  if (typeof url !== "string") return null;
  if (!url.startsWith(WIKIPEDIA_ARTICLE_BASE)) return null;
  try {
    return decodeURIComponent(
      url.slice(WIKIPEDIA_ARTICLE_BASE.length),
    ).replace(/_/g, " ");
  } catch {
    return null;
  }
}

// Only HTTPS upload.wikimedia.org images are rendered in the species card.
function wikimediaImageUrl(url) {
  if (typeof url !== "string") return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:" || parsed.host !== "upload.wikimedia.org") {
    return null;
  }
  return parsed.toString();
}

// Wikidata entity URIs arrive as http://www.wikidata.org/entity/Q123 (the
// canonical entity namespace is http); only well-formed Q-ids become
// canonical https /wiki/ links.
function wikidataEntityUrl(url) {
  if (typeof url !== "string") return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.host !== "www.wikidata.org"
  ) {
    return null;
  }
  const id = parsed.pathname.split("/").filter(Boolean).pop();
  return /^Q[1-9][0-9]*$/.test(id)
    ? `https://www.wikidata.org/wiki/${id}`
    : null;
}

// GBIF species media live on many hosts (static.gbif.org, Flickr,
// iNaturalist), so only the HTTPS requirement is enforced here.
function gbifImageUrl(url) {
  if (typeof url !== "string") return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  return parsed.protocol === "https:" ? parsed.toString() : null;
}

// Occurrence photo for species without a Wikipedia thumbnail, fetched the
// first time its card opens and cached. Never blocks the card: the reserved
// image box just stays empty when this fails.
const gbifPhotoCache = new Map();

function loadGbifPhoto(key) {
  if (gbifPhotoCache.has(key)) return gbifPhotoCache.get(key);
  const request = (async () => {
    try {
      const data = await fetchJsonWithTimeout(
        `${API}/species/${encodeURIComponent(key)}/media?limit=10`,
        6000,
      );
      const hit = (data?.results || []).find(
        (item) => item?.type === "StillImage" && gbifImageUrl(item.identifier),
      );
      return hit ? gbifImageUrl(hit.identifier) : null;
    } catch {
      return null;
    }
  })();
  gbifPhotoCache.set(key, request);
  return request;
}

async function fetchJsonWithTimeout(url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function wikipediaArticleUrlFromTitle(title) {
  return (
    WIKIPEDIA_ARTICLE_BASE +
    encodeURIComponent(String(title).trim().replace(/ /g, "_"))
  );
}

// Accepts only HTTPS English Wikipedia article URLs and rebuilds them from
// the decoded title, so externally supplied URLs cannot carry odd payloads.
function wikipediaArticleUrl(url) {
  if (typeof url !== "string") return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:" || parsed.host !== "en.wikipedia.org") {
    return null;
  }
  if (!parsed.pathname.startsWith("/wiki/")) return null;

  let title;
  try {
    title = decodeURIComponent(parsed.pathname.slice("/wiki/".length));
  } catch {
    return null;
  }

  title = title.replace(/ /g, "_");
  if (
    !title ||
    title.startsWith("/") ||
    title.includes("\\") ||
    title.includes("//")
  ) {
    return null;
  }

  return WIKIPEDIA_ARTICLE_BASE + encodeURIComponent(title);
}

function followHops(hops, title) {
  const seen = new Set();
  while (hops.has(title) && !seen.has(title)) {
    seen.add(title);
    title = hops.get(title);
  }
  return title;
}

// IDs go into a SPARQL string literal, so only plain alphanumeric values are
// allowed: legacy GBIF keys are numeric, post-2026 P14607 keys also carry
// letters (e.g. 49XBD). Anything else fails closed and skips the ID lookup.
function isSafeTaxonId(value) {
  return /^[0-9A-Za-z]{1,20}$/.test(String(value));
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
  if (!inventory) {
    tablePagination.hidden = true;
    return;
  }

  hideSpeciesCard();


  if (activeTab === "species") {
    if (speciesLoading) {
      tablePagination.hidden = true;
      resultsBody.innerHTML =
        '<tr class="placeholder-row"><td colspan="2">Loading species names…</td></tr>';
      return;
    }

    if (inventory.speciesError) {
      tablePagination.hidden = true;
      resultsBody.innerHTML = `<tr class="placeholder-row"><td colspan="2">${escapeHtml(inventory.speciesError)}</td></tr>`;
      return;
    }
  }

  const rows = rowsForTab(activeTab);
  const filter = tableSearch.value.trim().toLowerCase();

  // Keep a group header only when at least one of its species survives the
  // filter: headers accumulate and flush with their first surviving row;
  // headers left pending at the end belonged to fully filtered-out groups.
  const visible = [];
  let pendingHeaders = [];
  for (const row of rows) {
    if (row.group || row.subgroup) {
      pendingHeaders.push(row);
      continue;
    }
    if (!filter || row.label.toLowerCase().includes(filter)) {
      visible.push(...pendingHeaders, row);
      pendingHeaders = [];
    }
  }

  if (!visible.length) {
    tablePagination.hidden = true;
    resultsBody.innerHTML =
      '<tr class="placeholder-row"><td colspan="2">No rows match your filter.</td></tr>';
    return;
  }

  const totalPages = Math.max(1, Math.ceil(visible.length / TABLE_PAGE_SIZE));
  tablePage = Math.min(tablePage, totalPages - 1);
  const start = tablePage * TABLE_PAGE_SIZE;
  const end = Math.min(start + TABLE_PAGE_SIZE, visible.length);
  const pageRows = visible.slice(start, end);

  resultsBody.innerHTML = visible
    .map((row) => {
      if (row.group) {
        return `<tr class="group-row"><td colspan="2">${escapeHtml(row.group)}</td></tr>`;
      }
      if (row.subgroup) {
        return `<tr class="group-row subgroup-row"><td colspan="2">${escapeHtml(row.subgroup)}</td></tr>`;
      }
      // Plain text: the species card is the click surface now. An <a> here
      // would navigate on click and fight the pin toggle.
      const name = escapeHtml(row.label);
      const attrs = [];
      if (row.key) attrs.push(`data-key="${escapeHtml(row.key)}"`);
      if (
        row.key ||
        row.thumbnail ||
        row.description ||
        row.classification ||
        row.wikipediaUrl ||
        row.wikidataUrl
      ) {
        attrs.push(
          `data-summary="${escapeHtml(
            JSON.stringify({
              n: row.label,
              t: row.thumbnail || "",
              d: row.description || "",
              w: row.wikipediaUrl || "",
              c: row.classification || "",
              q: row.wikidataUrl || "",
              k: row.childTaxa || 0,
            }),
          )}"`,
        );
        // Focusable so keyboard users can open the card (Enter/Space).
        attrs.push('tabindex="0"');
      }
      return `
        <tr${attrs.length ? ` ${attrs.join(" ")}` : ""}>
          <td>${name}</td>
          <td class="col-count">${formatCount(row.count)}</td>
        </tr>
      `;
    })
    .join("");

  tablePagination.hidden = false;
  tablePrev.disabled = tablePage === 0;
  tableNext.disabled = tablePage >= totalPages - 1;
  tablePageInfo.textContent = `${formatCount(start + 1)}–${formatCount(
    end,
  )} of ${formatCount(visible.length)}`;
}

function rowsForTab(tab) {
  const labelKeys = {
    species: ["name", "key"],
    datasets: ["name", "key"],
    publishers: ["name", "key"],
    years: ["year"],
    basis_of_record: ["basisOfRecord"],
  };

  if (tab === "species") return groupedSpeciesRows(itemsForTab(tab));

  return itemsForTab(tab).map((item) => {
    const row = {
      label: String(
        labelKeys[tab].map((key) => item[key]).find(Boolean) ?? item.key ?? "",
      ),
      count: item.count,
    };
    return row;
  });
}

// Species rows grouped by kingdom, with class subgroups inside Animalia.
// Kingdoms keep a familiar order, then alphabetical; classes sort by row
// count so the biggest groups (Aves, Insecta) sit on top.
const KINGDOM_ORDER = [
  "Animalia",
  "Plantae",
  "Fungi",
  "Chromista",
  "Protozoa",
  "Bacteria",
  "Archaea",
  "Viruses",
];

function groupedSpeciesRows(items) {
  const byKingdom = new Map();
  for (const item of items) {
    const kingdom = item.kingdom || "Other";
    if (!byKingdom.has(kingdom)) byKingdom.set(kingdom, []);
    byKingdom.get(kingdom).push(item);
  }

  const known = KINGDOM_ORDER.filter((kingdom) => byKingdom.has(kingdom));
  const rest = [...byKingdom.keys()]
    .filter((kingdom) => !KINGDOM_ORDER.includes(kingdom) && kingdom !== "Other")
    .sort();
  // "Other" (species whose GBIF lookup failed) always sorts last.
  if (byKingdom.has("Other")) rest.push("Other");

  const rows = [];
  for (const kingdom of [...known, ...rest]) {
    const kingdomItems = byKingdom.get(kingdom);
    rows.push({ group: `${kingdom} (${kingdomItems.length})` });
    if (kingdom === "Animalia") {
      rows.push(...classSubgroups(kingdomItems));
    } else {
      rows.push(...kingdomItems.map(speciesRow));
    }
  }
  return rows;
}

function classSubgroups(items) {
  const byClass = new Map();
  for (const item of items) {
    const taxonClass = item.taxonClass || "Other";
    if (!byClass.has(taxonClass)) byClass.set(taxonClass, []);
    byClass.get(taxonClass).push(item);
  }

  const names = [...byClass.keys()]
    .filter((taxonClass) => taxonClass !== "Other")
    .sort(
      (a, b) =>
        byClass.get(b).length - byClass.get(a).length || a.localeCompare(b),
    );
  // "Other" (missing class in the GBIF lookup) always sorts last.
  if (byClass.has("Other")) names.push("Other");

  const rows = [];
  for (const taxonClass of names) {
    rows.push({ subgroup: `${taxonClass} (${byClass.get(taxonClass).length})` });
    rows.push(...byClass.get(taxonClass).map(speciesRow));
  }
  return rows;
}

function speciesRow(item) {
  const row = {
    label: String(item.name || item.key),
    count: item.count,
    key: String(item.key),
  };
  if (item.wikipediaUrl) row.wikipediaUrl = item.wikipediaUrl;
  if (item.wikidataUrl) row.wikidataUrl = item.wikidataUrl;
  if (item.thumbnail) row.thumbnail = item.thumbnail;
  if (item.description) row.description = item.description;
  const lineage = [
    item.kingdom,
    item.phylum,
    item.taxonClass,
    item.order,
    item.family,
    item.genus,
  ]
    .filter(Boolean)
    .filter((rank, index, all) => rank !== all[index - 1]);
  if (lineage.length > 1) row.classification = lineage.join(" > ");
  if (item.childTaxa) row.childTaxa = item.childTaxa;
  return row;
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
    headers: ["Name", "Kingdom", "Class", "Key", "Count", "Wikipedia"],
    rows: (items) =>
      items.map((item) => [
        item.name || item.key,
        item.kingdom || "",
        item.taxonClass || "",
        item.key,
        item.count,
        item.wikipediaUrl || "",
      ]),
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
    tab: "species",
    name: "Species",
    headers: ["Name", "Key", "Count"],
    rows: (items) =>
      items.map((item) => [item.name || item.key, item.key, item.count]),
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

function openOnGbif() {
  if (!inventory?.geometry) return;
  window.open(gbifOccurrenceSearchUrl(inventory.geometry), "_blank", "noopener");
}

function gbifOccurrenceSearchUrl(wkt) {
  const params = new URLSearchParams({ geometry: wkt });
  return `https://www.gbif.org/occurrence/search?${params}`;
}

function setGeometryStatus(wkt, note = "") {
  const geometryLine = `Geometry: ${wkt}`;
  statusText.innerHTML = note
    ? `${escapeHtml(note)}<br>${escapeHtml(geometryLine)}`
    : escapeHtml(geometryLine);
  statusMessage.classList.remove("error");
  statusSpinner.hidden = true;
  statusMessage.setAttribute("aria-busy", "false");
}

function setStatus(message, isError = false, loading = false) {
  statusText.textContent = message;
  statusMessage.classList.toggle("error", isError);
  statusSpinner.hidden = !loading;
  statusMessage.setAttribute("aria-busy", loading ? "true" : "false");
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
