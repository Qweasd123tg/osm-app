"""Optional shadow extension follows the viewport without disturbing navigation.

Uses the real bundled JavaScript and controlled native bridge replies. This is
not evidence of native geometry performance or a physical Android gesture.
"""

import argparse
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright
from test_browser import QuietHandler, open_panel, wait_for_map


BRIDGE = """(() => {
    window.sceneRequests=[];window.sceneCancellations=[];window.acceptedScenes=[];
    window.frameRequests=[];
    window.AndroidHost={haptic(){},listCityPacks(){},cancelShadowFrame(){},
        requestScene:text=>sceneRequests.push(JSON.parse(text)),
        cancelScene:id=>sceneCancellations.push(id),
        acceptScene:id=>acceptedScenes.push(id),
        requestShadowFrame:(scene,index,id)=>frameRequests.push({scene,index,id}),
    };
})()"""


def camera(page):
    return page.evaluate("({center:map.getCenter().toArray(),zoom:map.getZoom(),pitch:map.getPitch(),bearing:map.getBearing()})")


def make_bundle(request, scene_id):
    west, south = request["displayBounds"][0]
    east, north = request["displayBounds"][1]
    longitude, latitude = (west + east) / 2, (south + north) / 2
    dx, dy = (east - west) / 30, (north - south) / 30
    polygon = {"type": "Polygon", "coordinates": [[[longitude, latitude],
        [longitude + dx, latitude], [longitude + dx, latitude + dy],
        [longitude, latitude + dy], [longitude, latitude]]]}
    return {"schemaVersion": 1, "sceneId": scene_id, "source": "city-pack:fixture",
        "region": {"name": "Область карты", "center": [longitude, latitude], "bounds": request["displayBounds"]},
        "buildings": {"type": "FeatureCollection", "features": [{"type": "Feature",
            "properties": {"height": 12, "min_height": 0}, "geometry": polygon}]},
        "layers": {"shadows": {"initialFrameIndex": 0, "frames": [{
            "time": request["localDate"] + "T12:00:00+03:00", "label": "12:00",
            "altitude": 30, "azimuth": 30, "shadow_bearing": 210,
            "computed": True, "geometry": polygon}]}}}


def reply(page, request, scene_id, url="/generated/viewport-fixture.json"):
    bundle = make_bundle(request, scene_id)
    page.route("**" + url, lambda route: route.fulfill(json=bundle))
    page.evaluate("args=>SloiApp.onSceneReady(args.id,args.url)", {"id": request["requestId"], "url": url})
    page.wait_for_function("id=>activeSceneId===id && !pendingScene", arg=scene_id)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--chromium")
    args = parser.parse_args()
    assets = Path(__file__).resolve().parents[1] / "app/src/main/assets"
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(assets)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_port}"
    errors = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=args.chromium,
                args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
            context = browser.new_context(viewport={"width": 390, "height": 844})
            context.route("**/*", lambda route: route.continue_() if route.request.url.startswith(origin) else route.abort())
            context.add_init_script(BRIDGE)
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(origin)
            wait_for_map(page)
            page.wait_for_function("moduleHost && libraryLoaded")
            page.evaluate("selectPlace(59.9,30.32,'Моё выбранное место')")
            page.wait_for_function("!map.isMoving()")
            page.wait_for_timeout(750)  # Exceed the automatic viewport debounce.
            assert page.evaluate("sceneRequests.length") == 0
            assert not page.evaluate("moduleHost.get('shadows').enabled")
            assert page.locator("#scene-date-form").is_hidden()
            assert page.locator("#load-center").is_hidden()

            pin = page.evaluate("JSON.stringify(selectedPlace)")
            before = camera(page)
            open_panel(page)
            extension = page.locator('[data-module="shadows"]')
            extension.locator(".module-heading .switch").click()
            page.wait_for_function("sceneRequests.length===1")
            first = page.evaluate("sceneRequests[0]")
            assert not {"radiusM", "latitude", "longitude"}.intersection(first)
            visible = page.evaluate("viewportBounds()")
            assert first["displayBounds"][0][0] <= visible["west"] + 1e-8
            assert first["displayBounds"][0][1] <= visible["south"] + 1e-8
            assert first["displayBounds"][1][0] >= visible["east"] - 1e-8
            assert first["displayBounds"][1][1] >= visible["north"] - 1e-8
            assert first["localDate"] == page.evaluate("localDateString()")
            reply(page, first, "s-1111111111111111")
            assert camera(page) == before
            assert page.evaluate("JSON.stringify(selectedPlace)") == pin
            assert page.locator("#panel-layers").is_visible()
            assert page.evaluate("map.getSource('shadows')._data.features.length") == 1
            assert page.locator("#time-card").is_hidden(), "Production shadows must not reopen demo time controls"

            # Panning keeps ready geometry until its replacement arrives. The
            # background result cannot close search, clear suggestions or move pin.
            open_panel(page, "search")
            page.evaluate("""() => {
                elements.placeQuery.value='Невский';
                renderPlaces([{lat:59.91,lon:30.35,display_name:'Сохранённый вариант'}]);
                window.oldShadows=JSON.stringify(map.getSource('shadows')._data);
                map.easeTo({center:[30.34,59.9],duration:350});
            }""")
            assert page.evaluate("JSON.stringify(map.getSource('shadows')._data)===oldShadows")
            page.wait_for_function("!map.isMoving() && sceneRequests.length===2")
            assert page.evaluate("JSON.stringify(map.getSource('shadows')._data)===oldShadows")
            second = page.evaluate("sceneRequests[1]")
            assert second["displayBounds"] != first["displayBounds"]
            second_camera = camera(page)
            reply(page, second, "s-2222222222222222", "/generated/viewport-second.json")
            assert camera(page) == second_camera
            assert page.evaluate("JSON.stringify(selectedPlace)") == pin
            assert page.locator("#panel-search").is_visible()
            assert page.locator("#place-query").input_value() == "Невский"
            assert page.get_by_role("button", name="Сохранённый вариант", exact=True).is_visible()

            # Disabling is a real lifecycle stop, including an in-flight native job.
            page.evaluate("map.jumpTo({center:[30.36,59.9]})")
            page.wait_for_function("sceneRequests.length===3")
            old_request = page.evaluate("sceneRequests[2]")
            open_panel(page)
            extension.locator(".module-heading .switch").click()
            page.wait_for_function("!shadowExtensionActive && !pendingScene")
            assert old_request["requestId"] in page.evaluate("sceneCancellations")
            assert page.evaluate("map.getSource('shadows')._data.features.length") == 0
            page.evaluate("map.jumpTo({center:[30.38,59.9]})")
            page.wait_for_timeout(750)
            assert page.evaluate("sceneRequests.length") == 3
            # A late successful reply from the stopped extension is ignored.
            page.evaluate("id=>SloiApp.onSceneError(id,'поздняя ошибка')", old_request["requestId"])
            assert page.evaluate("map.getSource('shadows')._data.features.length") == 0
            assert not errors, errors
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print("Shadow viewport OK: opt-in lifecycle, full visible bounds, background continuity, camera/pin/search preservation, cancellation")


if __name__ == "__main__":
    main()
