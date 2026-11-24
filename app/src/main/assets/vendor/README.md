# Vendored MapLibre and OpenFreeMap assets

This directory contains the browser build of MapLibre GL JS 4.7.1:

- `maplibre-gl.js`
- `maplibre-gl.css`
- `maplibre-gl.LICENSE.txt`

The files are vendored so the Android WebView can start without downloading its
map engine from a CDN. They were downloaded from the published
`maplibre-gl@4.7.1` npm package via unpkg.

The engine bundle is unchanged. The application gesture adapter in
`../map-gestures.js` uses the exported `TwoFingersTouchRotateHandler` for
incremental rotation and its screen direction. A small subclass changes only
the activation distance from 25 to 4 CSS pixels along the touch circle; 4.7.1
has no public rotation-threshold option. Axis selection and the restrictions
on two-finger panning and three-finger input remain application policy. See the
[versioned handler source](https://github.com/maplibre/maplibre-gl-js/blob/v4.7.1/src/ui/handler/two_fingers_touch.ts#L168-L221).

The current basemap uses OpenFreeMap vector tiles. Positron and Dark styles are
embedded in `../basemap.js`, sharing one `openmaptiles` source with TileJSON at
`https://tiles.openfreemap.org/planet`. Style layers are namespaced by theme;
switching themes does not replace the map or custom overlays. Labels prefer
Russian names and business POI layers are omitted.

Sprite files `ofm-sprite.json`, `ofm-sprite.png` and their `@2x` variants are
vendored locally. Unsaved vector tiles and font glyphs require HTTPS access to
OpenFreeMap; installed areas use the local package. No registration or API key is required; see the official
[Quick Start](https://openfreemap.org/quick_start/) and
[Terms of Service](https://openfreemap.org/tos/).

OpenFreeMap's current offline allowance is up to 3,000 tiles or 50 MB per
download, at most 4 parallel requests, and a unique application User-Agent.
The app installs one complete visible area with zoom levels 0–14, sprites,
styles and Latin/Cyrillic glyphs, bounded by both 3,000 tiles and 50,000,000 bytes.
It uses saved tiles only when their complete bounds at the current zoom cover
the viewport. BBBike city packages contain addresses, places and buildings
and are a separate data path; see
[`docs/OFFLINE-CITIES.md`](../../../../../docs/OFFLINE-CITIES.md).

The previous CARTO endpoint returned HTTP 200 with an `API KEY REQUIRED` image;
the intermediate OSM Standard raster implementation has also been replaced.
A successful HTTP status alone does not prove that a response is a usable map
tile. The OSM Standard tile policy is not the policy of the current provider.

Source URLs and retrieval date are recorded in `ofm-sprite.NOTICE.md`. Retain
`ofm-styles.LICENSE.txt`, `ofm-positron.LICENSE.txt` and
`ofm-dark-matter.LICENSE.txt` with these adapted assets. Runtime attribution
identifies OpenFreeMap, OpenMapTiles and OpenStreetMap contributors.
