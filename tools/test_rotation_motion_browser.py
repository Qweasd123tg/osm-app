"""Real screen projection follows trusted touches; no native/phone proof implied."""
import argparse
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright
from test_browser import QuietHandler, wait_for_map
from test_map_gestures_browser import pair_at, send_touch


def angle_delta(value):
    return (value + 180) % 360 - 180


def begin(page, cdp, bearing=37):
    page.evaluate("""bearing => {
      closeSheet();
      map.jumpTo({center:[30.32,59.9],zoom:15,pitch:0,bearing,
        padding:{top:0,right:0,bottom:0,left:0}});
      window.rotationScreenSamples=[];window.rotationTrusted=[];
      window.rotationScreenState=()=>{
        const a=map.project([30.32,59.9]),b=map.project([30.323,59.9]);
        return {angle:Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI,
          zoom:map.getZoom(),pitch:map.getPitch(),center:map.getCenter().toArray()};
      };
      window.rotationScreenRecord=()=>rotationScreenSamples.push(rotationScreenState());
      window.rotationTouchRecord=event=>rotationTrusted.push(event.isTrusted);
      map.on('move',rotationScreenRecord);
      window.addEventListener('touchstart',rotationTouchRecord,true);
    }""", bearing)
    initial=page.evaluate('rotationScreenState()')
    send_touch(cdp,'touchStart',pair_at(70,0))
    return initial


def move(page, cdp, radius, angle):
    page.wait_for_timeout(24)
    send_touch(cdp,'touchMove',pair_at(radius,angle))
    page.wait_for_timeout(24)
    return page.evaluate('rotationScreenState()')


def finish(page, cdp):
    try:
        send_touch(cdp,'touchEnd',[])
        page.wait_for_function('!mapTouchActive && !map.isMoving() && map.dragPan.isEnabled()')
        result=page.evaluate('({samples:rotationScreenSamples,trusted:rotationTrusted,final:rotationScreenState()})')
        assert result['trusted'] and all(result['trusted']),result
        return result
    finally:
        page.evaluate("""() => {
          map.off('move',rotationScreenRecord);
          window.removeEventListener('touchstart',rotationTouchRecord,true);
        }""")


def projected_travel(initial, samples):
    previous=initial['angle'];travel=0;increments=[]
    for state in samples:
        step=angle_delta(state['angle']-previous)
        travel+=step;increments.append(step);previous=state['angle']
    return travel,increments


def unchanged_axes(initial, states):
    for state in states:
        assert abs(state['zoom']-initial['zoom'])<.01,(initial,state)
        assert abs(state['pitch']-initial['pitch'])<.01,(initial,state)
        assert all(abs(a-b)<1e-8 for a,b in zip(state['center'],initial['center'])),(initial,state)


def short_live_turn(page, cdp, direction):
    initial=begin(page,cdp)
    try:
        moving=[move(page,cdp,70,direction*degrees) for degrees in range(2,11,2)]
        live=angle_delta(moving[-1]['angle']-initial['angle'])
    finally:
        result=finish(page,cdp)
    travel,increments=projected_travel(initial,result['samples'])
    # Small adjustments must be visible before finger-up, in finger direction.
    assert live*direction>1,{'direction':direction,'live':live,'samples':result['samples']}
    assert abs(travel-direction*10)<=4,{'direction':direction,'travel':travel}
    assert max(map(abs,increments),default=0)<=8,{'direction':direction,'increments':increments}
    assert abs(angle_delta(result['final']['angle']-moving[-1]['angle']))<1,result
    unchanged_axes(initial,result['samples'])
    return {'direction':direction,'live':live,'screenTravel':travel,'maxUpdate':max(map(abs,increments),default=0)}


def long_turn(page, cdp, direction):
    # Projected geometry, not normalized bearing, defines actual screen motion.
    initial=begin(page,cdp,bearing=170*direction)
    try:
        for degrees in range(5,271,5):move(page,cdp,70,direction*degrees)
    finally:
        result=finish(page,cdp)
    travel,increments=projected_travel(initial,result['samples'])
    assert abs(travel-direction*270)<=4,{'direction':direction,'travel':travel}
    assert all(step*direction>=-.1 for step in increments),{'direction':direction,'increments':increments}
    assert max(map(abs,increments),default=0)<=12,{'direction':direction,'increments':increments}
    unchanged_axes(initial,result['samples'])
    return {'direction':direction,'screenTravel':travel,'maxUpdate':max(map(abs,increments),default=0)}


def turn_then_pinch(page, cdp, direction):
    initial=begin(page,cdp)
    try:
        for degrees in range(5,36,5):turned=move(page,cdp,70,direction*degrees)
        before_handover=angle_delta(turned['angle']-initial['angle'])
        assert abs(before_handover)>25,{'direction':direction,'travel':before_handover}
        zooming=[move(page,cdp,radius,direction*35) for radius in [76,85,100,115,100]]
    finally:
        result=finish(page,cdp)
    # Radial handover/reversal cannot restore the initial camera orientation.
    for state in [*zooming,result['final']]:
        assert abs(angle_delta(state['angle']-turned['angle']))<1,{'direction':direction,'turned':turned,'after':state}
        assert abs(state['pitch']-initial['pitch'])<.01,(initial,state)
        assert all(abs(a-b)<1e-8 for a,b in zip(state['center'],initial['center'])),(initial,state)
    return {'direction':direction,'screenTravelBeforePinch':before_handover,
      'screenTravelAfterPinch':angle_delta(result['final']['angle']-initial['angle']),
      'zoomBefore':turned['zoom'],'zoomAfter':result['final']['zoom']}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--chromium');args=parser.parse_args()
    assets=Path(__file__).resolve().parents[1]/'app/src/main/assets'
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(QuietHandler,directory=str(assets)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    origin=f'http://127.0.0.1:{server.server_port}'
    errors=[];failures=[]
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path=args.chromium,
              args=['--use-angle=swiftshader','--enable-unsafe-swiftshader'])
            context=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
            context.route('**/*',lambda route:route.continue_() if route.request.url.startswith(origin) else route.abort())
            page=context.new_page();page.on('pageerror',lambda error:errors.append(str(error)))
            page.goto(origin);wait_for_map(page);cdp=context.new_cdp_session(page)
            for test in [short_live_turn,long_turn,turn_then_pinch]:
                for direction in [1,-1]:
                    try:print(test.__name__,test(page,cdp,direction),flush=True)
                    except AssertionError as error:
                        failures.append((test.__name__,direction,str(error)))
                        print('FAIL',test.__name__,direction,str(error),flush=True)
            assert not errors,errors
            assert not failures,failures
            browser.close()
    finally:
        server.shutdown();server.server_close()
    print('Rotation motion OK: same screen direction, live short turns, continuous 270-degree arcs and no reset on pinch handover')


if __name__=='__main__':main()
