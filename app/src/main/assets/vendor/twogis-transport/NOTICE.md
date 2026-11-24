# Пиктограммы транспорта 2ГИС

Ресурсы извлечены из предоставленного пользователем APK 2ГИС
(`ru.dublgis.dgismobile`, версия 7.31.1.638.2).
SVG скопированы без изменений. `transport-symbols.js` использует их контуры
и правила заливки для отображения на карте и в интерфейсе.

Пути в APK начинаются с
`reference/qrc/qt/qml/DGisQml/Templates/resources/images/` после извлечения Qt-ресурсов.

| Файл | Путь в извлечённых ресурсах |
| --- | --- |
| `bus.svg` | `polaris/24/bus-fill.svg` |
| `tram.svg` | `polaris/24/tram-fill.svg` |
| `trolley.svg` | `polaris/24/trolleybus-fill.svg` |
| `metro-spb.svg` | `transports/metro_Spb.svg` |
| `metro-spb-plain.svg` | `dashboard/metro_Spb.svg` |

Значки карты извлечены из того же выпуска APK. В
`split_config.arm64_v8a.apk` файл `lib/arm64-v8a/libv4android.so`
содержит архив со стилями `files/Basic_styles7.31.1-2026.11.2.2gis`.
Оригиналы находятся в `zmap/vidoc/textures/atlas_vector.zic` внутри архива.

| Файл | Название и номер в атласе |
| --- | --- |
| `map-vehicle-arrow.svg` | `dynamic_eta_bus_arrow`, 129 |
| `map-bus.svg` | `dynamic_eta_bus_left`, 130 |
| `map-tram.svg` | `dynamic_eta_tram_left`, 163 |
| `map-trolley.svg` | `dynamic_eta_trolley_left`, 168 |
| `map-stop-back.svg` | `offline_transport_layout`, 2406 |
| `map-stop-bus.svg` | `offline_transport_avtobus`, 2394 |
| `map-metro-spb.svg` | `offline_metro_mm_spb`, 1950 |
| `map-metro-spb-night.svg` | `offline_metro_mm_spb_night`, 1951 |

Пиктограммы принадлежат их правообладателям и входят в ресурсы приложения 2ГИС.
