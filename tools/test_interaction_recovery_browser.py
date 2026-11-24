"""Regressions for cancelled work, visible errors, drafts and stable progress UI."""

import argparse
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright
from test_browser import QuietHandler, open_examples, open_panel, reveal_control, wait_for_map


BRIDGE = """(() => {
    window.geoRequests=[];window.searchRequests=[];window.sceneRequests=[];
    window.sceneCancellations=[];window.cityDownloads=[];window.cityCancellations=[];
    window.AndroidHost={
        haptic(){},listCityPacks(){},cancelShadowFrame(){},
        searchPlaces:text=>searchRequests.push(JSON.parse(text)),
        requestScene:text=>sceneRequests.push(JSON.parse(text)),
        cancelScene:id=>sceneCancellations.push(id),
        downloadCityPack:id=>cityDownloads.push(id),
        cancelCityPack:id=>cityCancellations.push(id),
    };
    Object.defineProperty(navigator,'geolocation',{configurable:true,value:{
        getCurrentPosition(success,failure){geoRequests.push({success,failure})},
    }});
})()"""


def settle_location(page, index, success=True, latitude=48.8566, longitude=2.3522):
    page.evaluate("""async args => {
        const request=geoRequests[args.index];
        if(args.success) request.success({coords:{latitude:args.latitude,longitude:args.longitude}});
        else request.failure({code:1,message:'permission denied'});
        await Promise.resolve();await Promise.resolve();
    }""", {"index": index, "success": success, "latitude": latitude, "longitude": longitude})


def assert_search_ready(page):
    for selector in ["#place-submit", "#my-location", "#locate"]:
        assert page.locator(selector).is_enabled(), selector
    assert page.locator("#cancel-scene").is_hidden()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--chromium")
    args = parser.parse_args()
    assets = Path(__file__).resolve().parents[1] / "app/src/main/assets"
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(assets)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_port}"
    errors = []
    demo_requests = []

    def network(route):
        if route.request.url.endswith("/map-data.js"):
            demo_requests.append(route.request.url)
            route.abort()
        elif route.request.url.startswith(origin):
            route.continue_()
        else:
            route.abort()

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=args.chromium,
                args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
            context = browser.new_context(viewport={"width": 390, "height": 844})
            context.route("**/*", network)
            context.add_init_script(BRIDGE)
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(origin)
            wait_for_map(page)
            page.wait_for_function("libraryLoaded && moduleHost")

            # The cancel control works for location lookup as well as scene loading.
            open_panel(page, "search")
            for index, late_success in enumerate([True, False]):
                camera = page.evaluate("({center:map.getCenter().toArray(),zoom:map.getZoom(),pitch:map.getPitch()})")
                page.locator("#my-location").click()
                assert page.evaluate("geoRequests.length") == index + 1
                assert page.locator("#my-location").is_disabled()
                assert page.locator("#cancel-scene").is_visible()
                page.locator("#cancel-scene").click()
                assert_search_ready(page)
                cancelled_status = page.locator("#place-status").inner_text()
                assert "отмен" in cancelled_status.lower()
                settle_location(page, index, success=late_success)
                page.wait_for_function("!map.isMoving()")
                assert page.evaluate("({center:map.getCenter().toArray(),zoom:map.getZoom(),pitch:map.getPitch()})") == camera
                assert page.locator("#place-status").inner_text() == cancelled_status
                assert not page.locator("#place-status").evaluate("node=>node.classList.contains('is-error')")
                assert_search_ready(page)
            assert page.evaluate("sceneRequests.length") == 0
            assert page.evaluate("sceneCancellations.length") == 0

            # Removed developer examples stay hidden; a failed fixture load is isolated.
            open_panel(page, "settings")
            assert page.locator("#demo-scenes").is_hidden()
            page.evaluate("loadDemoScene()")
            page.wait_for_function("document.getElementById('demo-status').classList.contains('is-error')")
            assert page.locator("#load-demo").is_enabled()
            assert page.locator("#demo-status").is_hidden()
            assert "Пример недоступен" in page.locator("#demo-status").text_content()
            assert page.locator("#panel-settings").is_visible()
            assert page.locator("#panel-search").is_hidden()
            assert len(demo_requests) == 1
            assert page.evaluate("mapReady && data===null && fallbackData===null")
            assert not page.locator("#fatal").evaluate("node=>node.classList.contains('is-visible')")

            # Uncommitted fields survive notifications from a different module.
            open_panel(page, "module-settings")
            bus = page.locator('[data-module-settings="spb-bus"]')
            bus_route = bus.get_by_label("Автобусы Петербурга: Номер автобуса")
            bus_direction = bus.get_by_label("Автобусы Петербурга: Направление")
            bus_stops = bus.get_by_label("Автобусы Петербурга: Показывать остановки")
            bus_route.fill("22")
            bus_direction.select_option("2")
            bus_stops.uncheck()
            assert page.evaluate("moduleHost.get('spb-bus').settings.route") == "3"
            # An unrelated extension's settings notification must not replace drafts.
            page.evaluate("moduleHost.configure('shadows',{opacity:40})")
            assert bus_route.input_value() == "22"
            assert bus_direction.input_value() == "2"
            assert not bus_stops.is_checked()
            page.evaluate("""() => {
                Object.defineProperty(document,'hidden',{configurable:true,value:true});
                document.dispatchEvent(new Event('visibilitychange'));
            }""")
            page.evaluate("""() => {
                delete document.hidden;
                document.dispatchEvent(new Event('visibilitychange'));
            }""")
            assert bus_route.input_value() == "22"
            assert bus_direction.input_value() == "2"
            assert not bus_stops.is_checked()
            open_panel(page, "module-settings")
            bus.locator("form button").click()
            page.wait_for_function("moduleHost.get('spb-bus').settings.route==='22'")
            assert page.evaluate("moduleHost.get('spb-bus').settings.direction") == 2
            assert page.evaluate("moduleHost.get('spb-bus').settings.stops") is False
            assert page.evaluate("moduleHost.get('spb-bus').enabled") is False

            # Selecting a place and geolocation remain independent of extensions.
            open_panel(page, "search")
            page.locator("#place-query").fill("Берлин")
            page.locator("#place-submit").click()
            page.wait_for_function("searchRequests.length > 0")
            search_id = page.evaluate("searchRequests.at(-1).requestId")
            page.evaluate("id=>SloiApp.onPlacesReady(id,[{lat:52.52,lon:13.405,display_name:'Берлин · тест'}])", search_id)
            page.get_by_role("button", name="Берлин · тест", exact=True).click()
            page.wait_for_function("!map.isMoving()")
            open_panel(page, "search")

            # Repeated or delayed results from the old search no longer own this view.
            selected_status = page.locator("#place-status").inner_text()
            page.evaluate("id=>SloiApp.onPlacesReady(id,[{lat:35.68,lon:139.76,display_name:'Устаревшее место'}])", search_id)
            page.evaluate("id=>SloiApp.onPlacesError(id,'поздняя ошибка старого поиска')", search_id)
            assert page.locator("#place-results button").count() == 0
            assert page.locator("#place-status").inner_text() == selected_status
            assert page.locator("#region-name").inner_text() == "Берлин · тест"

            page.locator("#my-location").click()
            location_index = page.evaluate("geoRequests.length-1")
            settle_location(page, location_index)
            page.wait_for_function("!map.isMoving()")
            open_panel(page, "search")
            assert page.evaluate("sceneRequests.length") == 0
            assert page.locator("#scene-date-form").is_hidden()

            # Progress updates retain the actual cancel control and keyboard focus.
            page.evaluate("""SloiApp.onCityPacks({packs:[{id:'fixture-city',name:'Город для проверки',
                status:'available',downloadBytes:1024,expectedInstalledBytes:4096}]})""")
            open_panel(page, "offline")
            city = page.locator("#city-pack-list .city-pack").filter(has_text="Город для проверки")
            city.get_by_role("button", name="Скачать", exact=True).click()
            assert page.evaluate("cityDownloads") == ["fixture-city"]
            cancel = city.get_by_role("button", name="Отмена", exact=True)
            cancel.focus()
            cancel.evaluate("node=>{window.progressCancelControl=node}")
            for current in [256, 768]:
                page.evaluate("current=>SloiApp.onCityPackProgress('fixture-city','download',current,1024)", current)
                assert cancel.evaluate("node=>node===window.progressCancelControl")
                assert page.evaluate("document.activeElement===window.progressCancelControl")
                assert city.locator("progress").evaluate("node=>[node.value,node.max]") == [current, 1024]
                assert cancel.is_enabled()
            cancel.click()
            assert page.evaluate("cityCancellations") == ["fixture-city"]
            assert not errors, errors
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print("Interaction recovery OK: cancelled geolocation, visible demo error, module drafts, independent geolocation, stale search, stable city progress controls")


if __name__ == "__main__":
    main()
