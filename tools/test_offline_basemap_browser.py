"""Offline UI/source handover with a local MVT fixture; no public tile downloads.

Native transfer/atomic publication are covered independently by JVM tests.
"""
import argparse
from functools import partial
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright
from test_browser import QuietHandler, open_panel, wait_for_map


def varint(value):
    result = bytearray()
    while value >= 128:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)


def field(number, value):
    return varint(number * 8 + 2) + varint(len(value)) + value


def water_tile():
    # Clockwise polygon, with no font or sprite dependency.
    geometry = b"".join(varint(v) for v in [9, 0, 0, 26, 8192, 0, 0, 8192, 8191, 0, 15])
    feature = varint(8) + varint(1) + varint(24) + varint(3) + field(4, geometry)
    layer = field(1, b"water") + field(2, feature) + varint(40) + varint(4096) + varint(120) + varint(2)
    return field(3, layer)


HOST = """(() => {
window.offlineRequests=[];window.offlineCancels=0;window.offlineDeletes=0;
window.AndroidHost={
  getOfflineBasemap(){return JSON.stringify(window.fixtureRecord||null)},
  listOfflineBasemap(){queueMicrotask(()=>SloiApp.onOfflineBasemap(window.fixtureRecord||null))},
  downloadOfflineBasemap(json){offlineRequests.push(JSON.parse(json))},
  cancelOfflineBasemap(){offlineCancels++},
  deleteOfflineBasemap(){offlineDeletes++}
};
})()"""


def camera(page):
    return page.evaluate("({center:map.getCenter().toArray(),zoom:map.getZoom(),pitch:map.getPitch(),bearing:map.getBearing()})")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--chromium")
    args = parser.parse_args()
    assets = Path(__file__).resolve().parents[1] / "app/src/main/assets"
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(assets)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_port}"
    local = "https://appassets.androidplatform.net/basemap/p-" + "a" * 32 + "/"
    tilejson = {"tilejson": "3.0.0", "minzoom": 0, "maxzoom": 14, "tiles": [local + "tiles/{z}/{x}/{y}.pbf"]}
    external = []
    local_requests = []
    errors = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=args.chromium,
                args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
            context = browser.new_context(viewport={"width": 390, "height": 844})
            context.add_init_script(HOST)

            def route_request(route):
                url = route.request.url
                if url.startswith(origin):
                    route.continue_()
                elif url == local + "tilejson.json":
                    local_requests.append(url)
                    route.fulfill(json=tilejson, headers={"Access-Control-Allow-Origin": "*"})
                elif url.startswith(local + "tiles/"):
                    local_requests.append(url)
                    route.fulfill(body=water_tile(), content_type="application/x-protobuf", headers={"Access-Control-Allow-Origin": "*"})
                else:
                    external.append(url)
                    route.abort()

            context.route("**/*", route_request)
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(origin)
            wait_for_map(page)
            page.evaluate("map.jumpTo({center:[30.32,59.9],zoom:15,pitch:25,bearing:17})")
            page.wait_for_function("!map.isMoving()")
            open_panel(page, "offline")
            assert page.locator("#offline-basemap").get_attribute("data-status") == "empty"
            assert page.locator("#offline-basemap-delete").is_hidden()
            page.locator("#offline-basemap-download").click()
            request = page.evaluate("offlineRequests.at(-1)")
            assert request["bounds"] == page.evaluate("map.getBounds().toArray()")
            page.evaluate("id=>SloiApp.onOfflineBasemapProgress(id,'download',16384,0)", request["requestId"])
            assert page.locator("#offline-basemap-status").inner_text() == "Загружено 16 КБ"
            assert page.locator("#offline-basemap-progress").get_attribute("value") is None
            record = {"id": "p-" + "a" * 32, "status": "installed", "name": "Fixture", "bounds": request["bounds"],
                      "bytes": 1200000, "tileCount": 20, "tileJsonUrl": local + "tilejson.json"}
            before = camera(page)
            page.evaluate("value=>{window.fixtureRecord=value;window.sourceBefore=map.getSource('openmaptiles');window.layersBefore=map.getStyle().layers.map(x=>x.id);SloiApp.onOfflineBasemapChanged(value)}", record)
            page.wait_for_function("offlineBasemap.isUsingOffline() && map.isSourceLoaded('openmaptiles')")
            page.wait_for_function("map.queryRenderedFeatures({layers:['base-light:water']}).length>0")
            assert camera(page) == before
            assert page.evaluate("sourceBefore===map.getSource('openmaptiles')")
            assert page.evaluate("JSON.stringify(layersBefore)===JSON.stringify(map.getStyle().layers.map(x=>x.id))")
            assert page.locator("#offline-basemap-status").inner_text() == "На устройстве · 1.1 МБ"
            assert local_requests

            # All intersecting tiles were saved in full. A small pan past the
            # exact requested rectangle still uses those complete local tiles.
            page.evaluate("map.jumpTo({center:[30.3201,59.9]})")
            page.wait_for_function("map.isSourceLoaded('openmaptiles')")
            assert page.evaluate("offlineBasemap.isUsingOffline()")
            page.evaluate("map.jumpTo({center:[30.32,59.9]})")

            # Cached-area zoom needs only the immutable local source. All remote
            # requests remain blocked throughout this renderer test.
            external.clear()
            page.evaluate("map.jumpTo({zoom:16});saveCamera()")
            page.wait_for_function("map.isSourceLoaded('openmaptiles')")
            assert not external, external
            assert page.evaluate("offlineBasemap.isUsingOffline()")
            assert camera(page)["bearing"] == before["bearing"]

            # A failed or cancelled replacement leaves the complete area usable.
            page.locator("#offline-basemap-download").click()
            second = page.evaluate("offlineRequests.at(-1)")
            page.evaluate("id=>SloiApp.onOfflineBasemapError(id,'Сеть недоступна')", second["requestId"])
            assert page.evaluate("offlineBasemap.isUsingOffline()")
            page.locator("#offline-basemap-download").click()
            third = page.evaluate("offlineRequests.at(-1)")
            page.locator("#offline-basemap-download").click()
            assert page.locator("#offline-basemap-download").is_disabled()
            page.evaluate("id=>SloiApp.onOfflineBasemapProgress(id,'download',9000000,0)", third["requestId"])
            assert page.locator("#offline-basemap-status").inner_text() == "Отменяю загрузку…"
            page.evaluate("SloiApp.onOfflineBasemapChanged(fixtureRecord)")
            assert page.evaluate("offlineCancels") == 1
            assert page.evaluate("offlineBasemap.isUsingOffline()")

            # Moving out and back changes only source URL, never the camera.
            page.evaluate("map.jumpTo({center:[31.5,60]})")
            page.wait_for_function("!offlineBasemap.isUsingOffline()")
            page.evaluate("map.jumpTo({center:[30.32,59.9]})")
            page.wait_for_function("offlineBasemap.isUsingOffline() && map.isSourceLoaded('openmaptiles')")

            # A process/page restart selects the installed package before tile
            # rendering, while retaining route/layer sources and saved camera.
            context.add_init_script("window.fixtureRecord=" + json.dumps(record))
            external.clear()
            page.reload()
            wait_for_map(page)
            page.wait_for_function("offlineBasemap.isUsingOffline() && map.isSourceLoaded('openmaptiles')")
            assert not external, external
            page.wait_for_function("map.queryRenderedFeatures({layers:['base-light:water']}).length>0")
            open_panel(page, "offline")
            page.set_viewport_size({"width": 320, "height": 740})
            assert page.locator("#panel-offline").evaluate("node=>node.scrollWidth<=node.clientWidth")
            page.locator("#offline-basemap-delete").click()
            assert page.evaluate("offlineDeletes") == 1
            page.evaluate("SloiApp.onOfflineBasemapChanged(null)")
            assert page.locator("#offline-basemap-delete").is_hidden()
            assert not page.evaluate("offlineBasemap.isUsingOffline()")
            assert not errors, errors
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print("Offline basemap OK: local MVT rendered without remote requests, camera/layer continuity, restart, progress, failure/cancel, deletion and 320px layout")


if __name__ == "__main__":
    main()
