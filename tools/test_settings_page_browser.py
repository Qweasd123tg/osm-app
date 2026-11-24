"""Settings is a full app page; navigation preserves camera and background work."""
import argparse
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright
from test_browser import QuietHandler, open_panel, wait_for_map


HOST = """(() => {
window.offlineRequests=[];
window.AndroidHost={
  getOfflineBasemap(){return 'null'},
  listOfflineBasemap(){queueMicrotask(()=>SloiApp.onOfflineBasemap(null))},
  downloadOfflineBasemap(value){offlineRequests.push(JSON.parse(value))},
  cancelOfflineBasemap(){},deleteOfflineBasemap(){}
};
})()"""


def camera(page):
    return page.evaluate("({center:map.getCenter().toArray(),zoom:map.getZoom(),pitch:map.getPitch(),bearing:map.getBearing()})")


def assert_full_page(page, width, height):
    page.wait_for_function("""() => {
      const page=document.getElementById('settings-page');
      const matrix=new DOMMatrixReadOnly(getComputedStyle(page).transform);
      return !page.hidden && Math.abs(matrix.m41)<.01 && Math.abs(matrix.m42)<.01;
    }""")
    state = page.locator("#settings-page").evaluate("""node=>{
      const r=node.getBoundingClientRect();return {rect:[r.x,r.y,r.width,r.height],
        overflow:node.scrollWidth>node.clientWidth,inert:node.inert,
        sheetContains:document.getElementById('layers-sheet').contains(node)};
    }""")
    assert all(abs(a-b)<.1 for a,b in zip(state["rect"], [0,0,width,height])), state
    assert not state["overflow"] and not state["inert"] and not state["sheetContains"], state
    assert page.locator("#layers-sheet").evaluate("node=>node.inert")
    assert page.locator("#map").evaluate("node=>node.inert")
    assert page.locator("#scrim").evaluate("node=>!node.classList.contains('is-open')")
    assert page.locator("#settings-page .settings-panel:visible").count() == 1


def check_viewport(browser, origin, width, height):
    context = browser.new_context(viewport={"width": width, "height": height})
    context.add_init_script(HOST)
    context.route("**/*", lambda route: route.continue_() if route.request.url.startswith(origin) else route.abort())
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(origin)
    wait_for_map(page)
    page.wait_for_function("moduleHost && ['spb-bus','spb-live','spb-metro','shadows'].every(id=>moduleHost.entries.has(id))")
    page.evaluate("map.jumpTo({center:[30.32,59.9],zoom:16,pitch:29,bearing:37});window.settingsSource=map.getSource('shadows');selectedPlace={longitude:30.32,latitude:59.9,name:'Выбранное место'}")
    before = camera(page)
    pin = page.evaluate("selectedPlace")
    open_panel(page, "settings")
    assert_full_page(page, width, height)
    assert page.locator("#settings-title").inner_text() == "Настройки"
    assert page.evaluate("document.activeElement.id") == "settings-back"
    page.keyboard.press("Shift+Tab")
    assert page.evaluate("document.getElementById('panel-settings').contains(document.activeElement)")
    page.keyboard.press("Tab")
    assert page.evaluate("document.activeElement.id") == "settings-back"

    open_panel(page, "module-settings")
    assert_full_page(page, width, height)
    assert page.locator("#settings-title").inner_text() == "Настройки расширений"
    field = page.locator('[data-module-settings="spb-bus"]').get_by_label("Автобусы Петербурга: Номер автобуса")
    field.fill("123")
    # Android's actual page callback walks the Settings stack before exiting.
    assert page.evaluate("SloiApp.closeTransientUi()") is True
    assert page.locator("#panel-settings").is_visible()
    assert page.evaluate("document.activeElement.id") == "nav-module-settings"
    open_panel(page, "module-settings")
    assert field.input_value() == "123"
    page.keyboard.press("Escape")
    assert page.locator("#panel-settings").is_visible()

    open_panel(page, "offline")
    assert_full_page(page, width, height)
    page.locator("#offline-basemap-download").click()
    request_id = page.evaluate("offlineRequests.at(-1).requestId")
    page.keyboard.press("Escape")
    assert page.locator("#panel-settings").is_visible()
    assert page.evaluate("SloiApp.closeTransientUi()") is True
    assert page.locator("#settings-page").is_hidden()
    assert page.locator("#settings-page").evaluate("node=>node.inert")
    assert not page.locator("#map").evaluate("node=>node.inert")
    assert page.evaluate("document.activeElement.id") == "layers-button"
    assert page.evaluate("SloiApp.closeTransientUi()") is False
    page.evaluate("id=>SloiApp.onOfflineBasemapProgress(id,'download',16384,0)", request_id)
    open_panel(page, "offline")
    assert page.locator("#offline-basemap-status").inner_text() == "Загружено 16 КБ"
    assert page.locator("#offline-basemap").get_attribute("aria-busy") == "true"
    assert camera(page) == before
    assert page.evaluate("selectedPlace") == pin
    assert page.evaluate("settingsSource===map.getSource('shadows')")
    # Routing shares the live map. Opening another working panel replaces its
    # editor instead of leaving two panels stacked on top of each other.
    page.evaluate("closeSettingsPage()")
    for panel, entry in [("layers", "layers-button"), ("search", "search-button")]:
        page.locator("#route-open").click()
        assert page.evaluate("routingUI.isOpen()")
        if panel == "search":
            # The route editor occupies the bottom search launcher. Exercise
            # its shared navigation entry directly, rather than clicking through
            # the editor that correctly receives hits in that part of the map.
            page.evaluate("openSheet('search')")
        else:
            page.locator(f"#{entry}").click()
        assert not page.evaluate("routingUI.isOpen()")
        assert page.locator(f"#panel-{panel}").is_visible()
        page.locator("#close-sheet").click()
    assert camera(page) == before
    assert page.evaluate("selectedPlace") == pin
    assert not errors, errors
    context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--chromium")
    args = parser.parse_args()
    assets = Path(__file__).resolve().parents[1] / "app/src/main/assets"
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(assets)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=args.chromium,
                args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
            for width,height in [(320,568),(390,844),(1024,768)]:
                check_viewport(browser, f"http://127.0.0.1:{server.server_port}", width, height)
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print("Settings page OK: full viewport, nested Back/Escape, focus/inert, draft/background download and camera/source continuity")


if __name__ == "__main__":
    main()
