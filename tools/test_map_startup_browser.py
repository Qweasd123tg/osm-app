"""Ordinary map startup must be independent of the optional shadow example."""

import argparse
from functools import partial
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright
from test_browser import QuietHandler, open_advanced, open_panel, wait_for_map


BRIDGE = """(() => {
    window.sceneRequests = [];
    window.placeRequests = [];
    window.sceneCancellations = [];
    window.AndroidHost = {
        requestScene: text => sceneRequests.push(JSON.parse(text)),
        searchPlaces: text => placeRequests.push(JSON.parse(text)),
        cancelScene: id => sceneCancellations.push(id),
        cancelShadowFrame() {}, listCityPacks() {}, haptic() {},
    };
    Object.defineProperty(navigator, 'geolocation', {configurable: true, value: {
        getCurrentPosition(success) {
            success({coords: {latitude: 48.8566, longitude: 2.3522}});
        },
    }});
})()"""


def assert_empty_map(page):
    assert page.evaluate("data === null && frames.length === 0")
    assert page.evaluate("fallbackData === null && !window.SLOI_MAP_DATA")
    assert page.locator("#time-card").is_hidden()
    assert page.locator("#active-count").inner_text() == "0"
    assert page.evaluate("map.getSource('buildings')._data.features.length") == 0
    assert page.evaluate("map.getSource('shadows')._data.features.length") == 0
    assert not page.locator("#fatal").evaluate("node => node.classList.contains('is-visible')")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--chromium")
    args = parser.parse_args()
    assets = Path(__file__).resolve().parents[1] / "app/src/main/assets"
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(assets)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_port}"
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=args.chromium,
                args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
            errors = []
            demo_requests = []
            allow_demo = False

            def route_request(route):
                url = route.request.url
                if url.endswith("/map-data.js"):
                    demo_requests.append(url)
                    if not allow_demo:
                        route.abort()
                        return
                if url.startswith(origin):
                    route.continue_()
                else:
                    route.abort()

            context = browser.new_context(viewport={"width": 390, "height": 844})
            context.route("**/*", route_request)
            context.add_init_script(BRIDGE)
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(origin)
            wait_for_map(page)
            page.wait_for_function("libraryLoaded")
            assert_empty_map(page)
            assert page.evaluate("state.mode") == "2d"
            assert page.evaluate("map.getZoom()") == 2
            assert page.evaluate("Math.abs(map.getCenter().lng) < 1e-6 && Math.abs(map.getCenter().lat - 20) < 1e-6")
            assert demo_requests == [], "The optional map data must not be requested on startup"
            assert page.evaluate("sceneRequests") == []

            # Reload restores a user-controlled camera, without restoring a scene.
            camera = {"center": [37.6173, 55.7558], "zoom": 15, "bearing": 23, "pitch": 36}
            page.evaluate("""camera => {
                state.mode='3d'; applyMapState(); map.jumpTo(camera);
                map.jumpTo({pitch:camera.pitch});
            }""", camera)
            page.wait_for_function("!!localStorage.getItem('sloi-map-camera')")
            saved = page.evaluate("JSON.parse(localStorage.getItem('sloi-map-camera'))")
            assert abs(saved["center"][0] - camera["center"][0]) < 1e-6
            page.reload()
            wait_for_map(page)
            page.wait_for_function("libraryLoaded")
            assert_empty_map(page)
            restored = page.evaluate("({center:map.getCenter().toArray(), zoom:map.getZoom(), bearing:map.getBearing(), pitch:map.getPitch()})")
            for actual, expected in zip(restored["center"], camera["center"]):
                assert abs(actual - expected) < 1e-6
            for key in ["zoom", "bearing", "pitch"]:
                assert abs(restored[key] - camera[key]) < 1e-6, (key, restored)
            assert demo_requests == []

            # A malformed, stale or hostile camera record falls back to the world.
            for invalid in ["broken", json.dumps({"center": [30.3, 59.9], "zoom": "15"}),
                            json.dumps({**camera, "center": [999, 999]}),
                            json.dumps({**camera, "pitch": 999})]:
                invalid_context = browser.new_context(viewport={"width": 390, "height": 844})
                invalid_context.route("**/*", route_request)
                invalid_context.add_init_script(
                    "localStorage.setItem('sloi-map-camera', " + json.dumps(invalid) + ")")
                invalid_page = invalid_context.new_page()
                invalid_page.on("pageerror", lambda error: errors.append(str(error)))
                invalid_page.goto(origin)
                wait_for_map(invalid_page)
                assert invalid_page.evaluate("map.getZoom()") == 2
                assert_empty_map(invalid_page)
                invalid_context.close()
            assert demo_requests == []

            # An installed offline source keeps its toggle available while disabled.
            # No scene or native tile response is needed to switch it back on.
            open_panel(page)
            page.evaluate("""() => {
                window.viewportRequests = [];
                AndroidHost.requestViewportBuildings = value => viewportRequests.push(value);
                AndroidHost.cancelViewportBuildings = () => {};
                state.buildings = false;
                applyMapState();
                SloiApp.onCityPacks({packs:[{id:'test-pack',name:'Тестовый офлайн-город',
                    status:'installed',installedBytes:1024,bounds:[[2,48],[3,49]]}]});
            }""")
            building_toggle = page.locator("#building-toggle")
            building_switch = page.locator('[data-layer="buildings"] .switch')
            assert building_toggle.is_enabled()
            assert not building_toggle.is_checked()
            building_switch.click()
            assert page.evaluate("state.buildings") is True
            building_switch.click()
            assert not building_toggle.is_checked()
            assert building_toggle.is_enabled()
            building_switch.click()
            assert page.evaluate("state.buildings") is True
            assert page.evaluate("data === null && viewport.loaded.size === 0")
            assert page.evaluate("viewportRequests") == []
            page.evaluate("SloiApp.onCityPacks({packs:[]})")
            assert building_toggle.is_disabled()
            page.locator("#close-sheet").click()
            assert_empty_map(page)

            # Choosing a search result navigates the map, without calculating shadows.
            open_panel(page, "search")
            page.locator("#place-query").fill("Москва")
            page.locator("#place-submit").click()
            page.wait_for_function("placeRequests.length > 0")
            page.evaluate("""() => SloiApp.onPlacesReady(placeRequests.at(-1).requestId, JSON.stringify([
                {lat:'55.7558',lon:'37.6173',display_name:'Москва, тест поиска'}
            ]))""")
            page.get_by_role("button", name="Москва, тест поиска", exact=True).click()
            page.wait_for_function("!map.isMoving()")
            assert page.evaluate("Math.abs(map.getCenter().lng - 37.6173) < 1e-6")
            assert page.evaluate("sceneRequests") == []
            assert_empty_map(page)

            # Geolocation is also navigation; calculation remains an explicit action.
            open_panel(page, "search")
            page.locator("#my-location").click()
            page.wait_for_function("!map.isMoving()")
            assert page.evaluate("Math.abs(map.getCenter().lat - 48.8566) < 1e-6")
            assert page.evaluate("Math.abs(map.getCenter().lng - 2.3522) < 1e-6")
            assert page.evaluate("sceneRequests") == []
            assert_empty_map(page)

            assert page.locator("#load-center").is_hidden()
            assert page.locator("#scene-date-form").is_hidden()
            assert page.evaluate("moduleHost.get('shadows').enabled") is False

            # Local overlays and presets work while no scene or frames exist.
            open_advanced(page)
            geojson = {"type": "FeatureCollection", "features": [{"type": "Feature",
                "properties": {"name": "Питьевой фонтанчик"},
                "geometry": {"type": "Point", "coordinates": [2.3522, 48.8566]}}]}
            page.locator("#layer-file").set_input_files({"name": "Фонтанчики.geojson",
                "mimeType": "application/json", "buffer": json.dumps(geojson).encode()})
            page.wait_for_function("customLayers.size === 1 && !importBusy")
            local_layer_id = page.evaluate("[...customLayers.keys()][0]")
            assert page.evaluate("data === null && frames.length === 0")
            assert page.locator("#active-count").inner_text() == "1"
            page.locator("#preset-name").fill("Карта без расчёта")
            page.locator("#preset-form button").click()
            assert page.locator(".preset-name").inner_text() == "Карта без расчёта"
            page.get_by_role("button", name="Применить набор «Карта без расчёта»", exact=True).click()
            assert page.evaluate("data === null && frames.length === 0")
            assert page.locator("#time-card").is_hidden()

            # A newer navigation owns the controls even if geolocation has not replied.
            page.evaluate("""() => {
                navigator.geolocation.getCurrentPosition = (success, failure) => {
                    window.deferredLocationSuccess = success;
                    window.deferredLocationFailure = failure;
                };
            }""")
            open_panel(page, "search")
            page.locator("#my-location").click()
            assert page.locator("#my-location").is_disabled()
            page.evaluate("selectPlace(52.52, 13.405, 'Новое выбранное место')")
            page.wait_for_function("!map.isMoving()")
            assert page.locator("#my-location").is_enabled()
            assert page.locator("#my-location").is_enabled()
            selected_status = page.locator("#place-status").inner_text()
            selected_camera = page.evaluate("map.getCenter().toArray()")
            page.evaluate("""async () => {
                deferredLocationSuccess({coords:{latitude:35.68,longitude:139.76}});
                await Promise.resolve(); await Promise.resolve();
            }""")
            assert page.evaluate("map.getCenter().toArray()") == selected_camera
            assert page.locator("#place-status").inner_text() == selected_status
            assert page.locator("#my-location").is_enabled()

            # Permission failure from the map toolbar opens a visible explanation.
            page.evaluate("""() => {
                navigator.geolocation.getCurrentPosition = (_success, failure) => {
                    failure({code:1,message:'permission denied'});
                };
                window.appSettingsOpened=0;
                AndroidHost.getLocationState=()=>JSON.stringify({enabled:true,permission:'blocked'});
                AndroidHost.openAppSettings=()=>appSettingsOpened++;
            }""")
            assert page.locator("#layers-sheet").evaluate("node => node.inert")
            page.locator("#locate").click()
            page.wait_for_function("!document.getElementById('my-location').disabled")
            assert not page.locator("#layers-sheet").evaluate("node => node.inert")
            assert page.locator("#place-status").is_visible()
            assert "доступ к местоположению" in page.locator("#place-status").inner_text()
            assert page.locator("#place-status").evaluate("node => node.classList.contains('is-error')")
            assert page.locator("#location-settings").is_visible()
            assert page.evaluate("appSettingsOpened") == 0
            page.locator("#location-settings").click()
            assert page.evaluate("appSettingsOpened") == 1
            assert page.evaluate("customLayers.size === 1 && data === null")
            assert demo_requests == []

            scene_count_before_demo = page.evaluate("sceneRequests.length")

            # A missing optional example must not turn normal map startup fatal.
            page.evaluate("async () => {try {await loadDemoScene()} catch (_) {}}")
            assert len(demo_requests) == 1
            assert page.evaluate("mapReady && data === null && frames.length === 0")
            assert not page.locator("#fatal").evaluate("node => node.classList.contains('is-visible')")
            page.evaluate("""() => {
                navigator.geolocation.getCurrentPosition = success => {window.lateDemoLocation = success};
                void locateOnMap();
            }""")
            assert page.locator("#my-location").is_disabled()
            allow_demo = True
            page.evaluate("loadDemoScene()")
            page.wait_for_function("!map.isMoving()")
            assert page.locator("#my-location").is_enabled()
            demo_camera = page.evaluate("map.getCenter().toArray()")
            demo_status = page.locator("#place-status").inner_text()
            page.evaluate("""async () => {
                lateDemoLocation({coords:{latitude:35.68,longitude:139.76}});
                await Promise.resolve(); await Promise.resolve();
            }""")
            assert page.evaluate("map.getCenter().toArray()") == demo_camera
            assert page.locator("#place-status").inner_text() == demo_status
            assert page.locator("#my-location").is_enabled()
            assert len(demo_requests) == 2, "A failed optional load must be retryable"
            assert page.evaluate("data.buildings.features.length > 0 && frames.length > 0")
            assert page.evaluate("activeSceneId") is None
            assert page.evaluate("map.getLayoutProperty('buildings-3d', 'visibility') !== 'none'")
            assert page.evaluate("moduleHost.get('shadows').enabled") is False
            assert page.evaluate("sceneRequests.length") == scene_count_before_demo

            # Both reads and writes may be blocked: the base map must still start.
            blocked_context = browser.new_context(viewport={"width": 390, "height": 844})
            blocked_context.route("**/*", route_request)
            blocked_context.add_init_script("""Storage.prototype.getItem = function() {throw new Error('denied')};
                Storage.prototype.setItem = function() {throw new Error('denied')};""")
            blocked = blocked_context.new_page()
            blocked.on("pageerror", lambda error: errors.append(str(error)))
            blocked.goto(origin)
            wait_for_map(blocked)
            assert_empty_map(blocked)
            assert blocked.evaluate("map.getZoom()") == 2
            blocked.evaluate("map.jumpTo({center:[-73.98,40.75],zoom:14})")
            assert blocked.evaluate("map.getZoom()") == 14
            assert not errors, errors
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print("Map startup OK: no baked district, camera restore, navigation and stale geolocation, optional shadow module, independent overlays, optional demo recovery")


if __name__ == "__main__":
    main()
