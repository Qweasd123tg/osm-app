"""Trusted map input keeps control over late asynchronous navigation.

Runs the real UI and MapLibre with controlled geolocation/module replies.
It does not exercise a physical Android device or external services.
"""

import argparse
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright
from test_browser import QuietHandler, open_panel, wait_for_map
from test_map_gestures_browser import camera, gesture


LOCATION_STUB = """(() => {
    window.locationCallbacks=[];
    Object.defineProperty(navigator,'geolocation',{value:{
        getCurrentPosition(success,error){locationCallbacks.push({success,error})}
    }});
})()"""


def assert_camera_equal(expected, actual):
    for key in ["zoom", "pitch", "bearing"]:
        assert abs(expected[key] - actual[key]) < 1e-7, (expected, actual)
    assert all(abs(a - b) < 1e-7 for a, b in zip(expected["center"], actual["center"])), (expected, actual)


def trusted_pan(page, cdp):
    # Modal scrims stay visible during their short closing transition. Start
    # the gesture only once its actual hit target is the interactive map.
    page.wait_for_function("!!document.elementFromPoint(145,390)?.closest('#map') && !document.getElementById('map').inert")
    before = camera(page)
    gesture(page, cdp, [(145, 390)], [(245, 425)])
    after = camera(page)
    assert any(abs(a - b) > 1e-5 for a, b in zip(before["center"], after["center"])), (before, after)
    return after


def deliver_location(page, index, latitude=59.8521, longitude=30.3229):
    page.evaluate("""value => locationCallbacks[value.index].success({coords:{
        latitude:value.latitude,longitude:value.longitude,accuracy:12
    }})""", {"index": index, "latitude": latitude, "longitude": longitude})
    page.wait_for_function("!map.isMoving()")


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
            context = browser.new_context(viewport={"width": 390, "height": 844},
                is_mobile=True, has_touch=True)
            context.add_init_script(LOCATION_STUB)
            delayed_demo = []

            def route_request(route):
                url = route.request.url
                if url == origin + "/map-data.js":
                    delayed_demo.append(route)
                elif url.startswith(origin):
                    route.continue_()
                else:
                    route.abort()

            context.route("**/*", route_request)
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(origin)
            wait_for_map(page)
            page.wait_for_function("moduleHost && libraryLoaded")
            page.evaluate("""() => {
                map.jumpTo({center:[30.32,59.9],zoom:15,pitch:23,bearing:17});
                window.trustedMapStarts=0;
                map.getCanvasContainer().addEventListener('touchstart',event=>{
                    if(event.isTrusted)trustedMapStarts++;
                },true);
            }""")
            cdp = context.new_cdp_session(page)

            # A delayed fix must not reclaim the map after a real user's pan.
            page.evaluate("void locateOnMap()")
            page.wait_for_function("locationCallbacks.length===1")
            assert page.locator("#place-status").inner_text() == "Определяю местоположение…"
            pin = page.evaluate("selectedPlace")
            dragged = trusted_pan(page, cdp)
            assert page.locator("#place-status").inner_text() == ""
            deliver_location(page, 0)
            assert_camera_equal(dragged, camera(page))
            assert page.evaluate("selectedPlace") == pin
            assert page.locator("#locate").is_enabled()
            assert page.locator("#place-status").inner_text() == ""

            # Cancelling GPS must leave an unrelated search error intact.
            page.evaluate("elements.locate.setAttribute('aria-busy','true');setPlaceStatus('Ошибка поиска',true);invalidateLocation()")
            assert page.locator("#place-status").inner_text() == "Ошибка поиска"
            assert page.locator("#place-status").evaluate("node=>node.classList.contains('is-error')")

            # A new explicit location request still navigates when the user waits.
            page.evaluate("void locateOnMap()")
            page.wait_for_function("locationCallbacks.length===2")
            deliver_location(page, 1, 59.91, 30.35)
            center = camera(page)["center"]
            assert abs(center[0] - 30.35) < 1e-6 and abs(center[1] - 59.91) < 1e-6, center
            assert page.evaluate("selectedPlace.name") == "Рядом со мной"

            # Programmatic camera work must not count as a user's cancellation.
            page.evaluate("void locateOnMap();map.zoomTo(14,{duration:120})")
            page.wait_for_function("locationCallbacks.length===3 && !map.isMoving()")
            deliver_location(page, 2, 59.92, 30.36)
            center = camera(page)["center"]
            assert abs(center[0] - 30.36) < 1e-6 and abs(center[1] - 59.92) < 1e-6, center

            # Lazy demo data is another asynchronous camera owner. The old
            # Moskovskaya example must not pull the map back after manual input.
            pin = page.evaluate("JSON.stringify(selectedPlace)")
            page.evaluate("window.demoFinished=false;void loadDemoScene().then(value=>{window.demoResult=value;demoFinished=true})")
            page.wait_for_function("!!document.querySelector('script[src=\"map-data.js\"]')")
            page.wait_for_timeout(50)
            assert len(delayed_demo) == 1
            dragged = trusted_pan(page, cdp)
            delayed_demo.pop().fulfill(body=(assets / "map-data.js").read_text(), content_type="application/javascript")
            page.wait_for_function("demoFinished && !map.isMoving()")
            assert page.evaluate("demoResult") is False
            assert_camera_equal(dragged, camera(page))
            assert page.evaluate("JSON.stringify(selectedPlace)") == pin

            # A route lookup selected earlier may finish after the search panel
            # is closed and the user starts exploring a different neighbourhood.
            open_panel(page, "search")
            page.evaluate("""() => {
                window.savedModuleConfigure=moduleHost.configure.bind(moduleHost);
                window.savedModuleGet=moduleHost.get.bind(moduleHost);
                moduleHost.configure=(id,settings)=>new Promise(resolve=>{
                    window.resolveTransport=()=>resolve({enabled:true,status:'ready'});
                });
                moduleHost.get=id=>id==='spb-bus'
                    ? {...savedModuleGet(id),bounds:[[30.30,59.84],[30.34,59.86]]}
                    : savedModuleGet(id);
                renderSearchResults({query:'26',places:[],transport:[{
                    id:'camera-test-26',title:'Автобус 26',moduleId:'spb-bus',
                    settings:{route:'26',direction:1}
                }]});
            }""")
            page.get_by_role("button", name="Автобус 26", exact=True).click()
            page.wait_for_function("typeof resolveTransport==='function'")
            page.locator("#close-sheet").click()
            dragged = trusted_pan(page, cdp)
            page.evaluate("resolveTransport()")
            page.wait_for_timeout(550)  # Exceed the stale fitBounds animation duration.
            page.wait_for_function("!map.isMoving()")
            assert_camera_equal(dragged, camera(page))
            assert page.evaluate("JSON.stringify(selectedPlace)") == pin
            page.evaluate("() => {moduleHost.configure=savedModuleConfigure;moduleHost.get=savedModuleGet}")
            assert page.evaluate("trustedMapStarts") >= 3
            assert not errors, errors
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print("Camera ownership OK: trusted pan suppresses late location/demo/transport navigation; fresh and programmatic location flows remain valid")


if __name__ == "__main__":
    main()
