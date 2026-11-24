"""Full-client recovery and stop-upload checks with synthetic HTTP replies."""
import argparse
from datetime import datetime, timezone
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
    requests, errors, response_state = [], [], {'status': 503}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=args.chromium,
                args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
            context = browser.new_context(viewport={'width': 390, 'height': 844})

            def handle(route):
                if route.request.url.startswith(origin):
                    route.continue_()
                elif '/api/visary/geometry/vehicle?' in route.request.url:
                    requests.append(route.request.url)
                    if response_state['status'] != 200:
                        route.fulfill(status=response_state['status'], body='Unavailable')
                    else:
                        route.fulfill(json=[{'VehicleId': 1, 'RouteId': 1, 'RouteShortName': '49',
                            'TransportType': 'bus', 'Direction': 45,
                            'Location': {'Longitude': 30.33, 'Latitude': 59.93},
                            'DateTime': datetime.now(timezone.utc).isoformat()}])
                else:
                    route.abort()

            context.route('**/*', handle)
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            # Only the live-poll interval is accelerated. Request deadlines,
            # host debounce and rendering use the ordinary browser clock.
            page.add_init_script("""(() => {
              const timeout=window.setTimeout.bind(window);
              window.setTimeout=(callback,delay,...args)=>timeout(callback,delay===16000?600:delay,...args);
            })();""")
            page.goto(origin)
            wait_for_map(page)
            page.evaluate("map.jumpTo({center:[30.33,59.93],zoom:16,bearing:0,pitch:0});closeSheet()")
            page.wait_for_function("moduleHost.get('spb-stops').status==='ready' && map.getSource('module-spb-stops:stops-source')._data.features.length>0")
            page.wait_for_timeout(250)
            page.evaluate("""() => {
              window.stopUploads=0;
              const source=map.getSource('module-spb-stops:stops-source'),setData=source.setData.bind(source);
              source.setData=(data)=>{window.stopUploads++;return setData(data)};
              map.fire('moveend');map.fire('moveend');
            }""")
            page.wait_for_timeout(300)
            assert page.evaluate('stopUploads') == 0, 'Identical stops must not be uploaded again'
            before = page.evaluate('({center:map.getCenter().toArray(),zoom:map.getZoom(),bearing:map.getBearing(),pitch:map.getPitch()})')

            page.evaluate("moduleHost.enable('spb-live')")
            page.wait_for_function("moduleHost.get('spb-live').status==='ready' && !!moduleHost.get('spb-live').warning")
            assert page.evaluate("moduleHost.get('spb-live').error") is None
            assert page.evaluate("map.getSource('module-spb-live:bus-source')._data.features.length") == 0
            page.evaluate("window.originalLiveSession=moduleHost.entries.get('spb-live').session;transportUI.open('presets')")
            status = page.locator('#transport-panel .transport-status')
            assert 'автоматически' in status.inner_text(), status.inner_text()
            assert 'is-error' not in (status.get_attribute('class') or '')

            response_state['status'] = 200
            page.wait_for_function("!moduleHost.get('spb-live').warning && map.getSource('module-spb-live:bus-source')._data.features.length===1")
            page.wait_for_function("map.queryRenderedFeatures({layers:['module-spb-live:bus-point']}).length>0")
            assert page.evaluate("originalLiveSession===moduleHost.entries.get('spb-live').session"), 'Recovery should retain its session'
            assert page.evaluate('({center:map.getCenter().toArray(),zoom:map.getZoom(),bearing:map.getBearing(),pitch:map.getPitch()})') == before
            assert status.is_hidden(), 'Recovered source removes the transient message'

            # A live-feed warning must not rebuild the unrelated metro list
            # and discard its focused/selected station.
            page.evaluate("""async () => {
              await moduleHost.configure('spb-metro',{selectedLine:'6'});
              await moduleHost.enable('spb-metro');transportUI.open('metro');
            }""")
            station = page.locator('#transport-panel .transport-station').first
            station.wait_for()
            station.click()
            page.wait_for_timeout(550)
            station.evaluate('(element)=>{window.selectedMetroStation=element}')
            response_state['status'] = 503
            page.wait_for_function("!!moduleHost.get('spb-live').warning && map.getSource('module-spb-live:bus-source')._data.features.length===0")
            assert page.evaluate("selectedMetroStation.isConnected && document.activeElement===selectedMetroStation && selectedMetroStation.getAttribute('aria-pressed')==='true'"), 'Warning must preserve metro selection and focus'
            response_state['status'] = 200
            page.wait_for_function("!moduleHost.get('spb-live').warning")
            assert page.evaluate("selectedMetroStation.isConnected && document.activeElement===selectedMetroStation && selectedMetroStation.getAttribute('aria-pressed')==='true'"), 'Recovery must preserve metro selection and focus'
            response_state['status'] = 503
            page.wait_for_function("!!moduleHost.get('spb-live').warning")
            page.evaluate('map.jumpTo({zoom:11})')
            page.wait_for_function("!moduleHost.get('spb-live').warning")
            overview_count = len(requests)
            page.wait_for_timeout(900)
            assert len(requests) == overview_count, 'Overview must stop retries'
            assert page.evaluate("moduleHost.get('spb-live').enabled")

            page.evaluate('map.jumpTo({zoom:16})')
            page.wait_for_function("!!moduleHost.get('spb-live').warning")
            page.evaluate("moduleHost.disable('spb-live')")
            disabled_count = len(requests)
            page.wait_for_timeout(900)
            assert len(requests) == disabled_count, 'Disable must cancel retries'
            assert page.evaluate("!map.getSource('module-spb-live:bus-source') && !map.listImages().some(id=>id.startsWith('module-spb-live:'))")

            response_state['status'] = 403
            page.evaluate("moduleHost.enable('spb-live')")
            page.wait_for_function("moduleHost.get('spb-live').status==='error'")
            assert '403' in page.evaluate("moduleHost.get('spb-live').error")
            assert page.evaluate("moduleHost.get('spb-live').warning") is None
            fatal_count = len(requests)
            page.wait_for_timeout(900)
            assert len(requests) == fatal_count, 'Permanent errors require explicit retry'
            assert not errors, errors
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print('Transport recovery browser OK: unchanged stops avoid uploads; initial/repeated503 recover in the same session, warning UI clears, camera stays, metro selection/focus survives, overview/disable cancel retries,403 stays fatal (synthetic HTTP, accelerated poll interval)')


if __name__ == '__main__':
    main()
