"""Verify phone-density live vehicle sprites and overlapping route pixels in MapLibre."""
import argparse
from datetime import datetime, timedelta, timezone
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright
from test_browser import QuietHandler, wait_for_map


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--chromium')
    args = parser.parse_args()
    assets = Path(__file__).resolve().parents[1] / 'app/src/main/assets'
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(assets)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=args.chromium,
                args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
            viewport = {'width': 450, 'height': 975}
            context = browser.new_context(viewport=viewport, screen=viewport, device_scale_factor=2.4,
                is_mobile=True, has_touch=True, reduced_motion='reduce')
            context.add_init_script("""Object.defineProperty(navigator, 'geolocation', {
              value: {getCurrentPosition(resolve) {
                resolve({coords:{longitude:30.326, latitude:59.93}});
              }}
            })""")

            def handle(route):
                url = route.request.url
                if url.startswith(origin):
                    route.continue_()
                elif '/api/visary/geometry/vehicle?' in url:
                    # Exercise the municipal Moscow-as-Z timestamps which
                    # previously rendered the vehicle with only 40% opacity.
                    observed = datetime.now(timezone.utc) + timedelta(hours=3, seconds=-75)
                    route.fulfill(json=[{'VehicleId': 1, 'RouteId': 1, 'RouteShortName': '49',
                        'TransportType': 'bus', 'Direction': 0, 'DateTime': observed.isoformat(),
                        'Location': {'Longitude': 30.33, 'Latitude': 59.93}}])
                elif 'routing.openstreetmap.de/' in url:
                    route.fulfill(json={'code': 'Ok', 'routes': [{'duration': 600, 'distance': 500,
                        'geometry': {'type': 'LineString', 'coordinates': [[30.326, 59.93], [30.334, 59.93]]}}]})
                else:
                    route.abort()

            context.route('**/*', handle)
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(origin)
            wait_for_map(page)
            page.evaluate("""async () => {
              closeSheet();
              map.jumpTo({center:[30.33,59.93],zoom:16,pitch:0,bearing:0});
              await moduleHost.enable('spb-live');
              selectedPlace={name:'Назначение',longitude:30.334,latitude:59.93};
            }""")
            page.wait_for_function("map.queryRenderedFeatures({layers:['module-spb-live:bus-point']}).length > 0")
            page.locator('#route-open').click()
            page.locator('.routing-submit').click()
            page.locator('.routing-option').first.wait_for()
            page.wait_for_function("!map.isMoving()")
            page.evaluate("map.jumpTo({center:[30.33,59.93],zoom:16,pitch:0,bearing:0})")
            page.wait_for_function("""() => {
              const center=map.project([30.33,59.93]);
              return map.queryRenderedFeatures(center, {layers:['route-plan-line']}).length > 0 &&
                map.queryRenderedFeatures({layers:['module-spb-live:bus-point','module-spb-live:bus-vehicle-icon',
                  'module-spb-live:bus-label']}).length >= 3;
            }""")
            result = page.evaluate("""() => new Promise(resolve => {
              map.once('render', () => {
                const canvas=map.getCanvas(), gl=map.painter.context.gl;
                const feature=map.getSource('module-spb-live:bus-source')._data.features[0];
                const properties=feature.properties;
                const layers=['point','vehicle-icon','label'].map(name=>'module-spb-live:bus-'+name);
                const images=['__moduleVehicleBodyImage','__moduleVehicleIconImage','__moduleLabelImage']
                  .map(key=>map.getImage(properties[key]))
                  .map(({data,pixelRatio})=>[data.width,data.height,pixelRatio]);
                const anchor=map.project(feature.geometry.coordinates);
                const pixel=(dx,dy)=>{
                  const sx=gl.drawingBufferWidth/canvas.clientWidth, sy=gl.drawingBufferHeight/canvas.clientHeight;
                  const rgba=new Uint8Array(4);
                  gl.readPixels(Math.round((anchor.x+dx)*sx),Math.round(gl.drawingBufferHeight-(anchor.y+dy)*sy)-1,
                    1,1,gl.RGBA,gl.UNSIGNED_BYTE,rgba);
                  return [...rgba];
                };
                resolve({canvas:[canvas.width,canvas.height,canvas.clientWidth,canvas.clientHeight], images,
                  opacity:layers.map(id=>map.getPaintProperty(id,'icon-opacity')),
                  bodyOnRoute:pixel(9,0),routeOutsideBody:pixel(25,0),status:properties.statusText});
              });
              map.triggerRepaint();
            })""")
            assert result['canvas'] == [1080, 2340, 450, 975], result
            assert result['images'][:2] == [[120, 120, 3], [120, 120, 3]], result
            assert result['images'][2][1:] == [45, 3], result
            assert result['opacity'] == [1, 1, 1], result
            assert result['bodyOnRoute'] == [26, 115, 240, 255], result
            assert result['routeOutsideBody'] == [35, 179, 75, 255], result
            assert 'Время позиции не подтверждено' in result['status'], result
            assert 'Позиция могла устареть' in result['status'], result
            page.set_viewport_size({'width': 760, 'height': 850})
            page.wait_for_function("""() => {
              const canvas=map.getCanvas();
              return canvas.clientWidth===760 && canvas.clientHeight===850 && map.getPixelRatio()<2.4;
            }""")
            width, height = page.evaluate("[map.getCanvas().width, map.getCanvas().height]")
            assert 2_990_000 < width * height <= 3_000_000, (width, height)
            page.evaluate("""() => {
              const economy=document.getElementById('economy-mode');
              economy.checked=true;
              economy.dispatchEvent(new Event('change'));
            }""")
            assert page.evaluate("[map.getPixelRatio(), map.getCanvas().width, map.getCanvas().height]") == [1, 760, 850]
            assert not errors, errors
            context.close()

            # A small browser window on a large screen fits the pixel budget.
            desktop = browser.new_context(viewport={'width': 800, 'height': 600},
                screen={'width': 2560, 'height': 1440}, device_scale_factor=1)
            desktop.route('**/*', lambda route: route.continue_()
                          if route.request.url.startswith(origin) else route.abort())
            page = desktop.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(origin)
            wait_for_map(page)
            assert page.evaluate("[map.getPixelRatio(), map.getCanvas().width, map.getCanvas().height]") == [1, 800, 600]
            assert not errors, errors
            browser.close()
            print('Native phone and desktop buffers, opaque 3× vehicle sprites above the walking line, resize budget and economy mode OK')
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
