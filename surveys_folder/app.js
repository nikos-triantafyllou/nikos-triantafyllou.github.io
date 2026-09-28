// ---- known deep-field centers (RA hours, Dec degrees, J2000) ----
// Extend this as new `field` values show up in the sheet.
const FIELD_CENTERS = {
  "COSMOS":  [10.0079, 2.2058],
  "GOODS-S": [3.5417, -27.8000],
  "GOODS-N": [12.6153, 62.2375],
  "CDFS":    [3.5417, -27.8000],
  "HUDF":    [3.5442, -27.7914],
  "EGS":     [14.3167, 52.8000],
  "UDS":     [2.2969, -5.0994],
};

// Sheet column headers (lowercased) -> internal field names.
const HEADER_ALIASES = {
  "survey": "name",
  "telescope": "telescope",
  "instrument": "instrument",
  "type": "type",
  "targeting line/ spectrum region/ filters": "targeting",
  "space or ground": "space_or_ground",
  "year": "year",
  "~ total area (in sq. deg)": "area_sqdeg",
  "depth (l in erg/s, f in erg/s/cm^2)": "depth",
  "ab limiting magnitude": "ab_limiting_magnitude",
  "z accuracy": "z_accuracy",
  "z range": "z_range",
  "field": "field",
  "references": "references",
  "show_on_map": "show_on_map",
  "points_override": "points_override",
  "color": "color",
  "default_visible": "default_visible",
};

// ---- Config: fallback colors / default-off for the original hand-authored
// footprints in data/surveys.json (SKA, COMAP, etc.). Anything coming from
// the CSV carries its own color/default_visible instead of using these. ----
const SURVEY_COLORS = {
  "SKA":        "#ff9f43",
  "COMAP":      "#ffe066",
  "CCAT":       "#f6c453",
  "Roman":      "#6ec6ff",
  "Euclid":     "#b892ff",
  "XMM":        "#66d9c2",
  "HSC":        "#ff6b81",
  "COSMOS":     "#63e6be",
  "E-CDF-S":    "#c7f464",
  "CANDELS":    "#ffa8a8",
  "FRESCO":     "#ffd6a5",
  "MUSE-WIDE":  "#a0c4ff",
  "UDF":        "#bdb2ff",
  "UDF-10":     "#ffc6ff",
};
const DEFAULT_OFF = new Set(["FRESCO", "MUSE-WIDE", "UDF", "UDF-10", "XMM"]);

// ================= CSV -> survey shapes (client-side) =================

function slugify(name) {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "survey";
}

function parseBool(val) {
  return ["TRUE", "YES", "Y", "1"].includes(String(val || "").trim().toUpperCase());
}

// One polygon's point list: "ra,dec; ra,dec; ..."
function parsePointsOverride(val) {
  const pts = val.split(";").map(p => p.trim()).filter(Boolean);
  const xs = [], ys = [];
  for (const p of pts) {
    const [ra, dec] = p.split(",");
    xs.push(parseFloat(ra.trim()));
    ys.push(parseFloat(dec.trim()));
  }
  return { kind: "polygon", x: xs, y: ys };
}

// Multiple disjoint polygons in one cell:
//   {[ra,dec; ra,dec; ...],[ra,dec; ra,dec; ...]}
// Outer {} is optional; each polygon is bracketed with [...]. Also accepts a
// single bare polygon with no brackets at all, for backward compatibility:
//   ra,dec; ra,dec; ...
function parsePointsOverrideMulti(val) {
  val = val.trim();
  if (val.startsWith("{") && val.endsWith("}")) {
    val = val.slice(1, -1).trim();
  }
  const matches = [...val.matchAll(/\[([^\]]*)\]/g)];
  if (matches.length === 0) {
    return [parsePointsOverride(val)]; // bare polygon, no brackets
  }
  return matches.map(m => parsePointsOverride(m[1]));
}

function boxShape(raH, decDeg, areaSqDeg) {
  const sideDeg = Math.sqrt(Math.max(areaSqDeg, 0));
  const halfHeight = sideDeg / 2;
  const cosDec = Math.max(Math.cos(decDeg * Math.PI / 180), 1e-3);
  const halfWidthCoordDeg = halfHeight / cosDec;
  const halfWidthH = halfWidthCoordDeg / 15;
  const raLo = raH - halfWidthH, raHi = raH + halfWidthH;
  const decLo = decDeg - halfHeight, decHi = decDeg + halfHeight;
  return { kind: "polygon", x: [raLo, raHi, raHi, raLo], y: [decLo, decLo, decHi, decHi] };
}

function parseFieldTokens(fieldStr) {
  const tokens = [];
  if (!fieldStr) return tokens;
  fieldStr.split(",").forEach(chunkRaw => {
    const chunk = chunkRaw.trim();
    if (!chunk) return;
    const m = chunk.match(/^([A-Za-z0-9\-\+]+)\s*(?:\(([\d.]+)\))?/);
    if (!m) return;
    const name = m[1].trim();
    const area = m[2] ? parseFloat(m[2]) : null;
    const upper = name.toUpperCase();
    if (FIELD_CENTERS[upper]) tokens.push([upper, area]);
    else if (FIELD_CENTERS[name]) tokens.push([name, area]);
  });
  return tokens;
}

function autoShapesFromField(fieldStr, totalArea) {
  let tokens = parseFieldTokens(fieldStr || "");
  if (tokens.length === 0) return null;
  const missingIdx = tokens.map((t, i) => t[1] === null ? i : -1).filter(i => i >= 0);
  if (missingIdx.length > 0) {
    if (totalArea === null || totalArea === undefined) return null;
    let remaining = totalArea;
    tokens.forEach(([, a]) => { if (a !== null) remaining -= a; });
    const share = Math.max(remaining, 0) / missingIdx.length;
    tokens = tokens.map(([name, a]) => [name, a !== null ? a : share]);
  }
  return tokens.map(([name, area]) => {
    const [raH, decDeg] = FIELD_CENTERS[name];
    return boxShape(raH, decDeg, area);
  });
}

// Robust CSV parser: quoted fields, embedded commas/newlines, "" escapes.
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  let i = 0;
  const len = text.length;
  while (i < len) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    } else {
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { row.push(field); field = ""; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += c; i++; continue;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function loadCsvRows(csvText) {
  const rows = parseCSV(csvText);
  if (rows.length === 0) return [];

  // Find the real header row by looking for the show_on_map column, rather
  // than assuming row 0 is the header — sheets often have a notes/title row
  // above the actual column headers (e.g. a "Generic references" row).
  let headerIdx = rows.findIndex(r => r.some(c => c.trim().toLowerCase() === "show_on_map"));
  if (headerIdx === -1) headerIdx = 0; // fallback: no marker found, assume row 0

  const header = rows[headerIdx].map(h => h.trim().toLowerCase());
  const keys = header.map(h => HEADER_ALIASES[h] || null);
  const records = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const raw = rows[r];
    if (!raw.some(c => c.trim())) continue;
    const rec = {};
    keys.forEach((key, idx) => { if (key) rec[key] = (raw[idx] || "").trim(); });
    records.push(rec);
  }
  return records;
}

// ---- redshift range parsing ("5.8 - 8", ">5", "~7", "6–10+", "<6", "7.3") ----
const MAX_Z = 15; // slider ceiling; open-ended ranges (">5", trailing "+") are capped here

function parseZRange(str) {
  if (!str) return null;
  let s = str.trim();
  if (!s) return null;
  // normalize en/em dashes and the unicode minus sign to a plain hyphen
  s = s.replace(/[\u2010-\u2015\u2212]/g, "-");

  let m = s.match(/^[zZ]?\s*>=?\s*([\d.]+)/);
  if (m) return { zmin: parseFloat(m[1]), zmax: MAX_Z };

  m = s.match(/^[zZ]?\s*<=?\s*([\d.]+)/);
  if (m) return { zmin: 0, zmax: parseFloat(m[1]) };

  m = s.match(/([\d.]+)\s*-\s*([\d.]+)(\s*\+)?/);
  if (m) {
    const zmin = parseFloat(m[1]);
    const zmax = m[3] ? MAX_Z : parseFloat(m[2]);
    return { zmin, zmax };
  }

  m = s.match(/^~?\s*([\d.]+)(\+)?$/);
  if (m) {
    const v = parseFloat(m[1]);
    return m[2] ? { zmin: v, zmax: MAX_Z } : { zmin: v, zmax: v };
  }

  return null; // unrecognized format — treated as "no redshift info" (always shown)
}

// Metadata columns available for the hover-info picker: key -> display label.
// `key` matches the internal field name from HEADER_ALIASES.
const METADATA_FIELDS = [
  { key: "telescope", label: "Telescope" },
  { key: "instrument", label: "Instrument" },
  { key: "type", label: "Type" },
  { key: "targeting", label: "Targeting" },
  { key: "space_or_ground", label: "Space/ground" },
  { key: "year", label: "Year" },
  { key: "area_sqdeg", label: "Area (sq deg)" },
  { key: "depth", label: "Depth" },
  { key: "ab_limiting_magnitude", label: "AB limiting magnitude" },
  { key: "z_accuracy", label: "z accuracy" },
  { key: "z_range", label: "z range" },
  { key: "field", label: "Field" },
  { key: "references", label: "References" },
];

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Builds the hover text for one survey from whichever metadata fields are
// currently checked in the sidebar. Empty cells are skipped automatically.
function buildHoverText(name, selectedKeys, meta) {
  const lines = [`<b>${escapeHtml(name)}</b>`];
  meta = meta || {};
  METADATA_FIELDS.forEach(f => {
    if (!selectedKeys.has(f.key)) return;
    const val = (meta[f.key] || "").trim();
    if (!val) return;
    lines.push(`${f.label}: ${escapeHtml(val)}`);
  });
  return lines.join("<br>");
}

function buildSurveysFromCsvRecords(records) {
  const surveysJson = {};
  for (const rec of records) {
    const name = rec.name || "";
    const telescope = rec.telescope || "";
    if (!name || !telescope) continue; // section-divider or blank row
    if (!parseBool(rec.show_on_map)) continue;

    let shapes = null;
    const override = rec.points_override || "";
    if (override) {
      try { shapes = parsePointsOverrideMulti(override); }
      catch (e) { console.warn(`${name}: bad points_override`, e); }
    }
    if (shapes === null) {
      let area = null;
      if (rec.area_sqdeg) {
        const cleaned = rec.area_sqdeg.replace(/[^\d.]/g, "");
        area = cleaned ? parseFloat(cleaned) : null;
      }
      shapes = autoShapesFromField(rec.field || "", area);
    }
    if (!shapes) {
      console.warn(`${name}: flagged show_on_map but no recognized field+area or points_override — skipping`);
      continue;
    }

    surveysJson[name] = { shapes };
    if (rec.color) surveysJson[name].color = rec.color;
    surveysJson[name].default_visible = rec.default_visible ? parseBool(rec.default_visible) : true;
    surveysJson[name].zRange = parseZRange(rec.z_range || "");
    // Full row, kept for the hover-info picker (minus the map-control columns).
    surveysJson[name].meta = {
      telescope: rec.telescope || "",
      instrument: rec.instrument || "",
      type: rec.type || "",
      targeting: rec.targeting || "",
      space_or_ground: rec.space_or_ground || "",
      year: rec.year || "",
      area_sqdeg: rec.area_sqdeg || "",
      depth: rec.depth || "",
      ab_limiting_magnitude: rec.ab_limiting_magnitude || "",
      z_accuracy: rec.z_accuracy || "",
      z_range: rec.z_range || "",
      field: rec.field || "",
      references: rec.references || "",
    };
  }
  return surveysJson;
}

async function loadCsvSurveys(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return {}; // fine if the CSV hasn't been added yet
    const text = await res.text();
    return buildSurveysFromCsvRecords(loadCsvRows(text));
  } catch (e) {
    console.warn("Could not load CSV survey data (fine if you haven't added it yet):", e);
    return {};
  }
}

// ================= existing plotting code =================

async function loadBinaryFloat32(url, count) {
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  return new Float32Array(buf, 0, count);
}

function reshape(flat, ny, nx) {
  const z = new Array(ny);
  for (let j = 0; j < ny; j++) {
    z[j] = Array.from(flat.subarray(j * nx, (j + 1) * nx));
  }
  return z;
}

async function main() {
  const [axes, csvSurveys] = await Promise.all([
    fetch('surveys_folder/data/axes.json').then(r => r.json()),
    loadCsvSurveys('surveys_folder/data/surveys_for_eor.csv'),
  ]);

  // The CSV is the only source: only rows flagged show_on_map=TRUE appear.
  const surveys = csvSurveys;

  const flat = await loadBinaryFloat32('surveys_folder/data/gsm_150MHz.bin', axes.nx * axes.ny);
  const z = reshape(flat, axes.ny, axes.nx);

  const heatmap = {
    type: 'heatmap',
    x: axes.ra,
    y: axes.dec,
    z: z,
    zmin: axes.zmin,
    zmax: axes.zmax,
    colorscale: 'Hot',
    showscale: true,
    colorbar: {
      title: { text: 'log₁₀ T [K]', font: { color: '#e9e6de', family: 'IBM Plex Mono' } },
      tickfont: { color: '#9a9791', family: 'IBM Plex Mono', size: 10 },
      outlinewidth: 0,
      thickness: 14,
    },
    hoverinfo: 'skip',
    name: 'GSM 150 MHz',
  };

  // Build one scatter trace per polygon shape, tagged with its survey name.
  const overlayTraces = [];
  const groupTraceIndices = {}; // survey name -> [trace indices into overlayTraces]
  const startVisible = {};      // survey name -> boolean (checkbox starts checked?)
  const resolvedColors = {};    // survey name -> the color actually used (for the sidebar swatch)
  const zRanges = {};           // survey name -> {zmin, zmax} | null (no redshift info)
  const metaByName = {};        // survey name -> full metadata row (for the hover-info picker)
  let hoverSelected = new Set(); // currently checked metadata fields (shared across all surveys)

  for (const [name, group] of Object.entries(surveys)) {
    groupTraceIndices[name] = [];
    const color = group.color || SURVEY_COLORS[name] || nextAutoColor();
    resolvedColors[name] = color;
    zRanges[name] = group.zRange || null;
    metaByName[name] = group.meta || {};
    const visible = group.default_visible !== undefined
      ? group.default_visible
      : !DEFAULT_OFF.has(name);
    startVisible[name] = visible;

    group.shapes.forEach((shape, i) => {
      overlayTraces.push({
        type: 'scatter',
        mode: 'lines',
        x: shape.x.concat(shape.x[0]),
        y: shape.y.concat(shape.y[0]),
        fill: 'toself',
        fillcolor: hexToRgba(color, 0.28),
        line: { color: color, width: 1.4 },
        name: name,
        legendgroup: name,
        showlegend: false,
        text: buildHoverText(name, hoverSelected, group.meta),
        hoverinfo: 'text',
        visible: visible ? true : 'legendonly',
      });
      groupTraceIndices[name].push(overlayTraces.length - 1 + 1); // +1: heatmap occupies index 0
    });
  }

  const data = [heatmap, ...overlayTraces];

  const layout = {
    paper_bgcolor: '#0b0c10',
    plot_bgcolor: '#0b0c10',
    font: { color: '#e9e6de', family: 'Source Serif 4' },
    margin: { l: 60, r: 20, t: 18, b: 55 },
    xaxis: {
      title: { text: 'Right ascension [h]', font: { size: 15 } },
      range: [0, 24],
      gridcolor: '#22242c',
      zerolinecolor: '#22242c',
      tickfont: { size: 12 },
    },
    yaxis: {
      title: { text: 'Declination [deg]', font: { size: 15 } },
      range: [-60, 5],
      gridcolor: '#22242c',
      zerolinecolor: '#22242c',
      tickfont: { size: 12 },
    },
    showlegend: false,
  };

  const config = { responsive: true, displaylogo: false };

  await Plotly.newPlot('plot', data, layout, config);

  // Combined visibility = checkbox state AND redshift-filter match. Surveys
  // with no parseable z range are always considered a match (unaffected by
  // the slider) since we have nothing to filter them by.
  const checkedState = Object.assign({}, startVisible);
  const zSel = { lo: 0, hi: MAX_Z, includeUnranged: true };

  function zMatches(name) {
    const r = zRanges[name];
    if (!r) return zSel.includeUnranged;
    return r.zmin <= zSel.hi && r.zmax >= zSel.lo;
  }

  function applyVisibility(name) {
    const visible = checkedState[name] && zMatches(name);
    Plotly.restyle('plot', { visible: visible ? true : 'legendonly' }, groupTraceIndices[name]);
  }

  function applyAllVisibility() {
    Object.keys(groupTraceIndices).forEach(applyVisibility);
  }

  function updateHoverTexts() {
    Object.keys(groupTraceIndices).forEach(name => {
      const txt = buildHoverText(name, hoverSelected, metaByName[name]);
      Plotly.restyle('plot', { text: txt, hoverinfo: 'text' }, groupTraceIndices[name]);
    });
  }

  // Each panel is set up independently: a bug in one (or a browser that's
  // still running a stale cached copy of part of this file) shouldn't take
  // down the others.
  try { buildSidebar(groupTraceIndices, resolvedColors, checkedState, applyVisibility); }
  catch (e) { console.error('Sidebar checkbox list failed to build:', e); }

  try { setupZFilter(zSel, applyAllVisibility); }
  catch (e) { console.error('Redshift filter failed to build:', e); }

  try { buildHoverFieldsUI(hoverSelected, updateHoverTexts); }
  catch (e) { console.error('Hover-info dropdown failed to build:', e); }
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = x => Math.round(255 * x).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

// Auto-assigns well-separated colors (golden-angle hue stepping, biased
// toward cool hues so they read clearly against the warm 'Hot' background
// colormap) to any survey that doesn't set its own `color` in the sheet.
let autoColorCount = 0;
function nextAutoColor() {
  const hue = (200 + autoColorCount * 137.508) % 360;
  autoColorCount++;
  return hslToHex(hue, 75, 62);
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ---- hover-info field picker: a dropdown of checkboxes for which metadata
// columns show up in the tooltip when hovering a footprint. ----
function buildHoverFieldsUI(hoverSelected, updateHoverTexts) {
  const list = document.getElementById('hoverfield-list');
  const toggle = document.getElementById('hoverfields-toggle');
  const countEl = document.getElementById('hoverfields-count');
  if (!list || !toggle) return;

  function updateCount() {
    countEl.textContent = hoverSelected.size > 0 ? `(${hoverSelected.size})` : '';
  }

  function closePanel() {
    list.classList.remove('open');
    toggle.classList.remove('open');
  }

  METADATA_FIELDS.forEach(f => {
    const row = document.createElement('label');
    row.className = 'field-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = hoverSelected.has(f.key);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) hoverSelected.add(f.key);
      else hoverSelected.delete(f.key);
      updateCount();
      updateHoverTexts();
    });

    const label = document.createElement('span');
    label.textContent = f.label;

    row.appendChild(checkbox);
    row.appendChild(label);
    list.appendChild(row);
  });

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = list.classList.toggle('open');
    toggle.classList.toggle('open', isOpen);
  });
  // clicking anywhere outside the panel closes it; clicks inside (including
  // on a checkbox/label) don't propagate to this listener.
  list.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', closePanel);

  updateCount();
}

function buildSidebar(groupTraceIndices, resolvedColors, checkedState, applyVisibility) {
  const list = document.getElementById('survey-list');
  const names = Object.keys(groupTraceIndices);

  names.forEach(name => {
    const row = document.createElement('label');
    row.className = 'survey-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = checkedState[name];
    checkbox.addEventListener('change', () => {
      checkedState[name] = checkbox.checked;
      applyVisibility(name);
    });

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = resolvedColors[name];

    const label = document.createElement('span');
    label.textContent = name;

    row.appendChild(checkbox);
    row.appendChild(swatch);
    row.appendChild(label);
    list.appendChild(row);
  });

  document.getElementById('btn-all').addEventListener('click', () => {
    document.querySelectorAll('#survey-list input[type=checkbox]').forEach(cb => {
      if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
    });
  });
  document.getElementById('btn-none').addEventListener('click', () => {
    document.querySelectorAll('#survey-list input[type=checkbox]').forEach(cb => {
      if (cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change')); }
    });
  });
}

// ---- redshift slider: two overlapping <input type=range> elements acting
// as a dual-handle slider. Dragging both handles to the same value selects
// an exact redshift; spreading them selects a range. ----
function setupZFilter(zSel, applyAllVisibility) {
  const minInput = document.getElementById('z-min');
  const maxInput = document.getElementById('z-max');
  const fill = document.getElementById('zslider-fill');
  const readout = document.getElementById('zfilter-readout');
  const resetBtn = document.getElementById('btn-zreset');
  const unrangedBtn = document.getElementById('btn-toggle-unranged');
  if (!minInput || !maxInput) return; // markup not present; skip silently

  minInput.min = maxInput.min = 0;
  minInput.max = maxInput.max = MAX_Z;
  minInput.step = maxInput.step = 0.1;
  minInput.value = zSel.lo;
  maxInput.value = zSel.hi;

  function renderUnrangedBtn() {
    if (!unrangedBtn) return;
    unrangedBtn.classList.toggle('active', zSel.includeUnranged);
    unrangedBtn.setAttribute('aria-pressed', String(zSel.includeUnranged));
    unrangedBtn.textContent = zSel.includeUnranged ? 'Unranged: shown' : 'Unranged: hidden';
  }

  function render() {
    const pctLo = (zSel.lo / MAX_Z) * 100;
    const pctHi = (zSel.hi / MAX_Z) * 100;
    fill.style.left = pctLo + '%';
    fill.style.width = Math.max(pctHi - pctLo, 0) + '%';

    if (zSel.lo <= 0 && zSel.hi >= MAX_Z) {
      readout.textContent = `z: all (${MAX_Z.toFixed(0)}+ open)`;
    } else if (Math.abs(zSel.lo - zSel.hi) < 0.05) {
      readout.textContent = `z ≈ ${zSel.lo.toFixed(1)}`;
    } else {
      const hiLabel = zSel.hi >= MAX_Z ? `${MAX_Z.toFixed(0)}+` : zSel.hi.toFixed(1);
      readout.textContent = `z: ${zSel.lo.toFixed(1)} – ${hiLabel}`;
    }
  }

  minInput.addEventListener('input', () => {
    let v = parseFloat(minInput.value);
    if (v > zSel.hi) { zSel.hi = v; maxInput.value = v; }
    zSel.lo = v;
    render();
    applyAllVisibility();
  });

  maxInput.addEventListener('input', () => {
    let v = parseFloat(maxInput.value);
    if (v < zSel.lo) { zSel.lo = v; minInput.value = v; }
    zSel.hi = v;
    render();
    applyAllVisibility();
  });

  resetBtn.addEventListener('click', () => {
    zSel.lo = 0; zSel.hi = MAX_Z; zSel.includeUnranged = true;
    minInput.value = 0; maxInput.value = MAX_Z;
    render();
    renderUnrangedBtn();
    applyAllVisibility();
  });

  if (unrangedBtn) {
    unrangedBtn.addEventListener('click', () => {
      zSel.includeUnranged = !zSel.includeUnranged;
      renderUnrangedBtn();
      applyAllVisibility();
    });
  }

  render();
  renderUnrangedBtn();
}

main().catch(err => {
  console.error(err);
  document.getElementById('plot').innerHTML =
    '<p style="color:#ff8a3d;font-family:monospace;padding:20px;">Failed to load data — check the browser console and confirm surveys_folder/data/gsm_150MHz.bin and surveys_folder/data/axes.json are present relative to surveys.html.</p>';
});
