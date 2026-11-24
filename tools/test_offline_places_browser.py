"""Offline city/search UI contract using synthetic native callbacks, not SQLite proof.

Only bundled APK assets are served. Public tiles/search endpoints stay blocked.
"""
import argparse
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright
from test_browser import QuietHandler, open_panel, wait_for_map


HOST = """(() => {
  window.cityFixture={id:'saint-petersburg',name:'Санкт-Петербург',status:'available',
    downloadBytes:80000000,installedBytes:260000000,bounds:[[29.5,59.5],[31.5,60.5]],
    source:'BBBike',license:'ODbL',revision:'city-1'};
  window.nativeCalls={imports:[],downloads:[],deletes:[],cancel:[],prepare:0,list:0,tileCancel:0};
  window.placeRequests=[];window.placeReplies=true;window.placeLabel='Локальный адрес v1';
  window.AndroidHost={
    isDarkTheme:()=>false,setSystemBarTheme:()=>{},
    listCityPacks(){queueMicrotask(()=>SloiApp.onCityPacks({packs:[cityFixture]}))},
    listOfflinePlaces(){nativeCalls.list++;queueMicrotask(()=>SloiApp.onOfflinePlacesState({phase:'ready',rows:0,revision:'empty'}))},
    prepareOfflinePlaces(){nativeCalls.prepare++},
    importCityPack(id){nativeCalls.imports.push(id)},
    downloadCityPack(id){nativeCalls.downloads.push(id)},
    deleteCityPack(id){nativeCalls.deletes.push(id)},
    cancelCityPack(id){nativeCalls.cancel.push(id)},
    cancelViewportBuildings(){nativeCalls.tileCancel++},
    searchPlaces(text){const request=JSON.parse(text);placeRequests.push(request);
      if(placeReplies){const label=placeLabel;queueMicrotask(()=>SloiApp.onPlacesReady(request.requestId,
        label?[{display_name:label,latitude:59.91,longitude:30.31,source:'offline'}]:[]))}},
    cancelPlaceSearch(){}
  };
})()"""


def camera_and_pin(page):
    return page.evaluate("""({center:map.getCenter().toArray(),zoom:map.getZoom(),
      pitch:map.getPitch(),bearing:map.getBearing(),pin:selectedPlace,
      marker:map.getSource('selected-location')._data})""")


def state(page, revision, **extra):
    page.evaluate("value=>SloiApp.onOfflinePlacesState(value)",
                  {"phase": "ready", "rows": 1200, "revision": revision, **extra})


def publish(page, **extra):
    page.evaluate("""patch=>{Object.assign(cityFixture,patch);
      SloiApp.onCityPackChanged(JSON.stringify({packs:[cityFixture]}))}""", extra)


def assert_layout(page, width):
    page.set_viewport_size({"width": width, "height": 844})
    # Check content and actual controls, including imported attribution, rather
    # than depending on a particular grid or spacing implementation.
    fit = page.locator("#panel-offline").evaluate("""panel=>({
      overflow:panel.scrollWidth>panel.clientWidth,
      controls:[...panel.querySelectorAll('.city-pack button')].map(button=>{
        const r=button.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.width>0;
      })})""")
    assert not fit["overflow"] and all(fit["controls"]), (width, fit)


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
            context.add_init_script(HOST)
            context.route("**/*", lambda route: route.continue_()
                          if route.request.url.startswith(origin) else route.abort())
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(origin)
            wait_for_map(page)
            page.wait_for_function("nativeCalls.list===1 && cityPacks.size===1")
            page.evaluate("""()=>{map.jumpTo({center:[30.32,59.9],zoom:15,bearing:23,pitch:0});
              selectedPlace={name:'Сохранённая точка',longitude:30.32,latitude:59.9};
              restoreSelectedLocation();}""")
            before = camera_and_pin(page)
            open_panel(page, "offline")
            assert page.locator("#settings-page").is_visible()
            assert page.locator("#panel-search").is_hidden()
            card = page.locator(".city-pack")
            detail = card.locator(".city-pack-copy span")
            import_button = card.get_by_role("button", name="Импортировать пакет Санкт-Петербург")
            card.get_by_role("button", name="Скачать", exact=True).click()
            assert page.evaluate("nativeCalls.downloads") == ["saint-petersburg"]
            assert import_button.is_disabled()
            card.get_by_role("button", name="Отмена", exact=True).click()
            assert page.evaluate("nativeCalls.cancel") == ["saint-petersburg"]
            publish(page, status="available")

            import_button.click()
            assert page.evaluate("nativeCalls.imports") == ["saint-petersburg"]
            assert import_button.is_disabled()
            assert "Выберите ZIP или GeoPackage" in detail.inner_text()
            assert card.locator("progress").get_attribute("value") is None
            # The chooser's cancellation callback publishes the unchanged
            # catalogue, restoring the previously available/installed actions.
            publish(page, status="available")
            assert import_button.is_enabled()
            assert card.get_by_role("button", name="Скачать", exact=True).is_enabled()
            import_button.click()
            for phase, current, total, expected in [
                ("import-copy", 16384, 0, "Копирую пакет: 16 КБ"),
                ("import-check", 1, 2, "Проверяю данные"),
                ("index", 2, 4, "Готовлю данные города"),
            ]:
                page.evaluate("p=>SloiApp.onCityPackProgress('saint-petersburg',...p)", [phase, current, total])
                assert expected in detail.inner_text()
                progress = card.locator("progress")
                assert (progress.get_attribute("value") is None) == (total == 0)
                if total:
                    assert progress.evaluate("node=>node.value/node.max") == current / total
            publish(page, status="installed", imported=True, source="Локальный файл OpenStreetMap",
                    validation="SQLite quick_check + ZIP CRC", updatedAt="2026-11-17")
            assert "OSM / ODbL" in detail.inner_text()
            assert "BBBike" not in detail.inner_text() and "MD5" not in detail.inner_text()
            assert import_button.is_enabled()
            for width in (320, 390):
                assert_layout(page, width)
            import_button.click()
            publish(page, status="installed")
            assert card.get_by_role("button", name="Удалить", exact=True).is_enabled()
            assert camera_and_pin(page) == before

            # Progress, row counts and failures belong to the deep Settings page.
            state(page, "city-1", phase="indexing", current=1, total=4)
            assert "25%" in page.locator("#offline-place-status").inner_text()
            state(page, "city-1", rows=12345)
            assert "12" in page.locator("#offline-place-status").inner_text()
            assert "345 объектов" in page.locator("#offline-place-status").inner_text()
            state(page, "city-1", phase="error", error="Синтетическая ошибка индекса")
            assert "Синтетическая ошибка индекса" in page.locator("#offline-place-status").inner_text()
            page.locator("#offline-place-retry").click()
            assert page.evaluate("nativeCalls.prepare") == 1
            state(page, "city-1")
            assert page.locator("#offline-place-retry").is_hidden()
            open_panel(page, "search")
            assert page.locator("#offline-place-status").is_hidden()
            page.locator("#place-query").fill("Адрес")
            page.locator(".place-result").filter(has_text="Локальный адрес v1").wait_for()
            request_count = page.evaluate("placeRequests.length")
            # Identical revision does not restart a completed query.
            state(page, "city-1", rows=1250)
            assert page.evaluate("placeRequests.length") == request_count
            clean_status = page.locator("#place-status").inner_text()
            publish(page, revision="city-2")
            page.evaluate("SloiApp.onCityPackError('saint-petersburg','Ошибка пакета только в настройках')")
            assert page.locator("#place-status").inner_text() == clean_status
            page.evaluate("placeLabel='Локальный адрес v2'")
            # Accept legacy native state signatures as well as revision fields.
            state(page, "", signature="search-2")
            page.locator(".place-result").filter(has_text="Локальный адрес v2").wait_for()
            assert page.locator("#place-results").get_by_text("Локальный адрес v1", exact=True).count() == 0
            assert page.evaluate("SloiOfflinePlacesRevision") == "search-2"
            assert page.evaluate("placeRequests.length") == request_count + 1
            page.evaluate("placeLabel=''")
            state(page, "deleted", rows=0)
            page.wait_for_function("document.querySelector('#place-results').children.length===0")
            assert page.locator("#place-status").inner_text() == "Ничего не найдено"
            assert camera_and_pin(page) == before

            # Installation/deletion normally happens with search hidden behind
            # Settings. Returning to its unchanged query must not expose results
            # from the removed index or leave the user to type again.
            page.evaluate("placeLabel='Адрес до замены в настройках'")
            state(page, "settings-before")
            page.locator(".place-result").filter(has_text="Адрес до замены в настройках").wait_for()
            open_panel(page, "offline")
            page.evaluate("placeLabel='Адрес после замены в настройках'")
            state(page, "settings-after")
            open_panel(page, "search")
            page.locator(".place-result").filter(has_text="Адрес после замены в настройках").wait_for()
            assert "Адрес до замены" not in page.locator("#place-results").inner_text()
            page.evaluate("placeReplies=false")
            page.locator("#place-query").fill("Задержанный адрес")
            page.wait_for_function("placeRequests.at(-1).query==='Задержанный адрес'")
            hidden_stale_id = page.evaluate("placeRequests.at(-1).requestId")
            open_panel(page, "offline")
            page.evaluate("placeLabel=''")
            state(page, "settings-deleted", rows=0)
            page.evaluate("id=>SloiApp.onPlacesReady(id,[{display_name:'Адрес из удалённого индекса',latitude:59.9,longitude:30.3}])", hidden_stale_id)
            assert "Адрес из удалённого индекса" not in page.locator("#place-results").inner_text()
            page.evaluate("placeReplies=true")
            open_panel(page, "search")
            page.wait_for_function("document.querySelector('#place-results').children.length===0")
            assert page.locator("#place-status").inner_text() == "Ничего не найдено"

            # Route endpoint search must keep the local index revision in its
            # cache context, abort stale work, and refresh the focused endpoint.
            page.locator("#close-sheet").click()
            page.locator("#route-open").click()
            route_field = page.locator("#routing-to")
            page.evaluate("placeLabel='Маршрутный адрес v1'")
            route_field.fill("Адрес маршрута")
            page.locator(".routing-suggestion").filter(has_text="Маршрутный адрес v1").wait_for()
            page.evaluate("placeReplies=false")
            route_request_count = page.evaluate("placeRequests.length")
            state(page, "route-2")
            page.wait_for_function("count=>placeRequests.length===count+1 && document.querySelector('.routing-suggestions').children.length===0", arg=route_request_count)
            stale_id = page.evaluate("placeRequests.at(-1).requestId")
            page.evaluate("placeReplies=true;placeLabel='Маршрутный адрес v3'")
            state(page, "route-3")
            page.locator(".routing-suggestion").filter(has_text="Маршрутный адрес v3").wait_for()
            page.evaluate("id=>SloiApp.onPlacesReady(id,[{display_name:'Устаревший маршрутный адрес',latitude:59.9,longitude:30.3}])", stale_id)
            assert "Устаревший" not in page.locator(".routing-suggestions").inner_text()
            page.evaluate("placeLabel=''")
            state(page, "route-deleted", rows=0)
            page.wait_for_function("document.querySelector('.routing-suggestions').children.length===0")
            assert camera_and_pin(page) == before
            page.locator(".routing-close").click()

            # Replacing a city package drops existing geometry sources/layers,
            # pending request and revision metadata, preserving camera and pin.
            publish(page, status="installed", revision="city-cache-1")
            page.evaluate("""()=>{
              window.cacheTile='15/19143/9523';
              addViewportTile(cacheTile,{featureCount:0,buildings:{type:'FeatureCollection',features:[]}});
              viewport.requestId='old-native-request';viewport.signature='old-signature';
              viewport.blockedSignature='old-blocked';viewport.pack={id:cityFixture.id};viewport.packRevision='old-revision';
            }""")
            assert page.evaluate("!!map.getSource(viewportLayerIds(cacheTile).source)")
            snapshot = camera_and_pin(page)
            publish(page, revision="city-cache-2")
            assert page.evaluate("viewport.loaded.size===0 && viewport.requestId===null && viewport.pack===null && viewport.packRevision===null && viewport.signature===null && viewport.blockedSignature===null")
            assert page.evaluate("!map.getSource(viewportLayerIds(cacheTile).source) && !map.getLayer(viewportLayerIds(cacheTile).flat) && !map.getLayer(viewportLayerIds(cacheTile).extrusion)")
            assert page.evaluate("nativeCalls.tileCancel") >= 1
            assert camera_and_pin(page) == snapshot
            open_panel(page, "offline")
            card.get_by_role("button", name="Удалить", exact=True).click()
            assert page.evaluate("nativeCalls.deletes") == ["saint-petersburg"]
            publish(page, status="available", imported=False)
            state(page, "empty-final", rows=0)
            assert "после установки" in page.locator("#offline-place-status").inner_text()
            assert camera_and_pin(page) == snapshot
            assert not errors, errors
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print("Offline places UI OK: download/import/cancel/progress, Settings-only status/retry, revision-aware main/route search, stale callbacks, package cache cleanup, camera/pin continuity and 320/390px layout (synthetic native bridge; not SQLite proof)")


if __name__ == "__main__":
    main()
