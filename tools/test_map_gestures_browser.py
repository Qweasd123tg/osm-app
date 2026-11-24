"""Trusted touch gestures, pinch-axis isolation and vector-basemap themes."""

import argparse
import math
import time
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright
from test_browser import QuietHandler, open_panel, wait_for_map


def send_touch(cdp, kind, points, timestamp=None):
    event = {"type": kind, "touchPoints": [
        {"x": x, "y": y, "id": index, "radiusX": 5, "radiusY": 5, "force": 1}
        for index, (x, y) in enumerate(points)]}
    if timestamp is not None:
        event["timestamp"] = timestamp
    cdp.send("Input.dispatchTouchEvent", event)


def move_touches(page, cdp, start, end, steps=10):
    for step in range(1, steps + 1):
        page.wait_for_timeout(24)
        send_touch(cdp, "touchMove", [(x + (end[index][0] - x) * step / steps,
            y + (end[index][1] - y) * step / steps) for index, (x, y) in enumerate(start)])


def gesture(page, cdp, start, end):
    send_touch(cdp, "touchStart", start)
    move_touches(page, cdp, start, end)
    send_touch(cdp, "touchEnd", [])
    page.wait_for_function("!map.isMoving()")


def camera(page):
    return page.evaluate("({center:map.getCenter().toArray(),zoom:map.getZoom(),pitch:map.getPitch(),bearing:map.getBearing()})")


def same_center(before, after):
    assert all(abs(a - b) < 1e-8 for a, b in zip(before["center"], after["center"])), (before, after)


def pair_at(radius, degrees, center=(190, 420)):
    radians = math.radians(degrees)
    x, y = radius * math.cos(radians), radius * math.sin(radians)
    return [(center[0] - x, center[1] - y), (center[0] + x, center[1] + y)]


def zoom_without_rotation(page, cdp, samples, hold_ms=0):
    """Check every camera update, including drift while a pinch reverses."""
    before = camera(page)
    page.evaluate("""() => {
        window.pinchCameraSamples=[];
        window.recordPinchCamera=()=>pinchCameraSamples.push({
            center:map.getCenter().toArray(),pitch:map.getPitch(),bearing:map.getBearing()});
        map.on('move',recordPinchCamera);
    }""")
    send_touch(cdp, "touchStart", samples[0])
    if hold_ms:
        page.wait_for_timeout(hold_ms)
    released = False
    try:
        for points in samples[1:]:
            page.wait_for_timeout(24)
            send_touch(cdp, "touchMove", points)
            page.wait_for_timeout(24)
            after = camera(page)
            same_center(before, after)
            assert abs(after["pitch"] - before["pitch"]) < .01, (before, after)
            assert abs(after["bearing"] - before["bearing"]) < .01, (before, after)
        send_touch(cdp, "touchEnd", [])
        released = True
        page.wait_for_function("!map.isMoving()")
        for sample in page.evaluate("pinchCameraSamples"):
            same_center(before, sample)
            assert abs(sample["pitch"] - before["pitch"]) < .01, (before, sample)
            assert abs(sample["bearing"] - before["bearing"]) < .01, (before, sample)
    finally:
        # Release real contacts even when an assertion reproduces a regression.
        if not released:
            send_touch(cdp, "touchEnd", [])
        page.evaluate("map.off('move',recordPinchCamera)")
    return before, camera(page)


def turn_then_zoom(page, cdp, samples, hold_ms=0):
    """A real turn may precede pinch; preserve it and rebase the zoom origin."""
    before = camera(page)
    send_touch(cdp, "touchStart", samples[0])
    if hold_ms:
        page.wait_for_timeout(hold_ms)
    released = False
    handover = None
    turned = False
    previous = before
    try:
        for index, points in enumerate(samples[1:], 1):
            page.wait_for_timeout(24)
            send_touch(cdp, "touchMove", points)
            page.wait_for_timeout(24)
            current = camera(page)
            same_center(before, current)
            assert abs(current["pitch"] - before["pitch"]) < .01, (before, current)
            separation = math.dist(*points)
            if handover is not None:
                assert abs(current["bearing"] - handover["bearing"]) < .01, (handover, current)
                expected = handover["zoom"] + math.log2(separation / handover["separation"])
                assert abs(current["zoom"] - expected) < .01, (handover, current, expected)
            elif abs(current["zoom"] - before["zoom"]) > .01:
                # Handover keeps the last rendered turn rather than jumping to
                # the camera bearing/scale from the start of this contact pair.
                assert turned, (samples, before, current)
                assert abs(current["bearing"] - previous["bearing"]) < .01, (previous, current)
                handover = {**current, "separation": separation, "index": index}
            elif abs(current["bearing"] - before["bearing"]) > 1:
                initial_angle = math.degrees(math.atan2(samples[0][1][1] - samples[0][0][1],
                    samples[0][1][0] - samples[0][0][0]))
                current_angle = math.degrees(math.atan2(points[1][1] - points[0][1],
                    points[1][0] - points[0][0]))
                # Clockwise screen motion decreases MapLibre bearing.
                assert (current["bearing"] - before["bearing"]) * (current_angle - initial_angle) < 0, (before, current)
                turned = True
            previous = current
        assert handover is not None and handover["index"] < len(samples) - 2, (samples, handover)
        send_touch(cdp, "touchEnd", [])
        released = True
        page.wait_for_function("!mapTouchActive && !map.isMoving() && map.dragPan.isEnabled()")
        after = camera(page)
        same_center(before, after)
        assert abs(after["bearing"] - previous["bearing"]) < .01, (previous, after)
        assert abs(after["zoom"] - previous["zoom"]) < .01, (previous, after)
        assert abs(after["pitch"] - before["pitch"]) < .01, (before, after)
        return before, after
    finally:
        if not released:
            send_touch(cdp, "touchEnd", [])


def pan_one_finger(page, cdp):
    before = camera(page)
    gesture(page, cdp, [(150, 410)], [(215, 440)])
    after = camera(page)
    assert any(abs(a - b) > 1e-5 for a, b in zip(before["center"], after["center"])), (before, after)
    assert abs(before["pitch"] - after["pitch"]) < .01


def rotation_without_zoom(page, cdp, samples, degrees, fast=False, live=True):
    """A short natural arc must rotate, without scale, pitch or pan changes."""
    page.evaluate("""() => {
        map.jumpTo({center:[30.32,59.9],zoom:15,pitch:29,bearing:37});
        window.shortTurnSamples=[];window.shortTurnTimes=[];
        window.recordShortTurn=()=>shortTurnSamples.push({
            center:map.getCenter().toArray(),zoom:map.getZoom(),
            pitch:map.getPitch(),bearing:map.getBearing()});
        window.recordShortTurnTouch=event=>{
            if(event.type==='touchstart' && event.touches.length===2)
                shortTurnTimes.push({type:'start',time:event.timeStamp});
            if(event.type==='touchmove')shortTurnTimes.push({type:'move',time:event.timeStamp});
        };
        map.on('move',recordShortTurn);
        window.addEventListener('touchstart',recordShortTurnTouch,true);
        window.addEventListener('touchmove',recordShortTurnTouch,true);
    }""")
    before = camera(page)
    epoch = time.time() if fast else None
    send_touch(cdp, "touchStart", samples[0], timestamp=epoch)
    released = False
    try:
        for index, points in enumerate(samples[1:], 1):
            if not fast:
                page.wait_for_timeout(24)
            send_touch(cdp, "touchMove", points,
                       timestamp=epoch + index * .02 if fast else None)
            if not fast:
                page.wait_for_timeout(24)
                current = camera(page)
                same_center(before, current)
                assert abs(current["zoom"] - before["zoom"]) < .01, (degrees, before, current)
                assert abs(current["pitch"] - before["pitch"]) < .01, (degrees, before, current)
        if live and not fast:
            assert abs(camera(page)["bearing"] - before["bearing"]) > 5, (degrees, before, camera(page))
        send_touch(cdp, "touchEnd", [],
                   timestamp=epoch + len(samples) * .02 if fast else None)
        released = True
        page.wait_for_function("!mapTouchActive && !map.isMoving() && map.dragPan.isEnabled()")
        after = camera(page)
        same_center(before, after)
        # MapLibre bearing has the opposite sign to rotation on the screen.
        # Its small activation slop may discard the first sub-threshold sample.
        assert abs(after["bearing"] - (before["bearing"] - degrees)) <= 4, (degrees, before, after)
        for current in page.evaluate("shortTurnSamples"):
            same_center(before, current)
            assert abs(current["zoom"] - before["zoom"]) < .01, (degrees, before, current)
            assert abs(current["pitch"] - before["pitch"]) < .01, (degrees, before, current)
        if fast:
            times = page.evaluate("shortTurnTimes")
            assert times and 0 < times[-1]["time"] - times[0]["time"] < 120, times
    finally:
        if not released:
            send_touch(cdp, "touchEnd", [])
        page.evaluate("""() => {
            map.off('move',recordShortTurn);
            window.removeEventListener('touchstart',recordShortTurnTouch,true);
            window.removeEventListener('touchmove',recordShortTurnTouch,true);
        }""")


def reconcile_release(page, cdp, name, samples, actual, expected, simultaneous=False, changes_camera=True):
    """Synthetic release corrects predicted moves; contact setup/cleanup are CDP.

    CDP cannot otherwise provide different final pointer-up coordinates. The
    Android MotionEvent probe independently exercises actual OS resampling.
    """
    page.evaluate("""() => {
        map.jumpTo({center:[30.32,59.9],zoom:15,pitch:29,bearing:37});
        window.releaseTouchIds=[];window.releaseMovePoints=[];
        window.recordReleaseTouches=event=>{
            if(event.touches.length!==2)return;
            releaseTouchIds=Array.from(event.touches,touch=>touch.identifier);
            if(event.type==='touchmove')releaseMovePoints=Array.from(event.touches,
                touch=>[touch.clientX,touch.clientY]);
        };
        window.addEventListener('touchstart',recordReleaseTouches,true);
        window.addEventListener('touchmove',recordReleaseTouches,true);
    }""")
    before = camera(page)
    send_touch(cdp, "touchStart", samples[0])
    try:
        page.wait_for_function("mapTouchActive && releaseTouchIds.length===2")
        for points in samples[1:]:
            page.wait_for_timeout(24)
            send_touch(cdp, "touchMove", points)
        page.wait_for_function("""expected => releaseMovePoints.length===2 &&
            releaseMovePoints.every((point,index)=>point.every((coordinate,axis)=>
                Math.abs(coordinate-expected[index][axis])<.1))""", arg=samples[-1])
        predicted = camera(page)
        if changes_camera:
            assert any(abs(predicted[key] - value) > .02 for key, value in expected.items()), (name, predicted, expected)
        trusted = page.evaluate("""value => {
            const target=map.getCanvas();
            const points=value.points.map((point,index)=>new Touch({
                identifier:releaseTouchIds[index],target,
                clientX:point[0],clientY:point[1],pageX:point[0],pageY:point[1],
                screenX:point[0],screenY:point[1],radiusX:5,radiusY:5,force:1}));
            const surviving=value.simultaneous?[]:[points[0]];
            const released=value.simultaneous?points:[points[1]];
            const event=new TouchEvent('touchend',{bubbles:true,cancelable:true,
                touches:surviving,targetTouches:surviving,changedTouches:released});
            target.dispatchEvent(event);
            if(!value.simultaneous){
                // Supply the raw surviving coordinate before removing genuine
                // CDP contacts, whose stored positions are still predictions.
                const finalEvent=new TouchEvent('touchend',{bubbles:true,cancelable:true,
                    touches:[],targetTouches:[],changedTouches:[points[0]]});
                target.dispatchEvent(finalEvent);
                return event.isTrusted||finalEvent.isTrusted;
            }
            return event.isTrusted;
        }""", {"points": actual, "simultaneous": simultaneous})
        assert trusted is False, "This controlled end fixture must not be described as trusted input"
        reconciled = camera(page)
        same_center(before, reconciled)
        wanted = {"zoom": 15, "pitch": 29, "bearing": 37, **expected}
        for key, value in wanted.items():
            assert abs(reconciled[key] - value) < .01, (name, predicted, reconciled, wanted)
    finally:
        # Release the genuine Chromium contacts as well, including after a failed
        # synthetic correction. No contact may leak into the next regression.
        send_touch(cdp, "touchEnd", [])
        page.wait_for_function("!mapTouchActive && map.dragPan.isEnabled()")
        page.evaluate("""() => {
            window.removeEventListener('touchstart',recordReleaseTouches,true);
            window.removeEventListener('touchmove',recordReleaseTouches,true);
        }""")
    for key, value in wanted.items():
        assert abs(camera(page)[key] - value) < .01, (name, camera(page), wanted)


def reconcile_two_stage_release(page, cdp, move_survivor=False, restart_pair=False):
    """Model Android's stale surviving Touch followed by its own raw end."""
    samples = [pair_at(70, angle) for angle in [0, 18, 27, 37.4]]
    actual = pair_at(70, 35)
    page.evaluate("""() => {
        map.jumpTo({center:[30.32,59.9],zoom:15,pitch:29,bearing:37});
        window.stagedIds=[];window.stagedMovePoints=[];
        window.recordStagedRelease=event=>{
            if(event.touches.length!==2)return;
            stagedIds=Array.from(event.touches,touch=>touch.identifier);
            if(event.type==='touchmove')stagedMovePoints=Array.from(event.touches,
                touch=>[touch.clientX,touch.clientY]);
        };
        window.addEventListener('touchstart',recordStagedRelease,true);
        window.addEventListener('touchmove',recordStagedRelease,true);
    }""")
    before = camera(page)
    send_touch(cdp, "touchStart", samples[0])
    try:
        page.wait_for_function("mapTouchActive && stagedIds.length===2")
        for points in samples[1:]:
            page.wait_for_timeout(24)
            send_touch(cdp, "touchMove", points)
        page.wait_for_function("""expected=>stagedMovePoints.length===2 &&
            stagedMovePoints.every((point,index)=>point.every((coordinate,axis)=>
                Math.abs(coordinate-expected[index][axis])<.1))""", arg=samples[-1])
        states = page.evaluate("""value => {
            const target=map.getCanvas();
            const touch=(index,point,identifier=stagedIds[index])=>new Touch({identifier,target,
                clientX:point[0],clientY:point[1],pageX:point[0],pageY:point[1],
                screenX:point[0],screenY:point[1],radiusX:5,radiusY:5,force:1});
            const dispatch=(type,touches,changed)=>{
                const event=new TouchEvent(type,{bubbles:true,cancelable:true,
                    touches,targetTouches:touches,changedTouches:changed});
                target.dispatchEvent(event);return event.isTrusted;
            };
            const snapshot=()=>({center:map.getCenter().toArray(),zoom:map.getZoom(),
                pitch:map.getPitch(),bearing:map.getBearing()});
            const trusted=[];
            // First pointer-up gives only the lifted finger's raw coordinate.
            // The surviving Touch still contains its last predicted position.
            trusted.push(dispatch('touchend',[touch(0,value.predicted[0])],
                [touch(1,value.actual[1])]));
            const first=snapshot();
            let remaining=value.actual[0];
            let newcomer=null;
            if(value.restart){
                newcomer=touch(1,[300,490],99);
                trusted.push(dispatch('touchstart',[touch(0,remaining),newcomer],[newcomer]));
            }
            if(value.move||value.restart){
                remaining=[remaining[0]+60,remaining[1]+25];
                const moved=touch(0,remaining);
                if(newcomer)newcomer=touch(1,[320,470],99);
                const moving=newcomer?[moved,newcomer]:[moved];
                trusted.push(dispatch('touchmove',moving,moving));
            }
            const afterMove=snapshot();
            trusted.push(dispatch('touchend',newcomer?[newcomer]:[],[touch(0,remaining)]));
            if(newcomer)trusted.push(dispatch('touchend',[],[newcomer]));
            return {first,afterMove,final:snapshot(),trusted};
        }""", {"predicted": samples[-1], "actual": actual, "move": move_survivor, "restart": restart_pair})
        assert not any(states["trusted"]), "Two-stage correction is a controlled DOM fixture"
        for state in [states["first"], states["afterMove"], states["final"]]:
            same_center(before, state)
            assert abs(state["zoom"] - 15) < .01, states
            assert abs(state["pitch"] - 29) < .01, states
        if move_survivor or restart_pair:
            # Once the survivor moved or a new contact joined, later positions
            # cannot describe the original pair at release. Keep all subsequent
            # input blocked; do not resurrect a turn from two different moments.
            assert states["afterMove"] == states["first"], states
            assert states["final"] == states["first"], states
        else:
            assert abs(states["final"]["bearing"] - 2) < .01, states
            assert abs(states["first"]["bearing"] - 2) > .2, states
    finally:
        send_touch(cdp, "touchEnd", [])
        page.wait_for_function("!mapTouchActive && map.dragPan.isEnabled()")
        page.evaluate("""() => {
            window.removeEventListener('touchstart',recordStagedRelease,true);
            window.removeEventListener('touchmove',recordStagedRelease,true);
        }""")
    assert abs(camera(page)["bearing"] - states["final"]["bearing"]) < .01


def visible_basemap_layers(page, theme):
    return page.evaluate("""theme => map.getStyle().layers
        .filter(layer=>layer.id.startsWith('base-'+theme+':') && map.getLayoutProperty(layer.id,'visibility')!=='none').length""", theme)


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
                is_mobile=True, has_touch=True, device_scale_factor=2)
            context.route("**/*", lambda route: route.continue_() if route.request.url.startswith(origin) else route.abort())
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(origin)
            wait_for_map(page)
            page.evaluate("closeSheet()")
            # mapReady precedes the startup overlay's exit animation. Touches
            # sent through that overlay never reach the map handler.
            page.locator("#loading").wait_for(state="hidden")
            page.wait_for_function("() => map.getCanvasContainer().contains(document.elementFromPoint(140,460))")
            assert page.evaluate("state.mode") == "2d"
            assert page.evaluate("!map.touchPitch.isEnabled() && !map.touchZoomRotate.isEnabled()")
            page.evaluate("""() => {
                map.jumpTo({center:[30.32,59.9],zoom:15});
                window.touchPitchStarts=0;window.trustedTouchStarts=0;
                map.on('pitchstart',()=>touchPitchStarts++);
                window.addEventListener('touchstart',event=>{
                    if(event.isTrusted && event.touches.length===2) trustedTouchStarts++;
                },true);
            }""")
            cdp = context.new_cdp_session(page)
            initial = camera(page)
            gesture(page, cdp, [(140, 460), (240, 460)], [(140, 370), (240, 370)])
            assert page.evaluate("trustedTouchStarts") >= 1
            assert page.evaluate("touchPitchStarts") >= 1, {"camera": camera(page), "errors": errors}
            gesture_angle = page.evaluate("map.getPitch()")
            assert 15 < gesture_angle <= 60, {"pitch": gesture_angle,
                "intent": page.evaluate("pitchController.intent"), "mode": page.evaluate("state.mode")}
            assert page.evaluate("state.mode") == "3d"
            assert abs(page.evaluate("map.getZoom()") - 15) < .1
            same_center(initial, camera(page))

            # Unequal finger heights and a delayed second finger still tilt.
            page.evaluate("map.jumpTo({pitch:0})")
            send_touch(cdp, "touchStart", [(120, 370)])
            page.wait_for_timeout(40)
            send_touch(cdp, "touchStart", [(120, 370), (220, 500)])
            send_touch(cdp, "touchMove", [(120, 340), (220, 500)])
            page.wait_for_timeout(150)
            move_touches(page, cdp, [(120, 340), (220, 500)], [(120, 280), (220, 410)])
            send_touch(cdp, "touchEnd", [])
            page.wait_for_function("!map.isMoving()")
            assert page.evaluate("map.getPitch()") > 25, camera(page)
            same_center(initial, camera(page))

            # Pair translation never pans, including its remaining single finger.
            before = camera(page)
            gesture(page, cdp, [(120, 400), (230, 430)], [(170, 400), (280, 430)])
            assert camera(page) == before
            send_touch(cdp, "touchStart", [(140, 400), (240, 400)])
            send_touch(cdp, "touchEnd", [(140, 400)])
            move_touches(page, cdp, [(140, 400)], [(220, 470)])
            send_touch(cdp, "touchEnd", [])
            assert camera(page) == before

            # Pinch and rotation alter their own axes around the fixed map centre.
            page.evaluate("map.jumpTo({pitch:0,bearing:0,zoom:15})")
            before = camera(page)
            gesture(page, cdp, [(140, 420), (240, 420)], [(90, 420), (290, 420)])
            after = camera(page)
            same_center(before, after)
            assert abs(after["zoom"] - 16) < .01, after
            assert abs(after["pitch"]) < .01
            assert abs(after["bearing"]) < .01

            # Natural pinch trajectories have unequal finger travel and angular
            # wobble. Bearing/pitch must remain fixed at every intermediate frame.
            page.evaluate("map.jumpTo({pitch:29,bearing:37,zoom:15})")
            before, after = zoom_without_rotation(page, cdp, [
                pair_at(radius, degrees, (190 + index * .7, 420 - index * .4))
                for index, (radius, degrees) in enumerate([
                    (70, 35), (75, 35.8), (81, 36.5), (88, 37),
                    (96, 38.4), (105, 39), (115, 40)])])
            assert abs(after["zoom"] - (before["zoom"] + math.log2(115 / 70))) < .01
            before, after = zoom_without_rotation(page, cdp, [
                pair_at(radius, degrees, (190 - index * .6, 420 + index * .5))
                for index, (radius, degrees) in enumerate([
                    (115, 60), (107, 59.3), (99, 58.5), (90, 57.8),
                    (82, 57), (73, 56), (65, 55)])])
            assert abs(after["zoom"] - (before["zoom"] + math.log2(65 / 115))) < .01

            # Once zoom starts, later wobble and a reversal cannot turn it into
            # rotation, even if angular drift becomes larger than its start slop.
            before, after = zoom_without_rotation(page, cdp, [
                pair_at(radius, degrees, (190 + index * .4, 420 + index * .2))
                for index, (radius, degrees) in enumerate([
                    (65, 20), (72, 20.5), (82, 21), (96, 23), (110, 27),
                    (118, 32), (108, 35), (96, 30), (86, 24), (76, 18)])])
            assert abs(after["zoom"] - (before["zoom"] + math.log2(76 / 65))) < .01

            # A pure angular lead is already a real turn. If the user then
            # separates the fingers, switch to zoom without undoing that turn;
            # after handover angular drift/reversal cannot rotate the map.
            for samples in [
                [(70, 0), (70, 7), (70, 13), (73, 14), (80, 15),
                 (90, 16), (105, 16), (120, 17)],
                [(22, 25), (22, 33), (22, 39), (24, 40), (28, 41),
                 (34, 42), (43, 43), (55, 44)],
            ]:
                page.evaluate("map.jumpTo({pitch:29,bearing:37,zoom:15})")
                turn_then_zoom(page, cdp,
                    [pair_at(radius, degrees) for radius, degrees in samples])

            # One stationary fingertip may anchor a real turn and subsequent
            # pinch. Holding still must not prevent either gesture or cause an
            # orientation reset when the pinch takes over.
            anchored = []
            for radius, degrees in [(90, 0), (90, 7), (90, 14), (95, 15),
                                    (105, 16), (120, 17), (140, 18)]:
                radians = math.radians(degrees)
                anchored.append([(225 - radius * math.cos(radians),
                                  450 - radius * math.sin(radians)), (225, 450)])
            page.evaluate("map.jumpTo({pitch:29,bearing:37,zoom:15})")
            turn_then_zoom(page, cdp, anchored, hold_ms=260)

            # A common vertical lead can legitimately tilt before the pinch is
            # clear. It must not promote that tilt into a permanent rotation
            # lock once separation starts growing with angular finger drift.
            page.evaluate("map.jumpTo({pitch:29,bearing:37,zoom:15})")
            before = camera(page)
            page.evaluate("""() => {
                window.tiltPinchBearings=[];
                window.recordTiltPinch=()=>tiltPinchBearings.push(map.getBearing());
                map.on('move',recordTiltPinch);
            }""")
            tilt_pinch = [pair_at(70, 0), pair_at(70, 0, (190, 410)),
                pair_at(73, 27, (190, 407)), pair_at(82, 28, (190, 403)),
                pair_at(96, 29, (190, 400)), pair_at(115, 30, (190, 397))]
            send_touch(cdp, "touchStart", tilt_pinch[0])
            tilt_released = False
            try:
                for points in tilt_pinch[1:]:
                    page.wait_for_timeout(24)
                    send_touch(cdp, "touchMove", points)
                    page.wait_for_timeout(24)
                    assert abs(camera(page)["bearing"] - before["bearing"]) < .01
                send_touch(cdp, "touchEnd", [])
                tilt_released = True
                page.wait_for_function("!map.isMoving()")
                assert all(abs(value - before["bearing"]) < .01
                           for value in page.evaluate("tiltPinchBearings"))
                after = camera(page)
                same_center(before, after)
                assert abs(after["zoom"] - (before["zoom"] + math.log2(115 / 70))) < .01
                assert abs(after["pitch"] - before["pitch"]) < .01
            finally:
                if not tilt_released:
                    send_touch(cdp, "touchEnd", [])
                page.evaluate("map.off('move',recordTiltPinch)")

            # Ordinary and fine turns both provide visible feedback while
            # fingers are down; neither may first appear only on release.
            for direction in [1, -1]:
                rotation_without_zoom(page, cdp,
                    [pair_at(70, direction * angle) for angle in range(0, 19, 3)],
                    direction * 18)
                rotation_without_zoom(page, cdp,
                    [pair_at(70, direction * angle) for angle in range(0, 13, 3)],
                    direction * 12)

            # Real hardware can deliver a whole turn in less than the former
            # 120-ms gate. Explicit trusted CDP timestamps keep that path stable
            # even when a busy CI machine takes longer to deliver the commands.
            rotation_without_zoom(page, cdp,
                [pair_at(70, 0), pair_at(70, 35)], 35, fast=True)

            # Angular motion dominates a real arc even if finger separation is
            # not perfect. A cumulative 9% span change must not permanently arm
            # zoom when each step travels mostly tangentially.
            rotation_without_zoom(page, cdp, [
                pair_at(radius, angle, (190 + index * .25, 420 - index * .2))
                for index, (radius, angle) in enumerate([
                    (70, 0), (71.4, 10), (73.5, 20), (75.6, 30),
                    (76.3, 40), (75.6, 50), (74.9, 60)])], 60)

            # One fingertip can anchor a short turn. The other fingertip's
            # movement must not be discarded merely because min(lengths)==0.
            anchored_turn = [[(225 - 100 * math.cos(math.radians(angle)),
                                450 - 100 * math.sin(math.radians(angle))), (225, 450)]
                             for angle in range(0, 19, 3)]
            rotation_without_zoom(page, cdp, anchored_turn, 18)

            # OS move prediction can overshoot the final coordinates supplied
            # on release. Resolve each established axis from touches plus
            # changedTouches instead of retaining a predicted move sample.
            reconcile_release(page, cdp, "rotation overshoot",
                [pair_at(70, angle) for angle in [0, 18, 27, 37.4]],
                pair_at(70, 35), {"bearing": 2})
            reconcile_release(page, cdp, "zoom overshoot",
                [pair_at(radius, 0) for radius in [70, 80, 95, 110]],
                pair_at(100, 0), {"zoom": 15 + math.log2(100 / 70)}, simultaneous=True)
            reconcile_release(page, cdp, "pitch overshoot",
                [[(140, y), (240, y)] for y in [460, 430, 410]],
                [(140, 420), (240, 420)], {"pitch": 47})
            reconcile_release(page, cdp, "fine turn overshoot",
                [pair_at(70, angle) for angle in [0, 7, 13]],
                pair_at(70, 10), {"bearing": 27}, simultaneous=True)

            # The correction itself is radial, but it is not a new pinch. A
            # predicted radius increase followed by accurate end coordinates
            # must not switch an established rotation into zoom at release.
            reconcile_release(page, cdp, "radial prediction correction",
                [pair_at(70, 0), pair_at(70, 18), pair_at(70, 27), pair_at(75, 35)],
                pair_at(70, 35), {"bearing": 2}, changes_camera=False)
            reconcile_two_stage_release(page, cdp)
            reconcile_two_stage_release(page, cdp, move_survivor=True)
            reconcile_two_stage_release(page, cdp, restart_pair=True)

            # Intentional rotation follows an arc with constant separation. A
            # straight chord between endpoints would accidentally test a pinch.
            page.evaluate("map.jumpTo({pitch:0,bearing:0,zoom:16})")
            before = camera(page)
            send_touch(cdp, "touchStart", pair_at(70, 0))
            for degrees in range(5, 91, 5):
                page.wait_for_timeout(24)
                send_touch(cdp, "touchMove", pair_at(70, degrees))
                page.wait_for_timeout(24)
                same_center(before, camera(page))
                assert abs(page.evaluate("map.getZoom()") - before["zoom"]) < .01
                assert abs(page.evaluate("map.getPitch()") - before["pitch"]) < .01
            send_touch(cdp, "touchEnd", [])
            page.wait_for_function("!map.isMoving()")
            after = camera(page)
            same_center(before, after)
            assert abs(after["bearing"] + 90) < .01, after
            assert abs(after["zoom"] - before["zoom"]) < .01
            assert abs(after["pitch"]) < .01

            # A real intentional turn is not a perfect geometric circle. Radius
            # jitter of +/-2% and a small shared fingertip drift must still allow
            # clockwise AND counterclockwise rotation without zoom, tilt or pan.
            for direction in [1, -1]:
                page.evaluate("map.jumpTo({pitch:29,bearing:37,zoom:15})")
                before = camera(page)
                send_touch(cdp, "touchStart", pair_at(70, 0))
                wobble_released = False
                try:
                    for index in range(1, 19):
                        radius = 70 * (1 + (.02 if index % 2 else -.02))
                        points = pair_at(radius, direction * index * 5,
                            (190 + index * .2, 420 - index * .15))
                        page.wait_for_timeout(24)
                        send_touch(cdp, "touchMove", points)
                        page.wait_for_timeout(24)
                        current = camera(page)
                        same_center(before, current)
                        assert abs(current["zoom"] - before["zoom"]) < .01, (direction, index, before, current)
                        assert abs(current["pitch"] - before["pitch"]) < .01, (direction, index, before, current)
                    send_touch(cdp, "touchEnd", [])
                    wobble_released = True
                    page.wait_for_function("!mapTouchActive && !map.isMoving() && map.dragPan.isEnabled()")
                    after = camera(page)
                    same_center(before, after)
                    assert abs(after["bearing"] - (before["bearing"] - direction * 90)) < .01, (direction, before, after)
                finally:
                    if not wobble_released:
                        send_touch(cdp, "touchEnd", [])

            # A clear pinch after an established turn retains that orientation,
            # rebases scale at handover and locks the zoom axis through reversal.
            page.evaluate("map.jumpTo({pitch:29,bearing:37,zoom:15})")
            turn_then_zoom(page, cdp,
                [pair_at(70, degrees) for degrees in range(0, 36, 5)] +
                [pair_at(radius, degrees) for radius, degrees in
                 [(75, 36), (85, 38), (100, 42), (92, 45), (82, 40)]])

            # An asymmetric vertical pinch is not left as an accidental tilt.
            page.evaluate("map.jumpTo({pitch:17,bearing:0,zoom:15})")
            before = camera(page)
            gesture(page, cdp, [(190, 350), (190, 450)], [(190, 330), (190, 370)])
            after = camera(page)
            same_center(before, after)
            assert abs(after["zoom"] - (15 + math.log2(.4))) < .01, after
            assert abs(after["pitch"] - 17) < .01, after

            # Three fingers, and a third joining a pair, block the entire gesture.
            before = camera(page)
            gesture(page, cdp, [(100, 380), (190, 420), (280, 460)],
                    [(70, 290), (190, 330), (310, 370)])
            assert camera(page) == before
            send_touch(cdp, "touchStart", [(120, 400), (230, 400)])
            send_touch(cdp, "touchStart", [(120, 400), (230, 400), (300, 460)])
            send_touch(cdp, "touchEnd", [(120, 400), (230, 400)])
            move_touches(page, cdp, [(120, 400), (230, 400)], [(120, 310), (230, 310)])
            send_touch(cdp, "touchEnd", [])
            page.wait_for_function("!mapTouchActive && map.dragPan.isEnabled()")
            assert camera(page) == before
            assert page.evaluate("map.dragPan.isEnabled()")
            pan_one_finger(page, cdp)

            # Cancellation restores fresh one-finger panning as well.
            send_touch(cdp, "touchStart", [(120, 400), (230, 400)])
            page.wait_for_function("mapTouchActive && !map.dragPan.isEnabled()")
            send_touch(cdp, "touchCancel", [])
            page.wait_for_function("!mapTouchActive && map.dragPan.isEnabled()")
            assert page.evaluate("map.dragPan.isEnabled()")
            pan_one_finger(page, cdp)
            page.evaluate("map.jumpTo({center:[30.32,59.9],zoom:15,pitch:38,bearing:0})")
            gesture_angle = page.evaluate("map.getPitch()")

            # A gesture-selected angle stays unchanged through animated zoom.
            page.evaluate("map.zoomTo(12,{duration:240})")
            page.wait_for_function("!map.isMoving()")
            assert abs(page.evaluate("map.getPitch()") - gesture_angle) < .01
            assert page.evaluate("state.mode") == "3d"
            page.evaluate("map.zoomTo(15,{duration:240})")
            page.wait_for_function("!map.isMoving()")
            assert abs(page.evaluate("map.getPitch()") - gesture_angle) < .5

            # Explicit 45 degrees stays 45, including a restart while zoomed out.
            page.evaluate("map.jumpTo({pitch:45});map.zoomTo(12,{duration:240})")
            page.wait_for_function("!map.isMoving()")
            assert abs(page.evaluate("map.getPitch()") - 45) < .01
            page.reload()
            wait_for_map(page)
            assert page.evaluate("state.mode") == "3d"
            assert abs(page.evaluate("map.getPitch()") - 45) < .01
            page.evaluate("map.zoomTo(15,{duration:240})")
            page.wait_for_function("!map.isMoving()")
            assert abs(page.evaluate("map.getPitch()") - 45) < .1

            # Both vector themes reuse one source and preserve the current camera.
            assert page.evaluate("map.getStyle().sources.openmaptiles.type") == "vector"
            assert visible_basemap_layers(page, "light") > 20
            assert visible_basemap_layers(page, "dark") == 0
            assert page.evaluate("map.getStyle().layers.some(layer=>layer.type==='symbol' && (JSON.stringify(layer.layout?.['text-field'])||'').includes('name:ru'))")
            before = page.evaluate("({center:map.getCenter().toArray(),zoom:map.getZoom(),pitch:map.getPitch(),bearing:map.getBearing()})")
            page.evaluate("() => {window.originalVectorSource=map.getSource('openmaptiles')}")
            open_panel(page, "settings")
            assert page.locator("#base-dark").is_hidden()
            assert page.locator("#base-light").is_hidden()
            page.locator('#theme-options button[data-theme="dark"]').click()
            assert page.evaluate("document.documentElement.dataset.theme") == "dark"
            assert visible_basemap_layers(page, "dark") > 20
            assert visible_basemap_layers(page, "light") == 0
            assert page.evaluate("map.getSource('openmaptiles')===originalVectorSource")
            assert page.evaluate("({center:map.getCenter().toArray(),zoom:map.getZoom(),pitch:map.getPitch(),bearing:map.getBearing()})") == before
            page.locator('#theme-options button[data-theme="light"]').click()
            assert page.evaluate("document.documentElement.dataset.theme") == "light"
            assert visible_basemap_layers(page, "light") > 20
            assert visible_basemap_layers(page, "dark") == 0

            page.locator("#mode-2d").click()
            page.locator("#settings-back").click()
            page.wait_for_function("!map.isMoving()")
            page.evaluate("map.zoomTo(12,{duration:120})")
            page.wait_for_function("!map.isMoving()")
            page.evaluate("map.zoomTo(15,{duration:120})")
            page.wait_for_function("!map.isMoving()")
            assert page.evaluate("map.getPitch()") < .01
            assert page.evaluate("state.mode") == "2d"
            page.evaluate("map.remove()")
            page.wait_for_timeout(50)
            assert not errors, errors
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print("Map gestures OK: pinch guards, short/fine/fast/anchored/noisy rotation, controlled release correction, trusted staggered tilt, no pair pan or three-finger controls, recovery and stable pitch")


if __name__ == "__main__":
    main()
