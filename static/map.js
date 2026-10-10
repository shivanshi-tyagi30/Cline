const $ = (id) => document.getElementById(id);

const MODE_CONFIG = {
  fastest: {
    id: "fastest",
    label: "Fastest",
    color: "#3B5BDB",
    bg: "#e8e7f8",
    textColor: "#171b5e",
    icon: (active) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="${active ? "#fff" : "#171b5e"}"><path d="M13 2.05v2.02c3.95.49 7 3.85 7 7.93 0 3.21-1.81 6-4.72 7.28L13 17v5l5-3.08C21.49 16.89 23 13.62 23 12c0-5.18-3.95-9.45-10-9.95zM11 2.05C4.95 2.55 1 6.82 1 12c0 1.62 1.51 4.89 5 6.92L11 22v-5l-2.28-1.72C6.81 14 5 11.21 5 8c0-4.08 3.05-7.44 7-7.95v2.02z"/></svg>`
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    color: "#7048E8",
    bg: "#FEF3DC",
    textColor: "#8A5800",
    icon: (active) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="${active ? "#fff" : "#8A5800"}"><path d="M12 3L1 9l4 2.18V15c0 3.31 3.13 5 7 5s7-1.69 7-5v-3.82L21 9 12 3zm2.45 11.19c-.47.44-1.3.81-2.45.81s-1.98-.37-2.45-.81L8.5 13h7l-1.05 1.19zM17 12.5l-5-2.73-5 2.73v-.73l5-2.73 5 2.73v.73z"/></svg>`
  },
  calmest: {
    id: "calmest",
    label: "Calmest",
    color: "#0C8599",
    bg: "#E6F4EA",
    textColor: "#145A2B",
    icon: (active) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="${active ? "#fff" : "#145A2B"}"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/></svg>`
  }
};

let PLACES = [];
let RECENT_ITEMS = [];

function toPlace(p) {
  const kind = p.kind ? p.kind.charAt(0).toUpperCase() + p.kind.slice(1) : "Place";
  return { name: p.name, sub: `${kind} \u00b7 IIT Guwahati`, lat: p.lat, lng: p.lon };
}

async function loadPlaces() {
  try {
    const d = await (await fetch("/api/places")).json();
    PLACES = d.places.map(toPlace);
  } catch (_) { PLACES = []; }
  try {
    const d = await (await fetch("/api/demo_pairs")).json();
    RECENT_ITEMS = d.pairs.slice(0, 3).map((pr) => ({
      from: { name: `${pr.label}: start`, sub: "Demo route", lat: pr.start[0], lng: pr.start[1] },
      to: { name: `${pr.label}: end`, sub: "Demo route", lat: pr.end[0], lng: pr.end[1] },
    }));
  } catch (_) { RECENT_ITEMS = []; }
}

const searchCache = new Map();
async function searchPlaces(q) {
  const key = q.trim().toLowerCase();
  if (key.length < 2) return null;
  if (searchCache.has(key)) return searchCache.get(key);
  try {
    const d = await (await fetch(`/api/places/search?q=${encodeURIComponent(key)}&limit=10`)).json();
    const list = d.results.map(toPlace);
    searchCache.set(key, list);
    return list;
  } catch (_) { return null; }
}

/* Initialize Leaflet Map */
const map = L.map("map", { zoomControl: true }).setView([26.1895, 91.6965], 15);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19
}).addTo(map);

let cfg = {};
let start = null;
let end = null;
let placing = "source";
let markers = [];
let lastRes = null;
let sel = "calmest";
let heatmapVisible = true;
let travelProfile = "driving";

const baseLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);

const CSS_FALLBACK = { "--lit": "#1E8E3E", "--dim": "#F29900", "--unlit": "#D93025", "--unknown": "#80868B", "--closed": "#3C4043", "--focus": "#3B5BDB" };
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || CSS_FALLBACK[name] || "#888";

function riskColor(r, st) {
  if (st === "no_data") return cssVar("--unknown");
  const tau = cfg.tau ?? 0.5;
  if (r > tau) return cssVar("--unlit");
  if (r > tau * 0.6) return cssVar("--dim");
  return cssVar("--lit");
}

function polylineMetres(ll) {
  let d = 0;
  for (let i = 1; i < ll.length; i++) {
    const [a1, o1] = ll[i - 1], [a2, o2] = ll[i];
    const p1 = a1 * Math.PI / 180, p2 = a2 * Math.PI / 180;
    const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((o2 - o1) * Math.PI / 360) ** 2;
    d += 2 * 6371008.8 * Math.asin(Math.sqrt(h));
  }
  return d;
}

function withLengths(card) {
  const raw = card.geometry.map((g) => polylineMetres(g.ll));
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  const k = card.length_m / sum;
  return card.geometry.map((g, i) => ({ ...g, length_m: raw[i] * k }));
}

const hasName = (c, n) => c.name === n || (c.also || []).includes(n);

const BAND_WORD = {
  good: "Assessed good (risk at or below threshold)",
  concerning: "Concerning (risk above threshold)",
  unknown: "No condition data, scored pessimistically and counted as concerning",
};

function bandKind(g) {
  if (g.st === "no_data") return "unknown";
  return g.conc ? "concerning" : "good";
}

function segmentTip(g, i, n) {
  return `Segment ${i + 1} of ${n} \u00b7 ${Math.round(g.length_m)} m \u00b7 risk ${g.r.toFixed(2)} \u00b7 ${BAND_WORD[bandKind(g)]}`;
}

function lumaHeatColor(safetyScore) {
  const t = Math.max(0, Math.min(1, safetyScore));
  if (t <= 0.5) {
    const k = t / 0.5;
    return `rgb(234,${Math.round(67 + 121 * k)},${Math.round(53 - 49 * k)})`;
  }
  const n = (t - 0.5) / 0.5;
  return `rgb(${Math.round(249 - 197 * n)},${Math.round(171 - 3 * n)},${Math.round(0 + 83 * n)})`;
}

function parseDepartureTime() {
  const raw = ($("hour")?.value || "22:00").trim();
  if (raw.includes(":")) {
    const [hStr, mStr] = raw.split(":");
    const h = parseInt(hStr, 10);
    const m = parseInt(mStr, 10);
    return {
      hour: Number.isNaN(h) ? 22 : ((h % 24) + 24) % 24,
      minute: Number.isNaN(m) ? 0 : Math.max(0, Math.min(59, m))
    };
  }
  const n = parseInt(raw, 10);
  return {
    hour: Number.isNaN(n) ? 22 : ((n % 24) + 24) % 24,
    minute: 0
  };
}
const hourVal = () => parseDepartureTime().hour;
const minuteVal = () => parseDepartureTime().minute;
const hh = (h, m = 0) => `${String(h % 24).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
const fmtMin = (s) => {
  const m = Math.round(s / 60);
  return m < 1 ? "<1 min" : `${m} min`;
};

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "content-type": "application/json", ...(opts.headers || {}) }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || r.status);
  return j;
}

function makeLumaPin(color, letter) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="40" viewBox="0 0 28 40">
    <path d="M14 0C6.27 0 0 6.27 0 14c0 10.5 14 26 14 26s14-15.5 14-26C28 6.27 21.73 0 14 0z" fill="${color}"/>
    <circle cx="14" cy="14" r="6" fill="white"/>
    <text x="14" y="17" text-anchor="middle" fill="${color}" font-size="9" font-weight="700" font-family="Inter,sans-serif">${letter}</text>
  </svg>`;
  return L.divIcon({ html: svg, className: "", iconSize: [28, 40], iconAnchor: [14, 40], tooltipAnchor: [0, -40] });
}

function syncMarkers() {
  markers.forEach((m) => m.remove());
  markers = [];
  if (start) {
    markers.push(
      L.marker([start.lat, start.lng], { icon: makeLumaPin("#222673", "A") })
        .bindTooltip("Origin", { className: "luma-tooltip", direction: "top", offset: [0, -40] })
        .addTo(map)
    );
  }
  if (end) {
    markers.push(
      L.marker([end.lat, end.lng], { icon: makeLumaPin("#171b5e", "B") })
        .bindTooltip("Destination", { className: "luma-tooltip", direction: "top", offset: [0, -40] })
        .addTo(map)
    );
  }
}

async function loadNetwork() {
  const net = await api(`/api/network?hour=${hourVal() % 24}`);
  baseLayer.clearLayers();
  for (const s of net.segments) {
    const col = s.closed ? cssVar("--closed") : riskColor(s.r, s.st);
    const line = L.polyline(s.ll, {
      color: col,
      weight: s.closed ? 4.5 : 3,
      opacity: s.closed ? 0.9 : 0.8,
      lineCap: "round",
      dashArray: s.closed ? "4 6" : s.st === "no_data" ? "3 5" : null
    });
    line.bindTooltip(`<div>Risk <b>${s.r.toFixed(2)}</b> \u00b7 ${s.closed ? "Closed by a verified event" : s.st === "no_data" ? "No condition data" : "Status " + s.st}</div>`, {
      className: "luma-tooltip",
      direction: "top",
      sticky: true
    });
    line.on("mouseover", function () { this.setStyle({ weight: 5, opacity: 0.9 }); });
    line.on("mouseout", function () { this.setStyle({ weight: s.closed ? 4.5 : 3, opacity: s.closed ? 0.9 : 0.8 }); });
    line.on("click", (e) => {
      L.DomEvent.stopPropagation(e);
      openDrawer(s.id);
    });
    baseLayer.addLayer(line);
  }
}

function syncUIState() {
  const hasRoutes = !!(lastRes && lastRes.status === "ok" && lastRes.cards && lastRes.cards.length);
  const step = start ? (end ? 3 : 2) : 1;

  $("fromDot").classList.toggle("empty", !start);
  $("toSq").classList.toggle("empty", !end);
  $("clearFromBtn").hidden = !start && !$("fromInput").value;
  $("clearToBtn").hidden = !end && !$("toInput").value;
  $("fromInput").classList.toggle("filled", !!start);
  $("toInput").classList.toggle("filled", !!end);
  $("fromInput").classList.toggle("active", placing === "source");
  $("toInput").classList.toggle("active", placing === "destination");

  $("sbar1").className = "step-bar-seg " + (step > 1 ? "done" : "current");
  $("sbar2").className = "step-bar-seg " + (step > 2 ? "done" : step === 2 ? "current" : "");
  $("sbar3").className = "step-bar-seg " + (step === 3 ? "done" : "");

  if (step === 1) {
    $("stepCaption").textContent = "Pick a start and an end on the map, or choose a demo route below.";
  } else if (step === 2) {
    $("stepCaption").textContent = "Now pick where you are going.";
  } else {
    $("stepCaption").textContent = "Ready. Find routes to compare how long each one stays in the dark.";
  }

  if (placing && !hasRoutes) {
    $("placingHint").hidden = false;
    $("placingText").innerHTML = `Tap the map to set your <strong>${placing}</strong>`;
    map.getContainer().style.cursor = "crosshair";
  } else {
    $("placingHint").hidden = true;
    map.getContainer().style.cursor = "";
  }

  $("go").disabled = !(start && end);
  $("goLabel").textContent = hasRoutes ? "Update routes" : "Find routes";

  $("sidebar").className = hasRoutes ? "docked-mode" : "floating-mode";
  $("stepSection").hidden = hasRoutes;
  $("timeBudgetWrap").hidden = false;
  $("sidebarFooter").hidden = hasRoutes;
  $("recentPanel").hidden = hasRoutes;
  if ($("mapCenterPrompt")) $("mapCenterPrompt").hidden = !!(start || end || hasRoutes);
  $("modePillsRow").hidden = !hasRoutes;
  $("route-panel-wrap").hidden = !hasRoutes;
  $("backToSearchBtn").hidden = !hasRoutes;
  $("topRightStack").classList.toggle("shifted", hasRoutes);
  $("locBtnLabel").textContent = hasRoutes ? "Center route" : "My location";
}

function setupAutocomplete(inputEl, dropEl, listEl, isSource) {
  let remote = [];
  let remoteFor = "";
  let timer = null;

  function findMatchingPlaces(filterText) {
    const q = (filterText || "").trim().toLowerCase();
    const local = PLACES.filter((p) => !q || p.name.toLowerCase().includes(q) || p.sub.toLowerCase().includes(q));
    if (!q || remoteFor !== q) return local.slice(0, 30);
    const seen = new Set(local.map((p) => p.name.toLowerCase() + "|" + p.lat.toFixed(4)));
    const extra = remote.filter((p) => !seen.has(p.name.toLowerCase() + "|" + p.lat.toFixed(4)));
    return local.concat(extra).slice(0, 30);
  }

  function scheduleRemote(text) {
    clearTimeout(timer);
    const q = (text || "").trim().toLowerCase();
    if (q.length < 2) return;
    timer = setTimeout(async () => {
      const list = await searchPlaces(q);
      if (list && inputEl.value.trim().toLowerCase() === q) {
        remote = list;
        remoteFor = q;
        if (document.activeElement === inputEl) renderList(inputEl.value);
      }
    }, 350);
  }

  function applyChoice(chosen) {
    inputEl.value = chosen.name;
    dropEl.hidden = true;
    if (isSource) {
      start = { lat: chosen.lat, lng: chosen.lng, label: chosen.name };
      placing = end ? null : "destination";
    } else {
      end = { lat: chosen.lat, lng: chosen.lng, label: chosen.name };
      placing = null;
    }
    syncMarkers();
    syncUIState();
  }

  function renderList(filterText) {
    const matches = findMatchingPlaces(filterText);
    listEl.innerHTML = matches.map((p, idx) => `
      <li class="ac-item" data-idx="${idx}">
        <div class="ac-pin-circle">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
        </div>
        <div>
          <div class="ac-name">${p.name}</div>
          <div class="ac-sub">${p.sub}</div>
        </div>
      </li>
    `).join("");

    listEl.querySelectorAll(".ac-item").forEach((li) => {
      li.onmousedown = (e) => {
        e.preventDefault();
        applyChoice(matches[+li.dataset.idx]);
      };
    });
    dropEl.hidden = matches.length === 0;
  }

  inputEl.onfocus = () => {
    placing = isSource ? "source" : "destination";
    syncUIState();
    renderList(inputEl.value === (isSource ? start?.label : end?.label) ? "" : inputEl.value);
  };
  inputEl.oninput = () => {
    renderList(inputEl.value);
    scheduleRemote(inputEl.value);
  };
  inputEl.onkeydown = (e) => {
    if (e.key === "Enter") {
      const matches = findMatchingPlaces(inputEl.value);
      if (matches.length > 0) applyChoice(matches[0]);
    }
  };
  inputEl.onblur = () => setTimeout(() => { dropEl.hidden = true; }, 160);
}

function renderRecent() {
  $("recentList").innerHTML = RECENT_ITEMS.map((item, i) => `
    <li>
      <button type="button" class="recent-btn" data-i="${i}">
        <div class="recent-line">
          <span style="width:8px;height:8px;border-radius:50%;background:#1A73E8;margin-top:4px;flex-shrink:0"></span>
          <span>${item.from.name}</span>
        </div>
        <div class="recent-line dest">
          <span style="width:8px;height:8px;border-radius:2px;background:#EA4335;margin-top:4px;flex-shrink:0"></span>
          <span>${item.to.name}</span>
        </div>
      </button>
    </li>
  `).join("");

  $("recentList").querySelectorAll(".recent-btn").forEach((btn) => {
    btn.onclick = () => {
      const item = RECENT_ITEMS[+btn.dataset.i];
      start = { lat: item.from.lat, lng: item.from.lng, label: item.from.name };
      end = { lat: item.to.lat, lng: item.to.lng, label: item.to.name };
      $("fromInput").value = item.from.name;
      $("toInput").value = item.to.name;
      placing = null;
      syncMarkers();
      findRoutes();
    };
  });
}

map.on("click", async (e) => {
  const { lat, lng } = e.latlng;
  const isSource = placing === "source" || !start;
  const fallbackLabel = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  if (isSource) {
    start = { lat, lng, label: fallbackLabel };
    $("fromInput").value = fallbackLabel;
    placing = end ? null : "destination";
  } else {
    end = { lat, lng, label: fallbackLabel };
    $("toInput").value = fallbackLabel;
    placing = null;
  }
  syncMarkers();
  syncUIState();

  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`, {
      headers: { "Accept-Language": "en-US,en;q=0.9" }
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.display_name) {
        const pretty = data.display_name.split(",").slice(0, 2).join(", ").trim();
        if (isSource && start && Math.abs(start.lat - lat) < 1e-5) {
          start.label = pretty;
          $("fromInput").value = pretty;
        } else if (!isSource && end && Math.abs(end.lat - lat) < 1e-5) {
          end.label = pretty;
          $("toInput").value = pretty;
        }
      }
    }
  } catch (_) {}
});

async function findRoutes() {
  if (!start || !end) return;
  $("goLabel").textContent = "Finding routes\u2026";
  ribbonAnimated = false;
  try {
    lastRes = await api("/api/route", {
      method: "POST",
      body: JSON.stringify({
        start: [start.lat, start.lng],
        end: [end.lat, end.lng],
        hour: hourVal() % 24,
        minute: minuteVal(),
        detour: +$("detour").value
      })
    });
  } catch (e) {
    $("status").textContent = "Routing failed: " + e.message;
    syncUIState();
    return;
  }
  $("status").textContent = "";
  renderCards();
}

let ribbonAnimated = false;
let hoverLayer = null;

function wireRibbons(res) {
  document.querySelectorAll(".rb").forEach((el) => {
    const card = res.cards.find((c) => c.name === el.dataset.name);
    if (!card) return;
    const g = card.geometry[+el.dataset.seg];
    const on = () => {
      if (hoverLayer) map.removeLayer(hoverLayer);
      hoverLayer = L.polyline(g.ll, { color: cssVar("--focus"), weight: 10, opacity: 0.95, lineCap: "round" }).addTo(map);
      hoverLayer.bindTooltip(el.getAttribute("aria-label"), { className: "luma-tooltip", permanent: true, direction: "top" }).openTooltip();
    };
    const off = () => { if (hoverLayer) { map.removeLayer(hoverLayer); hoverLayer = null; } };
    el.addEventListener("mouseenter", on);
    el.addEventListener("focus", on);
    el.addEventListener("mouseleave", off);
    el.addEventListener("blur", off);
    el.addEventListener("click", () => openDrawer(g.id));
    el.addEventListener("keydown", (e) => {
      const sibs = [...el.parentElement.children];
      const i = sibs.indexOf(el);
      if (e.key === "ArrowRight" && sibs[i + 1]) { e.preventDefault(); sibs[i + 1].focus(); }
      if (e.key === "ArrowLeft" && sibs[i - 1]) { e.preventDefault(); sibs[i - 1].focus(); }
    });
  });
  document.querySelectorAll(".ribbon").forEach((rb) => {
    const bands = [...rb.children];
    bands.forEach((b, i) => { b.tabIndex = i === 0 ? 0 : -1; });
  });
}

function renderCards() {
  const res = lastRes;
  routeLayer.clearLayers();
  if (!res || res.status !== "ok" || !res.cards.length) {
    $("status").textContent = res ? "These two points are not connected by any mapped walking route. Try points closer to a campus road." : "";
    syncUIState();
    return;
  }

  const selCard = res.cards.find((c) => hasName(c, sel)) || res.cards.find((c) => hasName(c, "calmest")) || res.cards.find((c) => hasName(c, "fastest")) || res.cards[0];
  const active = selCard.name;
  sel = active;
  syncUIState();

  $("modePillsRow").innerHTML = res.cards.map((c) => {
    const m = MODE_CONFIG[c.name] || MODE_CONFIG.calmest;
    const isSel = c.name === active;
    const title = c.also && c.also.length ? `${m.label} & ${c.also.map((a) => MODE_CONFIG[a]?.label || a).join(" & ")}` : m.label;
    return `<button class="route-mode-pill" data-m="${c.name}" style="border-color:${isSel ? m.color : "#DDD5C8"};background:${isSel ? m.color : "#fff"};color:${isSel ? "#fff" : m.textColor};box-shadow:${isSel ? `0 3px 10px ${m.color}40` : "none"}">
      ${m.icon(isSel)} <span>${title}</span>
    </button>`;
  }).join("");

  $("modePillsRow").querySelectorAll(".route-mode-pill").forEach((b) => {
    b.onclick = () => {
      sel = b.dataset.m;
      renderCards();
    };
  });

  const cur = selCard;
  const fast = res.cards.find((c) => hasName(c, "fastest")) || selCard;

  const dd = lastRes.distances || {};
  const access = Math.round((dd.start_to_road_m || 0) + (dd.end_to_road_m || 0));
  const distSub = dd.straight_line_m != null
    ? `Along campus roads \u00b7 ${(dd.straight_line_m / 1000).toFixed(2)} km straight line` + (access >= 20 ? ` \u00b7 +${access} m to/from the road` : "")
    : "Along campus roads";
  const fastLongest = fast.longest_stretch_m;
  const rank = (c) => ["fastest", "calmest", "balanced"].indexOf(c.name);
  const ordered = [...res.cards].sort((x, y) => rank(x) - rank(y));
  const calmCard = res.cards.find((c) => hasName(c, "calmest"));
  const noCalmer = !calmCard || hasName(calmCard, "fastest");

  const cardHtml = (c, idx) => {
    const mc = MODE_CONFIG[c.name] || MODE_CONFIG.calmest;
    const names = [c.name, ...(c.also || [])].map((n) => (MODE_CONFIG[n] || {}).label || n).join(" and ");
    const geo = withLengths(c);
    const total = geo.reduce((a, g) => a + g.length_m, 0) || 1;
    const runIds = Array.isArray(c.longest_stretch_segment_ids) ? new Set(c.longest_stretch_segment_ids) : null;
    const idx0 = runIds && runIds.size ? geo.findIndex((g) => runIds.has(g.id)) : -1;
    let idx1 = -1;
    if (idx0 >= 0) geo.forEach((g, i) => { if (runIds.has(g.id)) idx1 = i; });
    let acc = 0, runL = 0, runW = 0;
    const bands = geo.map((g, i) => {
      const w = (g.length_m / total) * 100;
      if (i === idx0) runL = acc;
      if (idx0 >= 0 && i >= idx0 && i <= idx1) runW += w;
      acc += w;
      const kind = bandKind(g);
      const inRun = runIds && runIds.has(g.id);
      const tip = segmentTip(g, i, geo.length) + (inRun ? " \u00b7 part of the longest run" : "");
      return `<button type="button" class="rb rb-${kind}${inRun ? " in-run" : ""}" style="flex-basis:${w.toFixed(4)}%" data-name="${c.name}" data-seg="${i}" aria-label="${tip}" title="${tip}"></button>`;
    }).join("");
    const isFast = hasName(c, "fastest");
    const delta = Math.round(c.longest_stretch_m - fastLongest);
    const deltaTxt = isFast ? "" : `(${delta === 0 ? "same as fastest" : `${delta < 0 ? "\u2212" : "+"}${Math.abs(delta)} m vs fastest`})`;
    const extraMin = (c.time_s - fast.time_s) / 60;
    const share = c.length_m > 0 ? c.concerning_m / c.length_m : null;
    const why = [];
    if (!isFast) why.push(extraMin > 0.05 ? `Adds ${extraMin.toFixed(1)} min` : "Same walk time as fastest");
    if (!isFast && delta < 0) why.push(`Longest dark stretch ${Math.abs(delta)} m shorter than fastest`);
    if (!isFast && delta > 0) why.push(`Longest dark stretch ${delta} m longer than fastest`);
    if (c.unknown_m >= 1) why.push(`${Math.round(c.unknown_m)} m of this route has no condition data, scored pessimistically`);
    if (c.coverage != null) why.push(`Condition data covers ${Math.round(c.coverage * 100)}% of the fields on this route`);
    if (isFast) why.push("This is the fastest eligible route; the others are compared against it");
    return `
      <article class="rcard${c.name === active ? " sel" : ""}" data-name="${c.name}" style="--accent:${mc.color};--i:${idx}" aria-label="${names} route">
        <header class="rcard-head">
          <h3 class="rcard-title">${names}</h3>
          <button type="button" class="rcard-pick" data-m="${c.name}" aria-pressed="${c.name === active}">${c.name === active ? "Shown on map" : "Show on map"}</button>
        </header>
        <p class="rcard-claim muted">${c.claim}</p>
        <div class="hero">
          <span class="hero-num">${Math.round(c.longest_stretch_m)}</span><span class="hero-unit">m</span>
          ${deltaTxt ? `<span class="hero-delta">${deltaTxt}</span>` : ""}
          <span class="hero-cap">Longest continuous concerning stretch</span>
        </div>
        <div class="ribbon-wrap">
          <div class="ribbon" role="group" aria-label="Journey from start to end, ${geo.length} segments. Use arrow keys to move between segments.">${bands}</div>
          ${idx0 >= 0 ? `<div class="run-mark" style="left:${runL.toFixed(3)}%;width:${Math.max(runW, 0.6).toFixed(3)}%" aria-hidden="true"></div>
          <div class="run-label" style="left:${runL.toFixed(3)}%">${Math.round(c.longest_stretch_m)} m</div>` : runIds && !runIds.size ? `<div class="run-none">No concerning stretch on this route</div>` : ""}
        </div>
        <div class="ribbon-ends"><span>Start</span><span>End</span></div>
        <table class="rmetrics">
          <tr><td>Walk time</td><td>${fmtMin(c.time_s)}</td></tr>
          <tr><td>Length</td><td>${(c.length_m / 1000).toFixed(2)} km</td></tr>
          <tr><td>Total concerning</td><td>${Math.round(c.concerning_m)} m \u00b7 ${c.concerning_min.toFixed(1)} min</td></tr>
          <tr><td>Concerning share of route</td><td>${share == null ? "\u2013" : Math.round(share * 100) + "%"}</td></tr>
          <tr><td>Max single-segment risk</td><td>${c.max_segment_risk.toFixed(2)}</td></tr>
          <tr><td>Unknown (no data)</td><td>${Math.round(c.unknown_m)} m</td></tr>
          <tr><td>Data coverage</td><td>${c.coverage == null ? "\u2013" : Math.round(c.coverage * 100) + "%"}</td></tr>
        </table>
        <div class="rp-eval-box why-box">
          <p class="why-title">Why this route</p>
          <ul class="why-list">${why.map((t) => `<li>${t}</li>`).join("")}</ul>
          <div class="why-codes">${c.reason_codes.map((rc) => `<span class="hl-pill">${rc}</span>`).join("")}</div>
        </div>
      </article>`;
  };

  $("cards").innerHTML = `
    <div class="rp-header">
      <div>
        <h2 class="rp-h2">Route comparison</h2>
        <p class="rp-sub">${distSub}. Departure ${hh(hourVal(), minuteVal())}, simulated conditions.</p>
      </div>
      <button class="sec" id="simHazardBtn">Report a hazard on this route</button>
    </div>
    ${noCalmer ? `<p class="no-calmer">No calmer route fits the time budget. The fastest route is already the calmest option within ${Math.round((+$("detour").value - 1) * 100)}% extra time.</p>` : ""}
    <div class="rcards">${ordered.map((c, i) => cardHtml(c, i)).join("")}</div>
    <div class="legend" aria-label="Ribbon legend">
      <span><i class="lg lg-good"></i>Assessed good (risk at or below ${cfg.tau})</span>
      <span><i class="lg lg-concerning"></i>Concerning (risk above ${cfg.tau})</span>
      <span><i class="lg lg-unknown"></i>No data (dashed, counted as concerning)</span>
      <span><i class="lg lg-run"></i>Longest run</span>
    </div>
    <p class="map-key">On the map the selected route is coloured by each segment's risk; other routes are thin lines.</p>
  `;

  document.querySelectorAll(".rcard-pick").forEach((b) => {
    b.onclick = () => { sel = b.dataset.m; renderCards(); };
  });
  wireRibbons(res);
  if (!ribbonAnimated) {
    ribbonAnimated = true;
    $("cards").classList.add("wipe");
    setTimeout(() => $("cards").classList.remove("wipe"), 1600);
  }

  $("simHazardBtn").onclick = () => {
    const seg = cur.geometry.find((g) => g.conc) || cur.geometry[0];
    if (seg) openDrawer(seg.id, true);
  };

  const order = [...res.cards].sort((a, b) => (a.name === active) - (b.name === active));
  const boundsPts = [];
  for (const c of order) {
    const isSel = c.name === active;
    const mCfg = MODE_CONFIG[c.name] || MODE_CONFIG.calmest;
    const geo = withLengths(c);
    geo.forEach((g, i) => {
      const unknown = g.st === "no_data";
      if (isSel) boundsPts.push(...g.ll);
      const line = L.polyline(g.ll, {
        color: isSel ? riskColor(g.r, g.st) : (unknown ? cssVar("--unknown") : mCfg.color),
        weight: isSel ? 6 : 3,
        opacity: isSel ? 0.95 : 0.35,
        dashArray: unknown ? "4 6" : null,
        lineCap: unknown ? "butt" : "round",
        lineJoin: "round"
      });
      if (isSel) {
        line.bindTooltip(segmentTip(g, i, geo.length), { className: "luma-tooltip", direction: "top", sticky: true });
        line.on("click", (e) => { L.DomEvent.stopPropagation(e); openDrawer(g.id); });
      } else {
        line.bindTooltip(`${mCfg.label} route \u00b7 click to show its risk`, { className: "luma-tooltip", direction: "top", sticky: true });
        line.on("click", (e) => { L.DomEvent.stopPropagation(e); sel = c.name; renderCards(); });
      }
      routeLayer.addLayer(line);
    });
  }

  if (boundsPts.length) {
    map.fitBounds(boundsPts, { paddingTopLeft: [60, 60], paddingBottomRight: [60, 240], maxZoom: 16 });
  }
}

$("clearFromBtn").onclick = (e) => {
  e.stopPropagation();
  start = null;
  $("fromInput").value = "";
  lastRes = null;
  routeLayer.clearLayers();
  placing = "source";
  syncMarkers();
  syncUIState();
};

$("clearToBtn").onclick = (e) => {
  e.stopPropagation();
  end = null;
  $("toInput").value = "";
  lastRes = null;
  routeLayer.clearLayers();
  placing = "destination";
  syncMarkers();
  syncUIState();
};

$("backToSearchBtn").onclick = () => {
  lastRes = null;
  routeLayer.clearLayers();
  $("drawer").hidden = true;
  placing = null;
  syncUIState();
};

$("btn-heatmap-toggle").onclick = () => {
  heatmapVisible = !heatmapVisible;
  $("btn-heatmap-toggle").classList.toggle("active-primary", heatmapVisible);
  if ($("heatmapIcon")) $("heatmapIcon").setAttribute("fill", heatmapVisible ? "#ffffff" : "#222673");
  $("heatmapDot").style.display = heatmapVisible ? "inline-block" : "none";
  if (heatmapVisible) baseLayer.addTo(map);
  else map.removeLayer(baseLayer);
};

$("btn-my-location").onclick = () => {
  if (lastRes && lastRes.cards && lastRes.cards.length) {
    renderCards();
  } else {
    map.flyTo([26.1895, 91.6965], 15, { duration: 1.0 });
  }
};

$("mode-drive").onclick = () => {
  travelProfile = "driving";
  $("mode-drive").classList.add("active");
  $("mode-walk").classList.remove("active");
  $("profileLabel").textContent = "Driving routes";
  if (lastRes) renderCards();
};

$("mode-walk").onclick = () => {
  travelProfile = "foot";
  $("mode-walk").classList.add("active");
  $("mode-drive").classList.remove("active");
  $("profileLabel").textContent = "Walking routes";
  if (lastRes) renderCards();
};

$("hour").oninput = () => {
  const dep = parseDepartureTime();
  if ($("hourv")) $("hourv").textContent = hh(dep.hour, dep.minute);
};
$("hour").onchange = () => {
  const dep = parseDepartureTime();
  if ($("hourv")) $("hourv").textContent = hh(dep.hour, dep.minute);
  loadNetwork();
  if (start && end && lastRes) findRoutes();
};
if ($("nowTimeBtn")) {
  $("nowTimeBtn").onclick = () => {
    const now = new Date();
    const val = hh(now.getHours(), now.getMinutes());
    $("hour").value = val;
    if ($("hourv")) $("hourv").textContent = val;
    loadNetwork();
    if (start && end && lastRes) findRoutes();
  };
}

$("detour").oninput = () => {
  const extraPct = Math.round((+$("detour").value - 1) * 100);
  $("detv").textContent = extraPct <= 0 ? "Shortest only" : `Up to +${extraPct}%`;
};
$("detour").onchange = () => {
  if (start && end && lastRes) findRoutes();
};

async function setupDemoPicker() {
  let pairs = [];
  try {
    const r = await fetch("/api/demo_pairs");
    if (r.ok) pairs = (await r.json()).pairs || [];
  } catch (_) { pairs = []; }
  if (!pairs.length) { $("demoWrap").hidden = true; return; }
  const fmt = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
  $("demoSelect").innerHTML = `<option value="">Choose a demo route</option>` + pairs.map((p, i) =>
    `<option value="${i}">${p.label}: longest dark stretch ${fmt(p.fastest_longest_stretch_m)} on the fastest route</option>`).join("");
  $("demoWrap").hidden = false;
  $("demoSelect").onchange = () => {
    const v = $("demoSelect").value;
    if (v === "") return;
    const p = pairs[+v];
    start = { lat: p.start[0], lng: p.start[1], label: `${p.label}: start` };
    end = { lat: p.end[0], lng: p.end[1], label: `${p.label}: end` };
    $("fromInput").value = start.label;
    $("toInput").value = end.label;
    $("hour").value = hh(p.hour, 0);
    if ($("hourv")) $("hourv").textContent = hh(p.hour, 0);
    placing = null;
    syncMarkers();
    syncUIState();
    map.fitBounds([p.start, p.end], { padding: [80, 80], maxZoom: 16 });
    loadNetwork();
    findRoutes();
  };
}

$("go").onclick = findRoutes;
$("reset").onclick = () => {
  start = end = lastRes = null;
  $("fromInput").value = "";
  $("toInput").value = "";
  routeLayer.clearLayers();
  syncMarkers();
  syncUIState();
};

(async () => {
  cfg = await api("/api/config");
  $("params").textContent = `TAU=${cfg.tau} · R=${cfg.r_m} m · Δ=${cfg.delta_m} m`;
  $("paramsLine").textContent = `TAU ${cfg.tau} \u00b7 R ${cfg.r_m} m \u00b7 \u0394 ${cfg.delta_m} m \u00b7 no data counts as concerning`;
  await loadPlaces();
  setupAutocomplete($("fromInput"), $("fromDropdown"), $("fromList"), true);
  setupAutocomplete($("toInput"), $("toDropdown"), $("toList"), false);
  renderRecent();
  setupDemoPicker();

  $("profileLabel").textContent = "Driving routes";
  placing = "source";
  syncMarkers();
  syncUIState();
  await loadNetwork();
  if (!heatmapVisible) map.removeLayer(baseLayer);
})();
