"""Pick exact endpoints without forward geocoding/GPS; names may resolve later.

Route-service responses are local fixtures; native Back uses the app callback.
"""
import argparse
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
import threading
from urllib.parse import urlparse, parse_qs

from playwright.sync_api import sync_playwright
from test_browser import QuietHandler, wait_for_map
from test_map_gestures_browser import camera, gesture
from test_routing_browser import TRANSIT


def pin_coordinate(page):
    return page.evaluate("""() => {
      const c=map.getCanvas(),point=map.unproject([c.clientWidth/2,c.clientHeight/2]);
      return [((point.lng+180)%360+360)%360-180,point.lat];
    }""")


def assert_picker(page):
    assert page.locator('#routing-panel').is_hidden()
    assert page.locator('#routing-picker').is_visible()
    assert page.locator('.routing-picker-target').is_visible()
    assert not page.locator('#map').evaluate('node=>node.inert')
    assert page.evaluate('routingUI.isPicking() && routingUI.isOpen()')
    geometry = page.evaluate("""() => {
      const target=document.querySelector('.routing-picker-target').getBoundingClientRect();
      const canvas=map.getCanvas().getBoundingClientRect();
      const bar=document.getElementById('routing-picker').getBoundingClientRect();
      return {centre:[target.x+target.width/2,target.y+target.height/2],
        expected:[canvas.x+canvas.width/2,canvas.y+canvas.height/2],
        bar:[bar.x,bar.y,bar.right,bar.bottom],view:[innerWidth,innerHeight]};
    }""")
    assert all(abs(a-b)<.1 for a,b in zip(geometry['centre'],geometry['expected'])), geometry
    x,y,right,bottom = geometry['bar']; width,height=geometry['view']
    assert x >= 0 and y >= 0 and right <= width+.1 and bottom <= height+.1, geometry


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--chromium');parser.add_argument('--screenshot');args=parser.parse_args()
    assets=Path(__file__).resolve().parents[1]/'app/src/main/assets'
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(QuietHandler,directory=str(assets)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    origin=f'http://127.0.0.1:{server.server_port}'
    requests=[];errors=[];search_requests=[]
    try:
      with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=args.chromium,args=['--use-angle=swiftshader','--enable-unsafe-swiftshader'])
        context=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
        context.add_init_script("""(() => {
          window.locationCalls=0;
          Object.defineProperty(navigator,'geolocation',{value:{getCurrentPosition(){locationCalls++;throw new Error('GPS must not be needed')}}});
        })()""")
        def handle(route):
          url=route.request.url
          if url.startswith(origin):route.continue_()
          elif '/transit-api-otp/routes' in url:requests.append(url);route.fulfill(json=TRANSIT)
          elif 'photon.komoot.io/reverse' in url:route.fulfill(json={'features':[]})
          else:
            if 'photon' in url:search_requests.append(url)
            route.abort()
        context.route('**/*',handle)
        page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(origin);wait_for_map(page)
        page.evaluate("map.jumpTo({center:[30.32,59.85],zoom:16,pitch:29,bearing:37,padding:{top:20,bottom:120,left:15,right:0}})")
        page.locator('#route-open').click()
        page.locator('[data-mode=transit]').click()
        page.locator('.routing-parameters > summary').click()
        page.locator('#routing-direct-only').check()
        cdp=context.new_cdp_session(page)

        # Exact coordinates need no GPS or forward geocoder. Reverse naming
        # is independent and must never change the picked coordinates.
        page.get_by_role('button',name='Выбрать начало на карте',exact=True).click()
        assert_picker(page)
        before=camera(page)
        gesture(page,cdp,[(100,220)],[(185,250)])
        assert camera(page)['center'] != before['center']
        start=pin_coordinate(page)
        assert start != camera(page)['center'], 'Retained camera padding must not displace the actual chosen point'
        page.locator('.routing-picker-confirm').click()
        assert page.locator('#routing-from').input_value()=='Точка на карте'
        assert not page.evaluate('routingUI.isPicking()')
        assert page.locator('#routing-direct-only').is_checked()

        page.get_by_role('button',name='Выбрать конец на карте',exact=True).click()
        assert_picker(page)
        gesture(page,cdp,[(190,240)],[(130,210)])
        end=pin_coordinate(page)
        if args.screenshot:page.screenshot(path=args.screenshot)
        page.locator('.routing-picker-confirm').click()
        assert page.locator('#routing-to').input_value()=='Точка на карте'
        assert not search_requests and not requests
        assert page.evaluate('locationCalls')==0
        page.locator('.routing-submit').click()
        page.locator('.routing-option').wait_for()
        query=parse_qs(urlparse(requests[-1]).query)
        for key,coordinate in [('fromLon',start[0]),('fromLat',start[1]),('toLon',end[0]),('toLat',end[1])]:
          assert abs(float(query[key][0])-coordinate)<1e-8,(query,start,end)
        assert page.evaluate('locationCalls')==0
        assert page.locator('.routing-option').count()==1
        page.wait_for_function('!map.isMoving()')

        # Cancelling changes neither endpoint nor the selected route. Exploration
        # remains where the user panned, rather than returning to the old street.
        geometry=page.evaluate("JSON.stringify(map.getSource('route-plan-source')._data)")
        page.get_by_role('button',name='Выбрать конец на карте',exact=True).click()
        gesture(page,cdp,[(120,180)],[(200,215)])
        cancelled_camera=camera(page)
        page.keyboard.press('Escape')
        assert page.locator('#routing-panel').is_visible()
        assert page.locator('#routing-picker').is_hidden()
        assert page.evaluate("JSON.stringify(map.getSource('route-plan-source')._data)")==geometry
        assert page.locator('#routing-to').input_value()=='Точка на карте'
        assert page.locator('#routing-direct-only').is_checked()
        assert camera(page)==cancelled_camera
        assert page.locator('.routing-option').count()==1

        # Android Back first cancels point selection; its next press closes the
        # editor. Starting another app page closes the picker without reopening it.
        page.get_by_role('button',name='Выбрать начало на карте',exact=True).click()
        assert page.evaluate('SloiApp.closeTransientUi()') is True
        assert page.locator('#routing-panel').is_visible()
        assert not page.evaluate('routingUI.isPicking()')
        assert page.evaluate('SloiApp.closeTransientUi()') is True
        assert page.locator('#routing-panel').is_hidden()
        page.locator('.routing-resume').click()
        page.get_by_role('button',name='Выбрать конец на карте',exact=True).click()
        page.locator('#layers-button').click()
        assert page.locator('#routing-picker').is_hidden()
        assert page.locator('.routing-picker-target').is_hidden()
        assert not page.evaluate('routingUI.isOpen()')
        assert not page.locator('body').evaluate("node=>node.classList.contains('is-picking-route')")
        page.locator('#close-sheet').click()

        for width,height in [(320,740),(411,683),(320,568)]:
          page.set_viewport_size({'width':width,'height':height})
          page.locator('.routing-resume').click()
          assert page.locator('.routing-form').evaluate('node=>node.scrollWidth===node.clientWidth')
          page.get_by_role('button',name='Выбрать конец на карте',exact=True).click()
          page.wait_for_function("!document.getElementById('routing-picker').getAnimations().length")
          assert_picker(page)
          page.locator('.routing-picker-cancel').click()
          page.locator('.routing-close').click()
        page.evaluate('routingUI.dispose()')
        assert page.locator('#routing-picker').count()==0
        assert page.locator('.routing-picker-target').count()==0
        assert not errors,errors
        browser.close()
    finally:
      server.shutdown();server.server_close()
    print('Map picker OK: exact endpoints without GPS/forward geocoding, independent naming, physical crosshair coordinates, trusted pan, cancel/back/navigation cleanup and narrow layouts')


if __name__=='__main__':main()
