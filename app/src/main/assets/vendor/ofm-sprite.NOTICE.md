# OpenFreeMap base styles and sprite

Retrieved 2026-11-16 from the official OpenFreeMap public instance:

- https://tiles.openfreemap.org/styles/positron
- https://tiles.openfreemap.org/styles/dark
- https://tiles.openfreemap.org/sprites/ofm_f384/ofm.json
- https://tiles.openfreemap.org/sprites/ofm_f384/ofm.png
- https://tiles.openfreemap.org/sprites/ofm_f384/ofm@2x.json
- https://tiles.openfreemap.org/sprites/ofm_f384/ofm@2x.png

Styles are embedded in `../basemap.js`. Adaptations: shared vector source,
local sprite URL, prefixed theme layers, and Russian-preferred single labels.
Unused Natural Earth raster source is omitted. No business POI layers are added.

See `ofm-styles.LICENSE.txt`, `ofm-positron.LICENSE.txt` and
`ofm-dark-matter.LICENSE.txt` for upstream licence notices. The sprite contains
Maki icons (CC0) and a public-domain arrow, as documented by OpenFreeMap.
Positron and Dark Matter style code is BSD 3-Clause, style design CC BY 4.0;
they derive from CartoDB/Stamen/Paul Norman basemaps (CC BY 3.0).

Runtime map attribution comes from the official vector TileJSON:
OpenFreeMap / OpenMapTiles / OpenStreetMap contributors.
