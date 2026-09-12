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
            assert page.locator("#active-count").inner_text() == "2"
            assert page.locator("#layers-sheet").evaluate("node => node.inert")
            page.locator("#layers-button").click()
            assert page.locator("#map").evaluate("node => node.inert")

            page.evaluate("map.jumpTo({bearing: 37, pitch: 43})")
            page.locator("#building-opacity").evaluate("node => {node.value = '42'; node.dispatchEvent(new Event('input'))}")
            page.evaluate("() => new Promise(resolve => requestAnimationFrame(resolve))")
            assert page.evaluate("map.getPaintProperty('buildings-3d', 'fill-extrusion-opacity')") == .42
            assert page.evaluate("[map.getBearing(), map.getPitch()]") == [37, 43]
            page.locator("#confidence-toggle").check()
            assert page.locator("#height-legend").is_visible()
            assert page.locator("#active-count").inner_text() == "2"
            page.locator("#building-toggle").uncheck(force=True)
            assert page.locator("#active-count").inner_text() == "1"
            assert page.locator("#confidence-toggle").is_disabled()
            assert not page.locator("#height-legend").is_visible()
            page.locator("#building-toggle").check(force=True)

            page.get_by_role("button", name="Тени: выше", exact=True).click()
            assert page.evaluate("state.layerOrder") == ["buildings", "shadows", "wind", "sun"]
            page.get_by_role("button", name="Тени: выше", exact=True).click()
            page.get_by_role("button", name="Тени: выше", exact=True).click()
            assert page.evaluate("document.activeElement.getAttribute('aria-label')") == "Тени: ниже"
            page.get_by_role("button", name="Тени: ниже", exact=True).click()
            page.get_by_role("button", name="Тени: ниже", exact=True).click()
            assert page.evaluate("map.getStyle().layers.map(layer => layer.id).indexOf('ground-shadows') > map.getStyle().layers.map(layer => layer.id).indexOf('buildings-3d')")
            # Dynamic offline layers must inherit the same style and stack as scene buildings.
            assert page.evaluate("""() => {
                addViewportTile('15/19147/9528', {buildings: data.buildings, featureCount: data.buildings.features.length});
                applyMapState();
                const ids = viewportLayerIds('15/19147/9528');
                const order = map.getStyle().layers.map(layer => layer.id);
                const ok = map.getPaintProperty(ids.extrusion, 'fill-extrusion-opacity') === .42
                    && order.indexOf(ids.extrusion) < order.indexOf('ground-shadows')
                    && order.at(-1) === 'selected-location';
                discardViewportTiles(true);
                applyMapState();
                return ok;
            }""")

            page.evaluate("showFrame(36)")
            page.locator("#preset-name").fill("Вечер <дома>")
            page.locator("#preset-form button").click()
            assert page.locator(".preset-name").inner_text() == "Вечер <дома>"
            page.evaluate("state.buildingOpacity = .9; state.confidence = false; showFrame(20); applyMapState()")
            page.get_by_role("button", name="Применить набор «Вечер <дома>»", exact=True).click()
            assert page.evaluate("[state.buildingOpacity, state.confidence, frames[state.frame].label]") == [.42, True, "18:00"]
            assert page.evaluate("[map.getBearing(), map.getPitch()]") == [37, 43]
            page.evaluate("updateWind({layers: {wind: {speedMps: 3, directionFromDeg: 90, directionToDeg: 270}}})")
            assert page.locator("#active-count").inner_text() == "3"
            page.locator("#wind-opacity").evaluate("node => {node.value = '28'; node.dispatchEvent(new Event('input'))}")
            page.evaluate("() => new Promise(resolve => requestAnimationFrame(resolve))")
            assert page.evaluate("map.getPaintProperty('wind-head', 'circle-opacity')") == .28
            assert page.evaluate("map.getPaintProperty('wind-head', 'circle-stroke-opacity')") == .28
            page.evaluate("updateWind(null)")
            assert page.locator("#active-count").inner_text() == "2"
            assert page.locator("#wind-toggle").is_disabled()
            assert page.evaluate("state.wind") is True
            page.reload()
            wait_for_map(page)
            page.locator("#layers-button").click()
            assert page.locator(".preset-name").inner_text() == "Вечер <дома>"
            assert page.evaluate("state.buildingOpacity") == .42
            # Hidden panel controls stay out of keyboard navigation; focus stays in the modal.
            page.locator("#close-sheet").focus()
            page.keyboard.press("Shift+Tab")
            assert page.evaluate("document.activeElement.tagName") == "SUMMARY"
            page.keyboard.press("Tab")
            assert page.evaluate("document.activeElement.id") == "close-sheet"
            if args.screenshot:
                page.locator("[data-layer=buildings]").scroll_into_view_if_needed()
                page.screenshot(path=args.screenshot)
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            page.get_by_role("button", name="Удалить набор «Вечер <дома>»", exact=True).click()
            assert page.locator(".preset-row").count() == 0
            page.keyboard.press("Escape")
            assert page.locator("#layers-sheet").evaluate("node => node.inert")
            assert not page.locator("#map").evaluate("node => node.inert")
            page.set_viewport_size({"width": 320, "height": 568})
            page.locator("#layers-button").click()
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
            broken.locator("#layers-button").click()
            broken.locator("#shadow-opacity").evaluate("node => {node.value = '55'; node.dispatchEvent(new Event('input'))}")
            broken.evaluate("() => new Promise(resolve => requestAnimationFrame(resolve))")
            assert broken.evaluate("map.getPaintProperty('ground-shadows', 'fill-opacity')") == .55
            assert broken.locator("#preset-status").inner_text().startswith("Настройки действуют")
            assert not errors, errors
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print("Browser OK: controls, camera, dynamic layers, presets, keyboard, storage failure")


if __name__ == "__main__":
    main()
