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
      try { shapes = [parsePointsOverride(override)]; }
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

  for (const [name, group] of Object.entries(surveys)) {
    groupTraceIndices[name] = [];
    const color = group.color || SURVEY_COLORS[name] || '#ffffff';
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
        hoverinfo: 'name',
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

  buildSidebar(groupTraceIndices, surveys, startVisible);
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function buildSidebar(groupTraceIndices, surveys, startVisible) {
  const list = document.getElementById('survey-list');
  const names = Object.keys(groupTraceIndices);

  names.forEach(name => {
    const row = document.createElement('label');
    row.className = 'survey-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = startVisible[name];
    checkbox.addEventListener('change', () => {
      const indices = groupTraceIndices[name];
      Plotly.restyle('plot', { visible: checkbox.checked ? true : 'legendonly' }, indices);
    });

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = (surveys[name] && surveys[name].color) || SURVEY_COLORS[name] || '#ffffff';

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

main().catch(err => {
  console.error(err);
  document.getElementById('plot').innerHTML =
    '<p style="color:#ff8a3d;font-family:monospace;padding:20px;">Failed to load data — check the browser console and confirm surveys_folder/data/gsm_150MHz.bin and surveys_folder/data/axes.json are present relative to surveys.html.</p>';
});
