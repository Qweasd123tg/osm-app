"""Extension parameters live in Settings and focused fields stay inside their bounds."""
import argparse
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright
from test_browser import QuietHandler, open_panel, wait_for_map


def check_focus(page, selector):
    field = page.locator(selector)
    field.focus()
    state = field.evaluate("""node => {
        const style=getComputedStyle(node), rect=node.getBoundingClientRect();
        const panel=node.closest('.sheet-panel,.settings-panel,.routing-panel').getBoundingClientRect();
        const probe=document.createElement('span');probe.style.color='var(--line)';node.parentElement.append(probe);
        const neutral=getComputedStyle(probe).color;probe.remove();
        return {width:style.outlineWidth,offset:style.outlineOffset,color:style.outlineColor,neutral,
            inside:rect.left>=panel.left && rect.right<=panel.right};
    }""")
    assert state["width"] == "1px" and state["offset"] == "-1px", state
    assert state["color"] == state["neutral"] and state["inside"], state


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
            for width in [320, 390]:
                context = browser.new_context(viewport={"width": width, "height": 740})
                context.route("**/*", lambda route: route.continue_() if route.request.url.startswith(origin) else route.abort())
                page = context.new_page()
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(origin)
                wait_for_map(page)
                page.wait_for_function("moduleHost && moduleHost.list().length===2")
                open_panel(page)
                bus = page.locator('[data-module="spb-bus"]')
                assert bus.is_visible()
                assert bus.locator('input:not([type="checkbox"]),select,form,details').count() == 0
                assert page.locator('#panel-layers .module-settings').count() == 0
                assert page.locator('#demo-scenes').is_hidden()
                before = page.evaluate("({center:map.getCenter().toArray(),zoom:map.getZoom(),pitch:map.getPitch(),bearing:map.getBearing()})")

                open_panel(page, "module-settings")
                assert page.locator('#settings-title').inner_text() == "Настройки расширений"
                settings = page.locator('[data-module-settings="spb-bus"]')
                route = settings.get_by_label("Автобусы Петербурга: Номер автобуса")
                direction = settings.get_by_label("Автобусы Петербурга: Направление")
                route.fill("22")
                direction.select_option("2")
                page.evaluate("moduleHost.configure('shadows',{opacity:40})")
                assert route.input_value() == "22" and direction.input_value() == "2"
                assert page.locator('#panel-module-settings').evaluate('node=>node.scrollWidth<=node.clientWidth')
                settings.locator('form button[type="submit"]').click()
                page.wait_for_function("moduleHost.get('spb-bus').settings.route==='22'")
                assert page.evaluate("moduleHost.get('spb-bus').settings.direction") == 2
                assert not page.evaluate("moduleHost.get('spb-bus').enabled")
                assert page.evaluate("({center:map.getCenter().toArray(),zoom:map.getZoom(),pitch:map.getPitch(),bearing:map.getBearing()})") == before
                page.locator('#settings-back').click()
                assert page.locator('#panel-settings').is_visible()
                open_panel(page, 'layers')
                assert bus.is_visible() and settings.is_hidden()

                open_panel(page, 'search')
                check_focus(page, '#place-query')
                page.locator('#close-sheet').click()
                page.locator('#route-open').click()
                check_focus(page, '#routing-to')
                assert not errors, errors
                context.close()
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print("Module settings OK: separate page, clean working layers, draft persistence, camera invariance and inset neutral focus")


if __name__ == '__main__':
    main()
