"""Browser regression smoke. Requires Python playwright and a Chromium installation.

Run: python3 tools/test_browser.py --chromium /usr/bin/google-chrome
Uses only local APK assets; external map tile requests are blocked.
"""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def wait_for_map(page):
    page.wait_for_function("mapReady || document.getElementById('fatal').classList.contains('is-visible')")
    assert page.evaluate("mapReady"), page.locator("#fatal-message").inner_text()


def open_panel(page, panel="layers"):
    """Use the working sheet or the separate Settings page through real controls."""
    settings = page.locator("#settings-page")
    if panel in ["settings", "offline", "module-settings"]:
        if settings.is_hidden():
            if page.locator("#layers-sheet").evaluate("node => node.inert"):
                page.locator("#layers-button").click()
            page.locator("#nav-settings").click()
        if page.locator("#panel-settings").is_hidden():
            page.locator("#settings-back").click()
        if panel == "offline":
            page.locator("#nav-offline").click()
        elif panel == "module-settings":
            page.locator("#nav-module-settings").click()
    else:
        for _ in range(2):
            if settings.is_hidden():
                break
            page.locator("#settings-back").click()
        if page.locator("#layers-sheet").evaluate("node => node.inert"):
            page.locator("#search-button" if panel == "search" else "#layers-button").click()
        tab = page.locator(f'.sheet-tabs button[data-panel="{panel}"]')
        if tab.get_attribute("aria-pressed") != "true":
            tab.click()
    assert page.locator(f"#panel-{panel}").is_visible()


def reveal_control(page, selector):
    """Expand the real disclosure controls enclosing a field or action."""
    for details in page.locator(selector).locator("xpath=ancestor::details").all():
        if not details.evaluate("node => node.open"):
            details.locator(":scope > summary").click()


def open_advanced(page):
    open_panel(page)
    reveal_control(page, "#preset-name")


def open_examples(page):
    open_panel(page, "settings")
    reveal_control(page, "#load-demo")


def load_demo(page):
    """Scene-specific regressions opt in to the bundled example."""
    page.wait_for_function("libraryLoaded")
    page.evaluate("loadDemoScene()")
    page.wait_for_function("!map.isMoving()")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--chromium")
    parser.add_argument("--screenshot", help="Optional screenshot of the mobile layer controls")
    args = parser.parse_args()
    assets = Path(__file__).resolve().parents[1] / "app/src/main/assets"
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(assets)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_port}"
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                executable_path=args.chromium,
                args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
            )
            context = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=1)
            context.route("**/*", lambda route: route.continue_()
                          if route.request.url.startswith(origin) else route.abort())
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda error: (errors.append(str(error)), print(f"Page error: {error}", flush=True)))
            page.goto(origin)
            wait_for_map(page)
            load_demo(page)
            # A fresh profile also enables the bundled stops layer.
            page.wait_for_function("moduleHost.get('spb-stops').status === 'ready'")
            assert page.locator("#active-count").inner_text() == "2"
            assert page.locator("#layers-sheet").evaluate("node => node.inert")
            open_panel(page)
            assert page.locator("#map").evaluate("node => node.inert")
            assert page.locator(".bottom-nav").evaluate("node => node.inert")

            page.evaluate("map.jumpTo({bearing: 37, pitch: 43})")
            camera_before_style = page.evaluate("[map.getBearing(), map.getPitch()]")
            reveal_control(page, "#building-opacity")
            page.locator("#building-opacity").evaluate("node => {node.value = '42'; node.dispatchEvent(new Event('input'))}")
            page.evaluate("() => new Promise(resolve => requestAnimationFrame(resolve))")
            assert page.evaluate("map.getPaintProperty('buildings-3d', 'fill-extrusion-opacity')") == .42
            assert page.evaluate("[map.getBearing(), map.getPitch()]") == camera_before_style
            page.locator("#confidence-toggle").check()
            assert page.locator("#height-legend").is_visible()
            assert page.locator("#active-count").inner_text() == "2"
            page.locator("#building-toggle").uncheck(force=True)
            assert page.locator("#active-count").inner_text() == "1"
            assert page.locator("#confidence-toggle").is_disabled()
            assert not page.locator("#height-legend").is_visible()
            page.locator("#building-toggle").check(force=True)

            # Dynamic offline layers must inherit the same style and stack as scene buildings.
            assert page.evaluate("""() => {
                addViewportTile('15/19147/9528', {buildings: data.buildings, featureCount: data.buildings.features.length});
                applyMapState();
                const ids = viewportLayerIds('15/19147/9528');
                const order = map.getStyle().layers.map(layer => layer.id);
                const ok = map.getPaintProperty(ids.extrusion, 'fill-extrusion-opacity') === .42
                    && order.at(-1) === 'selected-location';
                discardViewportTiles(true);
                applyMapState();
                return ok;
            }""")

            page.evaluate("showFrame(36)")
            open_advanced(page)
            page.locator("#preset-name").fill("Вечер <дома>")
            page.locator("#preset-form button").click()
            assert page.locator(".preset-name").inner_text() == "Вечер <дома>"
            page.evaluate("state.buildingOpacity = .9; state.confidence = false; showFrame(20); applyMapState()")
            page.get_by_role("button", name="Применить набор «Вечер <дома>»", exact=True).click()
            assert page.evaluate("[state.buildingOpacity, state.confidence, frames[state.frame].label]") == [.42, True, "18:00"]
            assert page.evaluate("[map.getBearing(), map.getPitch()]") == camera_before_style
            page.reload()
            wait_for_map(page)
            load_demo(page)
            open_advanced(page)
            assert page.locator(".preset-name").inner_text() == "Вечер <дома>"
            assert page.evaluate("state.buildingOpacity") == .42
            # Hidden panel controls stay out of keyboard navigation; focus stays in the modal.
            page.locator("#nav-settings").focus()
            page.keyboard.press("Shift+Tab")
            assert page.evaluate("document.getElementById('panel-layers').contains(document.activeElement)"), page.evaluate("({tag:document.activeElement.tagName,id:document.activeElement.id,html:document.activeElement.outerHTML})")
            page.keyboard.press("Tab")
            assert page.evaluate("document.activeElement.id") == "nav-settings"
            if args.screenshot:
                page.locator("[data-layer=buildings]").scroll_into_view_if_needed()
                page.screenshot(path=args.screenshot)
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            open_advanced(page)
            page.get_by_role("button", name="Удалить набор «Вечер <дома>»", exact=True).click()
            assert page.locator(".preset-row").count() == 0
            page.keyboard.press("Escape")
            assert page.locator("#layers-sheet").evaluate("node => node.inert")
            assert not page.locator("#map").evaluate("node => node.inert")
            assert not page.locator(".bottom-nav").evaluate("node => node.inert")
            page.set_viewport_size({"width": 320, "height": 568})
            open_panel(page)
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            assert page.locator("#layers-sheet").evaluate("node => node.scrollWidth <= node.clientWidth")
            page.set_viewport_size({"width": 1280, "height": 800})
            assert page.locator("#layers-sheet").evaluate("node => node.scrollWidth <= node.clientWidth")

            # A blocked/full localStorage must not prevent map startup or style changes.
            broken = context.new_page()
            broken.on("pageerror", lambda error: errors.append(str(error)))
            broken.add_init_script("Storage.prototype.setItem = function() { throw new Error('quota') }")
            broken.goto(origin)
            wait_for_map(broken)
            load_demo(broken)
            open_panel(broken)
            reveal_control(broken, "#building-opacity")
            broken.locator("#building-opacity").evaluate("node => {node.value = '55'; node.dispatchEvent(new Event('input'))}")
            broken.evaluate("() => new Promise(resolve => requestAnimationFrame(resolve))")
            assert broken.evaluate("map.getPaintProperty('buildings-3d', 'fill-extrusion-opacity')") == .55
            open_advanced(broken)
            assert broken.locator("#preset-status").inner_text().startswith("Настройки действуют")
            assert not errors, errors
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print("Browser OK: controls, camera, dynamic layers, presets, keyboard, storage failure")


if __name__ == "__main__":
    main()
