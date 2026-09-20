# Third-party assets (exact tags; copy verbatim)

MapLibre GL JS 4.7.1 from cdnjs (only on pages with a map), before `js/mdm.js`:

```html
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.min.css" integrity="sha384-K282sW/zFjTkrjR/+yr1H+gCukuy4OEYrkXRybV88g7pk+kZZYpNV6SAV59NcgFg" crossorigin="anonymous">
<script defer src="https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.min.js" integrity="sha384-KKgyz2mG25bKJ1O2PyqTJPlAF8Kw2BpDmsLTNBXslICOBvhTAyF5F0XhLWF2ZovY" crossorigin="anonymous"></script>
```

Map style: OpenFreeMap Positron `https://tiles.openfreemap.org/styles/positron` (free, no API key, full-planet OSM). Attribution stays visible.

Fonts (every page, in `<head>` before base.css):

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap">
```

Favicon (every page):

```html
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%23111114'/%3E%3Ctext x='16' y='22' text-anchor='middle' font-family='Inter,system-ui,sans-serif' font-weight='600' font-size='18' fill='%23fff'%3EM%3C/text%3E%3C/svg%3E">
```
