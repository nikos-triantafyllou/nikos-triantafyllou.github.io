# 150 MHz Sky Map — interactive survey footprints

A static, dependency-free (aside from Plotly.js via CDN) page that reproduces
your `figure.py` sky map as an interactive webpage. The GSM background is
fixed; each survey/instrument footprint has a checkbox in the sidebar so
visitors can toggle it on or off.

## Files

```
surveys.html            page structure + styling (the entry point)
surveys_folder/
  app.js                 loads the data and drives the plot + checkboxes
  regenerate_data.py      regenerates the data files from a new .npy map
  data/
    gsm_150MHz.bin        the sky map, log10-scaled, 256x256 float32 (downsampled from your 512x512 .npy)
    axes.json             RA/Dec axis values + color scale range (zmin/zmax)
    surveys.json           footprint polygons, grouped by survey name
```

## Deploying to GitHub Pages

1. Copy `surveys.html` and the whole `surveys_folder/` directory into your
   GitHub Pages repo, keeping them side by side (e.g. both at the repo
   root, or both inside a `docs/` folder if that's what Pages is
   configured to serve).
2. Commit and push. No build step — GitHub Pages serves static files
   directly.
3. Your page will be live at `https://<username>.github.io/<repo>/surveys.html`
   (or the relevant sub-path).

## Updating the data

**To swap in a different frequency map** (a new `.npy` file, same 512x512
grid convention as `gsm_150MHz.npy`):

```bash
cd surveys_folder
python3 regenerate_data.py path/to/new_map.npy
```

This rewrites `data/gsm_150MHz.bin` and `data/axes.json`. Commit and push —
the live page updates automatically, no code changes needed.

**To add, remove, or edit survey footprints**, edit `data/surveys.json`
directly. Each survey is a named group of one or more polygon shapes:

```json
"MyNewSurvey": {
  "shapes": [
    { "kind": "polygon", "x": [ra1, ra2, ra3, ...], "y": [dec1, dec2, dec3, ...] }
  ]
}
```

- `x` values are RA in hours (0–24), `y` values are Dec in degrees.
- For an ellipse/circle footprint (a beam or field-of-view), sample points
  around its perimeter, e.g. in Python:
  ```python
  import numpy as np
  t = np.linspace(0, 2*np.pi, 64)
  x = cx + (width/2)*np.cos(t)
  y = cy + (height/2)*np.sin(t)
  ```
- Add a matching entry in `SURVEY_COLORS` at the top of `app.js` if you want
  a specific color; otherwise it defaults to white.
- The sidebar checkbox list is generated automatically from whatever keys
  exist in `surveys.json` — you don't need to touch the HTML.

No rebuild step is needed for either change — just edit the JSON/binary data
files, commit, and push.

## Notes

- The background map is downsampled to 256×256 (from your original 512×512)
  to keep the page lightweight and fast; this is purely a display
  resolution and doesn't affect the footprint overlays, which use the full
  original coordinate precision.
- Colors, default-off footprints (currently FRESCO/MUSE-WIDE/UDF/UDF-10/XMM,
  since they're tiny sub-arcmin fields that clutter the map at full zoom),
  and styling can all be tweaked in `app.js` / `index.html`.
