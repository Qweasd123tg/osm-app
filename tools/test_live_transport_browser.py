"""Render actual module layers/popups with synthetic municipal network replies."""
import argparse
from datetime import datetime, timezone
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright
from test_browser import QuietHandler, wait_for_map, open_panel


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--chromium')
    args = parser.parse_args()
    assets = Path(__file__).resolve().parents[1] / 'app/src/main/assets'
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(assets)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    requests, errors = [], []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=args.chromium,
                args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
            context = browser.new_context(viewport={'width': 390, 'height': 844})

            def handle(route):
                url = route.request.url
                if url.startswith(origin):
                    route.continue_()
                elif '/api/visary/geometry/vehicle?' in url:
                    requests.append(url)
                    current = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
                    route.fulfill(json=[{'VehicleId': 100 + i, 'RouteId': 1278,
                        'Location': {'Longitude': 30.33 + i * .001, 'Latitude': 59.93},
                        'TransportType': kind, 'RouteShortName': str(number),
                        'Direction': 90, 'DateTime': current}
                        for i, (kind, number) in enumerate([('bus', 49), ('tram', 3), ('trolley', 17)])])
                elif '/api/visary/stop/byLocationType?' in url:
                    requests.append(url)
                    route.fulfill(json=[{'Title': 'Невский пр.', 'Longitude': 30.332,
                        'Latitude': 59.931, 'LocationType': 0, 'StopId': 1, 'MetroLine': 2},
                        {'Title': 'Невский пр., вход 1', 'Longitude': 30.3321,
                         'Latitude': 59.9311, 'LocationType': 2, 'StopId': 2, 'MetroLine': 2}])
                else:
                    route.abort()

            context.route('**/*', handle)
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(origin)
            wait_for_map(page)
            assert not requests, 'Optional modules must never fetch at startup'
            page.evaluate("map.jumpTo({center:[30.33,59.93],zoom:16,pitch:0,bearing:0});closeSheet()")
            before = page.evaluate("({center:map.getCenter().toArray(),zoom:map.getZoom(),bearing:map.getBearing(),pitch:map.getPitch()})")
            page.evaluate("moduleHost.enable('spb-live')")
            page.wait_for_function("moduleHost.get('spb-live').status==='ready'")
            assert len(requests) == 1
            page.wait_for_function("map.queryRenderedFeatures({layers:['module-spb-live:bus-point']}).length>0")
            assert page.evaluate("map.getSource('module-spb-live:bus-source')._data.features[0].properties.name") == '49 · Автобус'
            assert page.evaluate("map.getSource('module-spb-live:tram-source')._data.features[0].properties.label") == '3'
            assert page.evaluate("map.getLayer('module-spb-live:bus-label').type") == 'symbol'
            assert page.evaluate("map.getLayoutProperty('module-spb-live:bus-label','icon-image')[1]") == '__moduleLabelImage'
            assert page.evaluate("map.listImages().some(id=>id.startsWith('module-spb-live:label-'))"), 'Badges are generated locally without the external glyph endpoint'
            colors = page.evaluate("['bus','tram','trolley'].map(t=>map.getSource('module-spb-live:'+t+'-source')._data.features[0].properties.__moduleColor)")
            assert len(set(colors)) == 3
            assert page.evaluate("({center:map.getCenter().toArray(),zoom:map.getZoom(),bearing:map.getBearing(),pitch:map.getPitch()})") == before
            point = page.evaluate("map.project([30.33,59.93])")
            page.mouse.click(point['x'], point['y'])
            page.locator('.maplibregl-popup-content').wait_for()
            popup = page.locator('.maplibregl-popup-content').inner_text()
            assert '49 · Автобус' in popup and 'Получено' in popup, popup
            assert 'VehicleId' not in popup and 'rawTimestamp' not in popup, popup
            page.locator('.maplibregl-popup-close-button').click()

            open_panel(page, 'module-settings')
            live = page.locator('[data-module-settings="spb-live"]')
            live.get_by_label('Транспорт сейчас: Номер маршрута').fill('3')
            live.locator('form button').click()
            page.wait_for_function("moduleHost.get('spb-live').status==='ready' && moduleHost.get('spb-live').settings.route==='3'")
            assert page.evaluate("map.getSource('module-spb-live:bus-source')._data.features.length") == 0
            assert page.evaluate("map.getSource('module-spb-live:tram-source')._data.features.length") == 1
            assert page.evaluate("map.getSource('module-spb-live:trolley-source')._data.features.length") == 0
            page.locator('#settings-back').click()
            page.locator('#settings-back').click()

            page.evaluate("moduleHost.enable('spb-metro')")
            page.wait_for_function("moduleHost.get('spb-metro').status==='ready'")
            assert page.evaluate("map.getSource('module-spb-metro:stations-source')._data.features[0].properties.kind") == 'metro_station'
            assert page.evaluate("map.getSource('module-spb-metro:entrances-source')._data.features[0].properties.kind") == 'metro_entrance'
            assert page.evaluate("map.getLayer('module-spb-metro:entrances-point').minzoom") == 15
            assert page.evaluate("map.getSource('module-spb-metro:lines-source')._data.features.length") == 6
            assert page.evaluate("map.getSource('module-spb-metro:stations-source')._data.features.length") == 75
            assert page.evaluate("map.getLayer('module-spb-metro:stations-point-icon').minzoom") == 12
            assert page.evaluate("map.getLayoutProperty('module-spb-metro:stations-point-icon','icon-rotation-alignment')") == 'viewport'
            assert page.evaluate("map.getSource('module-spb-metro:stations-source')._data.features.every(f=>!!f.properties.__modulePointIconImage)")
            assert page.evaluate("map.listImages().some(id=>id.startsWith('module-spb-metro:label-'))")
            assert all('transport=subway' not in url for url in requests)
            # Labels leave first, followed by station dots. Paths remain for
            # the city overview; no extra geocoder or glyph server is involved.
            page.evaluate("""map.jumpTo({center:SloiMetro.lines.length && map.getSource('module-spb-metro:stations-source')._data.features.find(f=>f.properties.line==='2').geometry.coordinates,zoom:13,pitch:0,bearing:0})""")
            page.wait_for_function("map.queryRenderedFeatures({layers:['module-spb-metro:stations-label']}).length>0 && map.queryRenderedFeatures({layers:['module-spb-metro:stations-point']}).length>0")
            page.wait_for_function("map.queryRenderedFeatures({layers:['module-spb-metro:stations-point-icon']}).length>0")
            page.evaluate("map.jumpTo({zoom:11})")
            page.wait_for_function("map.queryRenderedFeatures({layers:['module-spb-metro:stations-label']}).length===0 && map.queryRenderedFeatures({layers:['module-spb-metro:stations-point']}).length>0")
            assert page.evaluate("map.queryRenderedFeatures({layers:['module-spb-metro:stations-point-icon']}).length") == 0
            page.evaluate("map.jumpTo({zoom:9})")
            page.wait_for_function("map.queryRenderedFeatures({layers:['module-spb-metro:stations-label','module-spb-metro:stations-point']}).length===0 && map.queryRenderedFeatures({layers:['module-spb-metro:lines-line']}).length>0")
            page.evaluate("themePreference='dark';applyTheme()")
            page.wait_for_function("moduleHost.get('spb-metro').status==='ready' && [...moduleHost.entries.get('spb-metro').session.labelImages.keys()].every(k=>k.startsWith('text-dark|'))")
            page.evaluate("themePreference='light';applyTheme()")
            page.wait_for_function("moduleHost.get('spb-metro').status==='ready' && [...moduleHost.entries.get('spb-metro').session.labelImages.keys()].every(k=>k.startsWith('text-light|'))")
            page.evaluate("moduleHost.disable('spb-live');moduleHost.disable('spb-metro')")
            assert page.evaluate("!map.getSource('module-spb-live:bus-source') && !map.getLayer('module-spb-live:bus-label') && !map.getSource('module-spb-metro:stations-source')")
            assert page.evaluate("!map.listImages().some(id=>id.startsWith('module-spb-live:label-')||id.startsWith('module-spb-metro:label-'))")
            assert not errors, errors
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print('Live transport browser OK: optional startup, real MapLibre typed labels/colors, truthful popup, route filter in Settings, actual metro points and owned cleanup (synthetic HTTP, not native feed proof)')


if __name__ == '__main__':
    main()
