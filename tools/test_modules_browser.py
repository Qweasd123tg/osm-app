"""Module lifecycle, mocked transport, adaptive camera and bounded shadow work."""

import argparse
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
import threading
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright
from test_browser import QuietHandler, open_examples, open_panel, wait_for_map


GRID_SOURCE = "module-coordinate-grid:grid-source"
GRID_LINE = "module-coordinate-grid:grid-line"
BUS_SOURCE = "module-spb-bus:route-source"
BUS_LINE = "module-spb-bus:route-line"
TRANSPORT = "https://transport.orgp.spb.ru"


def wait_for_module(page, module_id, status="ready"):
    page.wait_for_function("args => moduleHost && moduleHost.get(args.id).status === args.status",
        arg={"id": module_id, "status": status})


def assert_clean_module(page, module_id):
    assert page.evaluate("id => !map.getStyle().layers.some(layer => layer.id.startsWith('module-'+id+':'))", module_id)
    assert page.evaluate("id => !Object.keys(map.getStyle().sources).some(source => source.startsWith('module-'+id+':'))", module_id)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--chromium")
    args = parser.parse_args()
    assets = Path(__file__).resolve().parents[1] / "app/src/main/assets"
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(assets)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_port}"
    transport_requests = []
    errors = []
    route_payload = {"Directions": [
        {"Direction": 1, "Items": [{"Order": 1, "Shape": "30.32 59.85,30.33 59.86",
            "StartStopId": 11, "StartStopName": "Первая", "StartStopLongitude": 30.32, "StartStopLatitude": 59.85,
            "FinishStopId": 12, "FinishStopName": "Вторая", "FinishStopLongitude": 30.33, "FinishStopLatitude": 59.86}]},
        {"Direction": 2, "Items": [{"Order": 1, "Shape": "30.34 59.87,30.33 59.86",
            "StartStopId": 12, "StartStopName": "Вторая", "StartStopLongitude": 30.34, "StartStopLatitude": 59.87,
            "FinishStopId": 11, "FinishStopName": "Первая", "FinishStopLongitude": 30.33, "FinishStopLatitude": 59.86}]},
    ]}

    def network(route):
        request = route.request
        if request.url.startswith(origin):
            route.continue_()
        elif request.url.startswith(TRANSPORT + "/"):
            transport_requests.append({"url": request.url, "method": request.method, "body": request.post_data})
            headers = {"access-control-allow-origin": origin}
            if urlparse(request.url).path == "/api/visary/operator/route":
                route.fulfill(json=[{"Id": 77, "ShortName": "3"}], headers=headers)
            elif urlparse(request.url).path == "/api/visary/stop/byRoute":
                route.fulfill(json=route_payload, headers=headers)
            else:
                route.abort()
        else:
            route.abort()

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=args.chromium,
                args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
            context = browser.new_context(viewport={"width": 390, "height": 844}, color_scheme="dark")
            context.route("**/*", network)
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(origin)
            wait_for_map(page)
            page.wait_for_function("moduleHost && moduleHost.list().length === 2")

            # Tabs expose one task at a time, and the modal owns keyboard input.
            open_panel(page)
            assert page.locator(".bottom-nav").evaluate("node => node.inert")
            open_panel(page, "search")
            assert page.locator("#place-form").is_visible()
            assert page.locator("#module-list").is_hidden()
            open_panel(page, "offline")
            assert page.locator("#city-pack-list").is_visible()
            assert page.locator("#place-form").is_hidden()
            open_panel(page, "settings")
            assert page.locator("#economy-mode").is_visible()
            assert page.evaluate("document.documentElement.dataset.theme") == "dark"
            page.locator('#theme-options button[data-theme="light"]').click()
            assert page.evaluate("document.documentElement.dataset.theme") == "light"
            page.emulate_media(color_scheme="dark")
            assert page.evaluate("document.documentElement.dataset.theme") == "light"
            page.locator('#theme-options button[data-theme="system"]').click()
            assert page.evaluate("document.documentElement.dataset.theme") == "dark"
            page.locator('#theme-options button[data-theme="dark"]').click()

            # Extensions start disabled and do not create resources until requested.
            assert page.evaluate("moduleHost.list().every(module=>!module.enabled)")
            assert page.locator('[data-layer="sun"]').is_hidden()
            assert page.locator('[data-layer="wind"]').is_hidden()
            assert page.locator('[data-layer="shadows"]').is_hidden()
            assert page.locator('#scene-date-form').is_hidden()
            assert page.locator('[data-module="coordinate-grid"]').count() == 0

            # Transport consumes the provider's bare list and nested Shape geometry.
            open_panel(page)
            bus = page.locator('[data-module="spb-bus"]')
            bus.locator(".module-heading .switch").click()
            wait_for_module(page, "spb-bus")
            assert len(transport_requests) == 2, transport_requests
            assert transport_requests[0]["method"] == "POST"
            assert parse_qs(transport_requests[0]["body"])["routeShortName"] == ["3"]
            assert transport_requests[1]["method"] == "GET"
            assert parse_qs(urlparse(transport_requests[1]["url"]).query)["routeId"] == ["77"]
            assert page.evaluate("id => map.getSource(id)._data.features.filter(f=>f.geometry.type==='Point').length", BUS_SOURCE) == 2
            assert page.evaluate("id => map.getSource(id)._data.features.filter(f=>f.geometry.type==='LineString').length", BUS_SOURCE) == 1
            assert bus.locator("form").count() == 0
            open_panel(page, "module-settings")
            settings = page.locator('[data-module-settings="spb-bus"]')
            settings.get_by_label("Автобусы Петербурга: Направление").select_option("2")
            settings.get_by_label("Автобусы Петербурга: Показывать остановки").uncheck()
            assert settings.get_by_label("Автобусы Петербурга: Цвет маршрута").count() == 0
            settings.locator("form button").click()
            wait_for_module(page, "spb-bus")
            # Rendering options remain available to module configuration without
            # filling the everyday interface with styling controls.
            page.evaluate("moduleHost.configure('spb-bus',{color:'#1234ab'})")
            wait_for_module(page, "spb-bus")
            assert page.evaluate("id => map.getSource(id)._data.features.length", BUS_SOURCE) == 1
            assert page.evaluate("id => map.getSource(id)._data.features[0].geometry.coordinates[0]", BUS_SOURCE) == [30.34, 59.87]
            assert page.evaluate("id => map.getPaintProperty(id,'line-color')", BUS_LINE) == "#1234ab"
            settings.get_by_role("button", name="Показать модуль Автобусы Петербурга на карте").click()
            page.wait_for_function("!map.isMoving()")
            assert page.evaluate("map.getBounds().contains([30.34,59.87]) && map.getBounds().contains([30.33,59.86])")
            assert page.locator("#layers-sheet").evaluate("node => node.inert")
            open_panel(page)

            # Built-in stack updates keep module geometry above building overlays.
            page.evaluate("state.layerOrder=['sun','wind','buildings','shadows'];applyMapState()")
            assert page.evaluate("id => {const ids=map.getStyle().layers.map(l=>l.id);return ids.indexOf(id)>ids.indexOf('buildings-3d') && ids.indexOf(id)>ids.indexOf('buildings-flat')}", BUS_LINE)
            bus.locator(".module-heading .switch").click()
            wait_for_module(page, "spb-bus", "disabled")
            assert_clean_module(page, "spb-bus")
            page.locator("#close-sheet").click()

            # Zoom simplifies geometry without changing the user's camera angle.
            open_panel(page, "settings")
            page.locator("#mode-3d").click()
            page.locator("#settings-back").click()
            page.evaluate("map.jumpTo({center:[30.32,59.9],zoom:15})")
            page.wait_for_function("!map.isMoving()")
            assert page.evaluate("map.getPitch()") > 0
            page.evaluate("map.jumpTo({pitch:45})")
            assert abs(page.evaluate("map.getPitch()") - 45) < .01
            page.evaluate("map.zoomTo(12,{duration:120})")
            page.wait_for_function("!map.isMoving()")
            assert abs(page.evaluate("map.getPitch()") - 45) < .01
            assert page.evaluate("state.mode") == "3d"
            page.evaluate("map.zoomTo(15,{duration:120})")
            page.wait_for_function("!map.isMoving()")
            assert abs(page.evaluate("map.getPitch()") - 45) < .01
            open_panel(page, "settings")
            page.locator("#mode-2d").click()
            page.locator("#settings-back").click()
            page.wait_for_function("!map.isMoving()")
            page.evaluate("map.jumpTo({zoom:12});map.jumpTo({zoom:15})")
            assert page.evaluate("map.getPitch()") == 0, page.evaluate("({pitch:map.getPitch(),intent:pitchController.intent,mode:state.mode})")
            assert page.evaluate("state.mode") == "2d"
            assert page.locator(".map-scale").evaluate("node => getComputedStyle(node,'::after').width") == "100px"
            ground_distance = page.evaluate("""() => {
                const width=map.getCanvas().clientWidth, height=map.getCanvas().clientHeight;
                return map.unproject([width/2,height/2]).distanceTo(map.unproject([width/2+100,height/2]));
            }""")
            scale_label = page.locator("#map-scale-label").inner_text()
            label_distance = float(scale_label.split()[0].replace(",", ".")) * (1000 if "км" in scale_label else 1)
            assert abs(label_distance - ground_distance) / ground_distance < .02

            # Native frames stay lazy; old geometry is evicted from the working set.
            page.evaluate("""() => {
                window.frameRequests=[];window.frameCancellations=0;state.shadows=true;
                window.AndroidHost={requestScene(){},acceptScene(){},haptic(){},
                    requestShadowFrame:(scene,index,id)=>frameRequests.push({scene,index,id}),
                    cancelShadowFrame:()=>frameCancellations++,cancelScene(){}};
            }""")
            polygon = {"type": "Polygon", "coordinates": [[[30.32, 59.85], [30.321, 59.85],
                [30.321, 59.851], [30.32, 59.851], [30.32, 59.85]]]}
            bundle = {"schemaVersion": 1, "sceneId": "s-bbbbbbbbbbbbbbbb", "source": "device",
                "region": {"center": [30.32, 59.85], "bounds": [[30.318, 59.848], [30.324, 59.854]], "name": "Тест кадров"},
                "buildings": {"type": "FeatureCollection", "features": [{"type": "Feature",
                    "properties": {"height": 12, "min_height": 0}, "geometry": polygon}]},
                "layers": {"shadows": {"initialFrameIndex": 0, "frames": [{
                    "label": f"{index+9:02d}:00", "time": f"2026-07-17T{index+9:02d}:00:00+03:00",
                    "altitude": 30, "shadow_bearing": 210, "geometry": polygon if index == 0 else None,
                    "computed": index == 0} for index in range(8)]}}}
            page.route("**/generated/perf-frame.json", lambda route: route.fulfill(json={"frame": {"geometry": polygon}}))
            page.evaluate("map.jumpTo({center:[30.32,59.85],zoom:15})")
            page.evaluate("void loadViewportScene('Тест кадров').catch(()=>{})")
            bundle["region"]["bounds"] = page.evaluate("pendingScene.displayBounds")
            page.route("**/generated/perf-scene.json", lambda route: route.fulfill(json=bundle))
            request_id = page.evaluate("pendingScene.requestId")
            page.evaluate("id => SloiApp.onSceneReady(id,'/generated/perf-scene.json')", request_id)
            page.wait_for_function("!map.isMoving()")
            for index in range(1, 6):
                page.evaluate("index => showFrame(index)", index)
                page.wait_for_function("index => frameRequests.at(-1)?.index===index", arg=index)
                request = page.evaluate("frameRequests.at(-1)")
                page.evaluate("r => SloiApp.onFrameReady(r.scene,r.index,r.id,'/generated/perf-frame.json')", request)
                assert page.evaluate("frames.filter(frame=>frame.geometry!==null).length") <= 3
                assert page.evaluate("[...retainedFrames.values()].reduce((sum,size)=>sum+size,0)") <= 4 * 1024 * 1024
            assert page.evaluate("frames[1].geometry===null && frames[1].computed===false")
            page.evaluate("map.jumpTo({zoom:12})")
            page.evaluate("showFrame(6)")
            page.wait_for_function("frameRequests.at(-1)?.index===6")
            request = page.evaluate("frameRequests.at(-1)")
            page.evaluate("r => SloiApp.onFrameReady(r.scene,r.index,r.id,'/generated/perf-frame.json')", request)
            assert page.evaluate("map.getSource('shadows')._data.features.length") == 1
            frame_count = page.evaluate("frameRequests.length")
            page.evaluate("map.jumpTo({zoom:15})")
            page.wait_for_timeout(300)
            assert page.evaluate("frameRequests.length") == frame_count, "Zoom must reuse the computed frame"
            frame_count = page.evaluate("frameRequests.length")
            cancel_count = page.evaluate("frameCancellations")
            page.evaluate("startPlayback();map.easeTo({center:[30.3205,59.8505],duration:1200});showFrame(7)")
            assert page.evaluate("playbackTimer") is None
            page.wait_for_timeout(220)
            assert page.evaluate("frameRequests.length") == frame_count
            assert page.evaluate("frameCancellations") > cancel_count
            page.wait_for_function("!map.isMoving() && frameRequests.at(-1)?.index===7")
            request = page.evaluate("frameRequests.at(-1)")
            page.evaluate("r => SloiApp.onFrameReady(r.scene,r.index,r.id,'/generated/perf-frame.json')", request)
            page.evaluate("map.jumpTo({center:[-73.98,40.75],zoom:15});showFrame(1)")
            frame_count = page.evaluate("frameRequests.length")
            page.wait_for_timeout(300)
            assert page.evaluate("frameRequests.length") == frame_count
            assert page.evaluate("map.getSource('shadows')._data.features.length") == 1
            page.evaluate("showFrame(7);map.jumpTo({center:[30.3205,59.8505],zoom:15})")
            page.wait_for_timeout(300)
            assert page.evaluate("frameRequests.length") == frame_count
            assert page.evaluate("map.getSource('shadows')._data.features.length") == 1
            assert page.evaluate("map.getLayoutProperty('ground-shadows','visibility')") != "none"

            # TLS/network failure belongs to the module and leaves the map usable.
            failed_context = browser.new_context(viewport={"width": 390, "height": 844})
            failed_context.route("**/*", lambda route: route.continue_() if route.request.url.startswith(origin) else route.abort())
            failed = failed_context.new_page()
            failed.on("pageerror", lambda error: errors.append(str(error)))
            failed.goto(origin)
            wait_for_map(failed)
            open_panel(failed)
            failed.locator('[data-module="spb-bus"] .module-heading .switch').click()
            wait_for_module(failed, "spb-bus", "error")
            assert "сертификат" in failed.locator('[data-module="spb-bus"] .module-status').inner_text()
            assert failed.locator('[data-module="spb-bus"]').get_by_role("button", name="Повторить").is_visible()
            assert_clean_module(failed, "spb-bus")
            assert failed.evaluate("mapReady && !document.getElementById('fatal').classList.contains('is-visible')")
            assert not errors, errors
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print("Modules OK: settings, optional extensions, resource cleanup, mocked transport, failure isolation, adaptive 3D, bounded shadow work")


if __name__ == "__main__":
    main()
