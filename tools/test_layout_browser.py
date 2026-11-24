"""Compact panels keep their geometry while content, tabs and viewport change."""

import argparse
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright
from test_browser import QuietHandler, open_panel, wait_for_map


def rect(page, selector):
    return page.locator(selector).evaluate("node => {const r=node.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}")


def assert_rect(actual, expected):
    assert all(abs(a - b) < .1 for a, b in zip(actual, expected)), (actual, expected)


def check_viewport(browser, origin, width, height):
    context = browser.new_context(viewport={"width": width, "height": height},
                                  is_mobile=width < 800, has_touch=True)
    context.route("**/*", lambda route: route.continue_()
                  if route.request.url.startswith(origin) else route.abort())
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(origin)
    wait_for_map(page)
    open_panel(page, "search")
    # Slow software rendering can delay the transition's first frame. Wait for
    # its actual transform to settle before treating its geometry as invariant.
    page.wait_for_function("""() => {
        const sheet=document.getElementById('layers-sheet');
        if (!sheet.classList.contains('is-open')) return false;
        const transform=new DOMMatrixReadOnly(getComputedStyle(sheet).transform);
        return Math.abs(transform.m41)<.01 && Math.abs(transform.m42)<.01;
    }""")
    sheet = rect(page, "#layers-sheet")
    header = rect(page, ".sheet-title")
    tabs = rect(page, ".sheet-tabs")
    footer = rect(page, ".sheet-foot")
    assert sheet[1] >= -.1 and sheet[1] + sheet[3] <= height + .1
    assert page.locator("#layers-sheet").evaluate("node=>node.scrollWidth<=node.clientWidth")
    for panel in ["layers", "search", "layers"]:
        open_panel(page, panel)
        assert_rect(rect(page, "#layers-sheet"), sheet)
        assert_rect(rect(page, ".sheet-title"), header)
        assert_rect(rect(page, ".sheet-tabs"), tabs)
        assert_rect(rect(page, ".sheet-foot"), footer)
        content = rect(page, f"#panel-{panel}")
        assert content[1] >= tabs[1] + tabs[3] - .1
        assert content[1] + content[3] <= footer[1] + .1
        assert page.locator(f"#panel-{panel}").evaluate("node=>node.scrollWidth<=node.clientWidth")

    # Long content changes and scrolling may never displace navigation.
    page.locator("#panel-layers").evaluate("""node=>{
        const fixture=document.createElement('div');fixture.id='layout-fixture';
        fixture.style.height='1800px';node.append(fixture);node.scrollTop=900;
    }""")
    assert page.locator("#panel-layers").evaluate("node=>node.scrollTop") > 0
    assert_rect(rect(page, "#layers-sheet"), sheet)
    assert_rect(rect(page, ".sheet-title"), header)
    assert_rect(rect(page, ".sheet-tabs"), tabs)
    open_panel(page, "search")  # Tabs must stay reachable while a panel is scrolled.
    assert page.locator("#place-query").is_visible()
    assert_rect(rect(page, "#layers-sheet"), sheet)
    assert page.locator("#layers-sheet").evaluate("node=>node.scrollTop") == 0
    assert page.locator("#place-query").bounding_box()["height"] >= 44
    page.locator("#place-query").focus()
    focus = page.locator("#place-query").evaluate("node=>{const s=getComputedStyle(node);return {offset:s.outlineOffset,width:s.outlineWidth,color:s.outlineColor,muted:getComputedStyle(document.documentElement).getPropertyValue('--muted').trim()}}")
    assert focus["offset"] == "-1px", focus
    assert focus["width"] == "1px", focus
    assert page.locator("#place-query").evaluate("node=>{const a=node.getBoundingClientRect(),b=node.closest('.sheet-panel').getBoundingClientRect();return a.left>=b.left&&a.right<=b.right}")
    assert page.locator("#close-sheet").bounding_box()["height"] >= 44
    assert page.locator(".sheet-tabs button:visible").first.bounding_box()["height"] >= 44

    # Keyboard-sized viewport: the form remains in the independently scrollable body.
    if width < 800 and height > 500:
        page.set_viewport_size({"width": width, "height": 330})
        page.locator("#place-query").focus()
        reduced_sheet = rect(page, "#layers-sheet")
        assert reduced_sheet[1] >= -.1 and reduced_sheet[1] + reduced_sheet[3] <= 330.1
        form = rect(page, "#place-form")
        assert form[1] >= rect(page, ".sheet-tabs")[1]
        assert form[1] + form[3] < 330

    # The same controls and geometry work when animations are disabled.
    page.emulate_media(reduced_motion="reduce")
    open_panel(page, "settings")
    assert page.locator("#panel-settings").evaluate("node=>parseFloat(getComputedStyle(node).animationDuration)") < .001
    page.locator('#theme-options button[data-theme="dark"]').click()
    assert page.evaluate("document.documentElement.dataset.theme") == "dark"
    assert page.locator('#theme-options button[data-theme="dark"]').get_attribute("aria-pressed") == "true"
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
            for width, height in [(390, 844), (320, 568), (780, 360), (1024, 768)]:
                check_viewport(browser, f"http://127.0.0.1:{server.server_port}", width, height)
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print("Layout OK: stable tab/header/footer geometry, independent scroll, compact targets, small viewport and reduced motion")


if __name__ == "__main__":
    main()
