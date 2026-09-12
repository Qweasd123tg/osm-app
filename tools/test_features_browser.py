"""End-to-end local layers, solar date, request recovery and rendering-budget checks."""
import argparse
from functools import partial
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright
from test_browser import QuietHandler, wait_for_map


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
            context = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=3)
            context.route("**/*", lambda route: route.continue_() if route.request.url.startswith(origin) else route.abort())
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(origin)
            wait_for_map(page)
            page.wait_for_function("libraryLoaded")
            assert page.evaluate("map.getPixelRatio()") == 1.5
            assert page.locator("#scene-date-label").inner_text() == "17.07.2026 · UTC+03:00"
            page.locator("#layers-button").click()
            page.locator("#economy-mode").check()
            assert page.evaluate("map.getPixelRatio()") == 1
            assert page.evaluate("viewportBudget().tiles") == 32

            page.locator("#sun-toggle").check(force=True)
            page.evaluate("showFrame(30)")
            assert page.evaluate("map.getSource('sun-direction')._data.features.length") == 2
            page.evaluate("showFrame(0)")
            assert page.evaluate("map.getSource('sun-direction')._data.features.length") == 0

            data = {"type": "FeatureCollection", "features": [
                {"type": "Feature", "properties": {"name": "Точка <тест>", "note": "Локально"},
                 "geometry": {"type": "Point", "coordinates": [30.32, 59.85]}},
                {"type": "Feature", "properties": {"name": "Маршрут"},
                 "geometry": {"type": "LineString", "coordinates": [[30.32, 59.85], [30.33, 59.86]]}},
            ]}
            page.locator("#layer-file").set_input_files({"name": "Прогулка.geojson", "mimeType": "application/json", "buffer": json.dumps(data).encode()})
            page.wait_for_function("customLayers.size === 1 && !importBusy")
            layer_id = page.evaluate("[...customLayers.keys()][0]")
            assert page.evaluate("id => !!map.getSource(id+'-source')", layer_id)
            card = page.locator(f'[data-layer="{layer_id}"]')
            card.locator("input[type=color]").evaluate("node => {node.value='#227755'; node.dispatchEvent(new Event('change'))}")
            page.wait_for_function("id => customLayers.get(id).color === '#227755'", arg=layer_id)
            card.locator("input[type=checkbox]").uncheck(force=True)
            assert not page.evaluate("id => !!map.getSource(id+'-source')", layer_id)
            card.locator("input[type=checkbox]").check(force=True)
            assert page.evaluate("id => map.getPaintProperty(id+'-line','line-color')", layer_id) == "#227755"
            page.locator("#preset-name").fill("С моим слоем")
            page.locator("#preset-form button").click()
            page.reload()
            wait_for_map(page)
            page.wait_for_function("libraryLoaded && customLayers.size === 1")
            assert page.evaluate("map.getPixelRatio()") == 1
            assert page.evaluate("id => customLayers.get(id).color", layer_id) == "#227755"
            assert page.evaluate("id => !!map.getSource(id+'-source')", layer_id)
            page.locator("#layers-button").click()
            page.get_by_role("button", name="Удалить слой Прогулка", exact=True).click()
            page.wait_for_function("customLayers.size === 0")
            page.get_by_role("button", name="Применить набор «С моим слоем»", exact=True).click()
            assert page.evaluate("Object.keys(state.customLayers)") == []
            page.locator("#layer-file").set_input_files({"name": "broken.geojson", "mimeType": "application/json", "buffer": b'{"type":"Feature","geometry":null}'})
            page.wait_for_function("document.getElementById('import-status').textContent.includes('Не удалось')")
            assert page.evaluate("customLayers.size") == 0

            # Exercise the JS/native boundary with controlled callbacks; no external requests.
            page.evaluate("""() => {
                window.requests = []; window.frameRequests = []; window.cancellations = [];
                window.accepted = []; window.frameCancellations = 0;
                window.AndroidHost = {
                    requestScene: text => requests.push(JSON.parse(text)),
                    requestShadowFrame: (scene,index,id) => frameRequests.push({scene,index,id}),
                    acceptScene: id => accepted.push(id), cancelScene: id => cancellations.push(id),
                    cancelShadowFrame: () => frameCancellations++, haptic() {},
                };
                window.makeBundle = (id,date) => ({schemaVersion:1, sceneId:id,
                    region:fallbackData.region, buildings: {type:'FeatureCollection',features:fallbackData.buildings.features.slice(0,2)},
                    source:'city-pack:test', layers:{shadows:{initialFrameIndex:30, frames:fallbackData.shadeFrames.map(f=>({
                        ...f, time:date+'T'+f.label+':00+05:45',geometry:null,computed:false}))}}});
                state.shadows = true; applyMapState(); showFrame(30);
            }""")
            page.locator(".scene-settings summary").click()
            page.locator("#scene-date").fill("2026-12-21")
            page.locator("#scene-timezone").select_option("345")
            page.locator("#scene-recalculate").click()
            assert page.evaluate("requests[0].localDate") == "2026-12-21"
            assert page.evaluate("requests[0].timezoneOffsetMinutes") == 345
            page.locator("#cancel-scene").click()
            assert page.evaluate("pendingScene") is None
            assert page.evaluate("cancellations.length") == 1
            assert page.locator("#scene-date-label").inner_text().startswith("17.07.2026")

            bundle = page.evaluate("makeBundle('s-1111111111111111','2026-12-21')")
            page.route("**/generated/scene.json", lambda route: route.fulfill(json=bundle))
            page.evaluate("void loadSceneAt(59.85,30.32,'Проверка',{keepCamera:true}).catch(()=>{})")
            request_id = page.evaluate("pendingScene.requestId")
            page.evaluate("id => SloiApp.onSceneReady(id,'/generated/scene.json')", request_id)
            assert page.evaluate("accepted[0]") == "s-1111111111111111"
            assert page.locator("#scene-date-label").inner_text() == "21.12.2026 · UTC+05:45"
            page.wait_for_function("frameRequests.length > 0")
            # An error in the replacement scene must restart the interrupted frame from the old one.
            prior = page.evaluate("frameRequests.length")
            page.evaluate("void loadSceneAt(59.86,30.33,'Ошибка').catch(()=>{})")
            page.evaluate("SloiApp.onSceneError(pendingScene.requestId,'нет сети')")
            page.wait_for_function("count => frameRequests.length > count", arg=prior)
            assert page.evaluate("activeSceneId") == "s-1111111111111111"
            page.evaluate("state.shadows=false; applyMapState(); showFrame(30); startPlayback()")
            frame_count = page.evaluate("frameRequests.length")
            page.wait_for_function("state.frame !== 30")
            assert page.evaluate("frameRequests.length") == frame_count
            page.evaluate("stopPlayback()")

            # Old async fetch failure must not overwrite a newer pending scene's status.
            page.evaluate("""() => {
                window.originalRead = readGeneratedJson;
                readGeneratedJson = () => new Promise((resolve,reject) => {window.rejectOld = reject});
                void loadSceneAt(59.85,30.32,'A').catch(()=>{});
                window.oldCallback = SloiApp.onSceneReady(pendingScene.requestId,'/generated/old.json');
                void loadSceneAt(59.86,30.33,'B').catch(()=>{});
                window.newStatus = document.getElementById('place-status').textContent;
                rejectOld(new Error('old error'));
            }""")
            page.evaluate("oldCallback")
            assert page.evaluate("elements.placeStatus.textContent === newStatus")
            page.evaluate("readGeneratedJson=originalRead; cancelSceneLoad();")
            # Reapplying unchanged appearance should do no MapLibre mutation work.
            assert page.evaluate("""() => {
                applyMapState();
                const names=['setPaintProperty','setLayoutProperty','moveLayer'];
                let calls=0; const saved={};
                for(const name of names){saved[name]=map[name];map[name]=function(...args){calls++;return saved[name].apply(this,args)}}
                applyMapState();
                for(const name of names) map[name]=saved[name];
                return calls===0;
            }""")
            assert not errors, errors
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print("Features OK: GeoJSON persistence, sun, date/offset, cancellation, recovery, stale responses, rendering limits")


if __name__ == "__main__":
    main()
