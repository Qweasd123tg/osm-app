"""Integrated search UI: real controller, mocked native/provider responses; no live network."""
import argparse
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
import threading
from playwright.sync_api import sync_playwright
from test_browser import QuietHandler, open_panel, wait_for_map


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
            context = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
            context.add_init_script("""(() => {
                window.searchRequests=[];window.cancelSearchCalls=0;
                window.AndroidHost={
                  listCityPacks:()=>{},isDarkTheme:()=>false,setSystemBarTheme:()=>{},
                  searchPlaces:text=>{const r=JSON.parse(text);searchRequests.push(r);
                    if(r.query==='Ошибка')queueMicrotask(()=>SloiApp.onPlacesError(r.requestId,'Нет соединения'));
                    else if(!['Поздний','Невс'].includes(r.query))queueMicrotask(()=>SloiApp.onPlacesReady(r.requestId,[{display_name:r.query+' · результат',latitude:59.9,longitude:30.3}]));
                  },cancelPlaceSearch:()=>cancelSearchCalls++
                };
            })()""")
            def route(request):
                url = request.request.url
                if url.startswith(origin):
                    request.continue_()
                elif "/api/visary/operator/route" in url:
                    request.fulfill(json=[{"Id": 26, "ShortName": "26", "Name": "Вокзал — метро"}, {"Id": 3, "ShortName": "3"}])
                elif "/api/visary/stop/byRoute" in url:
                    request.fulfill(json={"Directions": [{"Direction": 1, "Items": [{"Order": 1, "Shape": "30.3 59.9,30.32 59.92"}]}]})
                else:
                    request.abort()
            context.route("**/*", route)
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(origin);wait_for_map(page)
            page.wait_for_function("moduleHost && moduleHost.list().some(m=>m.id==='spb-bus')")
            open_panel(page, "search")
            field = page.locator("#place-query")
            field.fill("Невский")
            page.locator(".place-result").filter(has_text="Невский · результат").wait_for()
            assert page.evaluate("searchRequests.length") == 1
            assert page.evaluate("searchRequests[0].limit") == 6
            assert not page.locator("#place-submit").is_disabled()
            assert page.locator("#place-query").input_value() == "Невский"

            # Backspacing shows a matching received place even if the new native
            # query never answers. Returning to the exact spelling bypasses its
            # debounce/network instead of clearing a perfectly usable response.
            field.fill("Невс")
            page.wait_for_function("searchRequests.some(r=>r.query==='Невс')")
            assert page.locator(".place-result").filter(has_text="Невский · результат").count() == 1
            field.fill("Невский")
            assert page.locator(".place-result").filter(has_text="Невский · результат").count() == 1
            page.wait_for_timeout(220)
            assert page.evaluate("searchRequests.filter(r=>r.query==='Невский').length") == 1

            field.fill("Поздний")
            page.wait_for_function("searchRequests.some(r=>r.query==='Поздний')")
            stale_id = page.evaluate("searchRequests.at(-1).requestId")
            field.fill("Париж")
            page.locator(".place-result").filter(has_text="Париж · результат").wait_for()
            page.evaluate("id=>SloiApp.onPlacesReady(id,[{display_name:'Нельзя показывать',latitude:0,longitude:0}])", stale_id)
            assert page.get_by_text("Нельзя показывать").count() == 0
            assert page.evaluate("cancelSearchCalls") >= 1
            field.fill("")
            assert page.locator("#place-results button").count() == 0
            field.fill("Поздний")
            page.wait_for_function("searchRequests.filter(r=>r.query==='Поздний').length===2")
            cleared_id = page.evaluate("searchRequests.at(-1).requestId")
            field.fill("")
            page.evaluate("id=>SloiApp.onPlacesReady(id,[{display_name:'Очистка не должна воскресить результат',latitude:0,longitude:0}])", cleared_id)
            assert page.locator("#place-results button").count() == 0

            before = page.evaluate("searchRequests.length")
            field.evaluate("node=>node.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))")
            field.fill("Составляется")
            page.wait_for_timeout(340)
            assert page.evaluate("searchRequests.length") == before
            field.evaluate("node=>node.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))")
            page.locator(".place-result").filter(has_text="Составляется · результат").wait_for()

            # Installed transport provider is searchable while its map layer is off.
            assert not page.evaluate("moduleHost.get('spb-bus').enabled")
            field.fill("26")
            route_button = page.locator(".place-result").filter(has_text="Автобус 26")
            route_button.wait_for()
            assert page.locator("#place-results").inner_text().find("Транспорт") >= 0
            selected_before = page.evaluate("selectedPlace")
            route_button.click()
            page.wait_for_function("moduleHost.get('spb-bus').status==='ready'")
            assert page.evaluate("moduleHost.get('spb-bus').settings.route") == "26"
            assert page.evaluate("selectedPlace") == selected_before
            assert page.locator("#layers-sheet").evaluate("node=>node.inert")

            open_panel(page, "search")
            field.fill("3")
            page.locator(".place-result").filter(has_text="Автобус 3").wait_for()
            assert not page.evaluate("searchRequests.some(r=>r.query==='3')"), "One-digit route doesn't invoke place provider"
            field.fill("Ошибка")
            page.wait_for_function("document.querySelector('#place-status').textContent.includes('Нет соединения')")

            # Independently owned search controllers share a latest-only native
            # bridge. A must settle promptly when B replaces it; a later abort
            # from A must not cancel the native request now owned by B.
            ownership = page.evaluate("""async () => {
                const search=AndroidHost.searchPlaces,cancel=AndroidHost.cancelPlaceSearch;
                const a=new AbortController(),b=new AbortController(),already=new AbortController();
                let active=null;
                const held=[];
                AndroidHost.searchPlaces=text=>{const r=JSON.parse(text);held.push(r);active=r.requestId};
                AndroidHost.cancelPlaceSearch=()=>{cancelSearchCalls++;active=null};
                const settle=promise=>promise.then(value=>({status:'ready',value}),error=>({status:error.name}));
                const deadline=promise=>Promise.race([promise,new Promise(resolve=>setTimeout(()=>resolve({status:'timeout'}),300))]);
                try {
                    const first=settle(queryPlaceSuggestions('Независимый A',{signal:a.signal}));
                    const second=settle(queryPlaceSuggestions('Независимый B',{signal:b.signal}));
                    const newest=held.at(-1).requestId;
                    const firstResult=await deadline(first);
                    const before=cancelSearchCalls;
                    a.abort();
                    already.abort();
                    const abortedResult=await settle(queryPlaceSuggestions('Уже отменён',{signal:already.signal}));
                    const stillOwns=active===newest;
                    const cancellations=cancelSearchCalls-before;
                    // A stale native reply must not complete or supersede B.
                    SloiApp.onPlacesReady(held[0].requestId,[{name:'Старый A',longitude:0,latitude:0}]);
                    if(active===newest)SloiApp.onPlacesReady(newest,[{name:'Текущий B',longitude:30.3,latitude:59.9}]);
                    return {firstResult,secondResult:await deadline(second),abortedResult,stillOwns,cancellations,
                        calls:held.length,pending:nativePlaceRequests.size};
                } finally {
                    a.abort();b.abort();
                    AndroidHost.searchPlaces=search;AndroidHost.cancelPlaceSearch=cancel;
                }
            }""")
            assert ownership["firstResult"]["status"] == "AbortError", ownership
            assert ownership["secondResult"]["status"] == "ready", ownership
            assert ownership["secondResult"]["value"][0]["name"] == "Текущий B", ownership
            assert ownership["abortedResult"]["status"] == "AbortError", ownership
            assert ownership["stillOwns"] and ownership["cancellations"] == 0, ownership
            assert ownership["calls"] == 2 and ownership["pending"] == 0, ownership
            assert not errors, errors
            browser.close()
    finally:
        server.shutdown();server.server_close()
    print("Search browser OK: immediate cached suggestions, IME, transport, stale suppression and latest native ownership across independent controllers")


if __name__ == "__main__":
    main()
