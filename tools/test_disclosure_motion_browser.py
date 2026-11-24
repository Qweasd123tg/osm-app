"""Native disclosure semantics survive animated open/close, interruption and reduced motion."""
import argparse
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
import threading
from playwright.sync_api import sync_playwright
from test_browser import QuietHandler, open_panel, wait_for_map


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--chromium');args=parser.parse_args()
    assets=Path(__file__).resolve().parents[1]/'app/src/main/assets'
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(QuietHandler,directory=str(assets)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    origin=f'http://127.0.0.1:{server.server_port}'
    errors=[]
    try:
      with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=args.chromium,args=['--use-angle=swiftshader','--enable-unsafe-swiftshader'])
        context=browser.new_context(viewport={'width':390,'height':844})
        context.route('**/*',lambda r:r.continue_() if r.request.url.startswith(origin) else r.abort())
        page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(origin);wait_for_map(page)
        open_panel(page)
        page.locator('#layers-sheet').evaluate('e=>Promise.all(e.getAnimations().map(a=>a.finished))')
        disclosure=page.locator('[data-layer=buildings] .layer-options-details')
        summary=disclosure.locator(':scope > summary')
        closed=disclosure.bounding_box()['height']
        outer=page.locator('#layers-sheet').bounding_box()
        # Real keyboard activation keeps summary semantics and visibly expands
        # through intermediate heights instead of jumping to the final box.
        summary.focus();page.keyboard.press('Enter')
        motion=disclosure.evaluate("""async element=>{
          const sizes=[];
          for(let i=0;i<7;i++){await new Promise(requestAnimationFrame);sizes.push(element.getBoundingClientRect().height)}
          return {sizes,running:element.getAnimations().length};
        }""")
        disclosure.evaluate('e=>Promise.all(e.getAnimations().map(a=>a.finished))')
        expanded=disclosure.bounding_box()['height']
        assert expanded>closed+30,(closed,motion,expanded)
        assert any(closed+.5<h<expanded-.5 for h in motion['sizes']),motion
        assert disclosure.evaluate('e=>e.open')
        assert page.locator('#layers-sheet').bounding_box()==outer
        opacity=page.locator('#building-opacity')
        opacity.focus();page.keyboard.press('Home');page.keyboard.press('ArrowRight')
        opacity_value=opacity.input_value()
        summary.focus();page.keyboard.press('Enter')
        disclosure.evaluate('e=>Promise.all(e.getAnimations().map(a=>a.finished))')
        assert not disclosure.evaluate('e=>e.open')
        assert abs(disclosure.bounding_box()['height']-closed)<.5
        assert page.evaluate('document.activeElement.textContent')=='Настроить'
        summary.focus();page.keyboard.press('Enter');page.keyboard.press('Enter');page.keyboard.press('Enter')
        disclosure.evaluate('e=>Promise.all(e.getAnimations().map(a=>a.finished))')
        assert disclosure.evaluate('e=>e.open')
        assert opacity.input_value()==opacity_value
        assert disclosure.evaluate("e=>e.style.height==='' && e.style.overflow===''")

        # Leaving the page mid-collapse finishes the logical state and releases
        # its animation, so a later visit has no stale inline clipping.
        summary.focus();page.keyboard.press('Enter')
        page.locator('#nav-settings').click()
        page.wait_for_function("!document.querySelector('[data-layer=buildings] details').open")
        assert disclosure.evaluate("e=>!e.getAnimations().length && e.style.height==='' && e.style.overflow===''")
        open_panel(page,'layers')
        assert not disclosure.evaluate('e=>e.open')

        # Dynamic route disclosures use the same behavior. Native Back can close
        # the route during expansion without leaving clipped state or focus.
        page.locator('#close-sheet').click();page.locator('#route-open').click()
        page.locator('[data-mode=transit]').click()
        params=page.locator('.routing-parameters');params.locator('summary').click()
        assert page.evaluate('SloiApp.closeTransientUi()') is True
        assert params.evaluate("e=>e.open && !e.getAnimations().length")
        page.locator('#route-open').click()
        assert params.evaluate('e=>e.open')

        # Reduced-motion preference must change behavior, not just shorten CSS
        # decorations while a JS height animation keeps running.
        page.emulate_media(reduced_motion='reduce')
        params.locator('summary').click()
        assert params.evaluate('e=>!e.open && !e.getAnimations().length')
        params.locator('summary').click()
        assert params.evaluate('e=>e.open && !e.getAnimations().length')
        assert not errors,errors
        browser.close()
    finally:
      server.shutdown();server.server_close()
    print('Disclosure motion OK: intermediate open/close, keyboard, rapid reversal, retained controls, page/back cleanup and reduced-motion semantics')


if __name__=='__main__':main()
