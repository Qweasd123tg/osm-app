# Vendored MapLibre

This directory contains the browser build of MapLibre GL JS 4.7.1:

- `maplibre-gl.js`
- `maplibre-gl.css`
- `maplibre-gl.LICENSE.txt`

The files are vendored so the Android WebView can start without downloading its
map engine from a CDN. They were downloaded from the published
`maplibre-gl@4.7.1` npm package via unpkg. Raster basemap tiles are still loaded
over HTTPS at runtime.
