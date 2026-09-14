// ---- Config: one color per survey group ----
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

// Groups shown expanded (checked) by default; smaller GOODS-S sub-fields default off
// to keep the map legible on first load.
const DEFAULT_OFF = new Set(["FRESCO", "MUSE-WIDE", "UDF", "UDF-10", "XMM"]);

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
  const [axes, surveys] = await Promise.all([
    fetch('surveys_folder/data/axes.json').then(r => r.json()),
    fetch('surveys_folder/data/surveys.json').then(r => r.json()),
  ]);

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

  for (const [name, group] of Object.entries(surveys)) {
    groupTraceIndices[name] = [];
    const color = SURVEY_COLORS[name] || '#ffffff';
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
        visible: DEFAULT_OFF.has(name) ? 'legendonly' : true,
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

  buildSidebar(groupTraceIndices);
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function buildSidebar(groupTraceIndices) {
  const list = document.getElementById('survey-list');
  const names = Object.keys(groupTraceIndices);

  names.forEach(name => {
    const row = document.createElement('label');
    row.className = 'survey-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !DEFAULT_OFF.has(name);
    checkbox.addEventListener('change', () => {
      const indices = groupTraceIndices[name];
      Plotly.restyle('plot', { visible: checkbox.checked ? true : 'legendonly' }, indices);
    });

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = SURVEY_COLORS[name] || '#ffffff';

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
    '<p style="color:#ff8a3d;font-family:monospace;padding:20px;">Failed to load data — check the browser console and confirm surveys_folder/data/gsm_150MHz.bin, surveys_folder/data/axes.json and surveys_folder/data/surveys.json are present relative to surveys.html.</p>';
});
