"""Route planning UI with real app/MapLibre and synthetic provider responses; no live network."""
import argparse
from copy import deepcopy
from datetime import datetime, timezone
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
import threading
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright
from test_browser import QuietHandler, wait_for_map
from test_map_gestures_browser import camera, gesture


ROAD = {"code": "Ok", "routes": [{"duration": 615, "distance": 1500,
    "geometry": {"type": "LineString", "coordinates": [[30.32, 59.85], [30.335, 59.855], [30.33, 59.86]]}},
    {"duration": 780, "distance": 1800, "geometry": {"type": "LineString", "coordinates": [[30.32, 59.85], [30.36, 59.879], [30.33, 59.86]]}}]}
TRANSIT = {"success": True, "result": [{"sumTime": 1200, "sumDistance": 4200, "numTransfers": 0, "startTime": "2026-11-18T10:00:00", "endTime": "2026-11-18T10:20:00", "stages": [
    {"type": "walk", "time": 120, "distance": 100, "path": [{"longitude": 30.32, "latitude": 59.85}, {"longitude": 30.312, "latitude": 59.845}, {"longitude": 30.321, "latitude": 59.851}]},
    {"type": "bus", "routeNumber": "26", "time": 1080, "distance": 4100,
     "stops": [{"stopName": "Начальная", "stopLongitude": 30.321, "stopLatitude": 59.851}, {"stopName": "Конечная", "stopLongitude": 30.33, "stopLatitude": 59.86}],
     "path": [{"longitude": 30.321, "latitude": 59.851}, {"longitude": 30.33, "latitude": 59.86}]}]}]}
TRANSFER = deepcopy(TRANSIT["result"][0])
TRANSFER["stages"].append({**deepcopy(TRANSFER["stages"][1]), "type": "subway", "routeNumber": "2"})
TRANSFER["sumTime"] = 1500
# Deliberately wrong API metadata: actual second boarding must still be caught.
TRANSFER["numTransfers"] = 0
TRANSIT["result"].append(TRANSFER)


def assert_route_in_view(page):
    page.wait_for_function("!map.isMoving()")
    view = page.evaluate("""() => {
      const canvas=map.getCanvas().getBoundingClientRect();
      const panel=document.querySelector('#routing-panel').getBoundingClientRect();
      const controls=[...document.querySelectorAll('.bottom-nav,.connection.is-visible,.map-actions,.map-scale')]
        .map(node=>node.getBoundingClientRect()).filter(box=>box.width&&box.height);
      const outside=[];
      for(const feature of map.getSource('route-plan-source')._data.features) {
        if(feature.properties.kind==='stop') continue;
        const points=feature.geometry.type==='LineString'?feature.geometry.coordinates:[feature.geometry.coordinates];
        for(const location of points) {
          const point=map.project(location), x=point.x+canvas.left, y=point.y+canvas.top;
          if(x<canvas.left+2 || x>canvas.right-2 || y<canvas.top+2 || y>panel.top-2 ||
            controls.some(box=>x>=box.left&&x<=box.right&&y>=box.top&&y<=box.bottom)) outside.push({location,x,y});
        }
      }
      return {outside,panelTop:panel.top,canvasHeight:canvas.height};
    }""")
    assert not view["outside"], view


def assert_vehicle_layer_order(page):
    order = page.evaluate("map.getStyle().layers.map(layer=>layer.id)")
    route_lines = [order.index(f"route-plan-{layer}") for layer in ["casing", "line", "walk"]]
    vehicles = [
        order.index(f"module-spb-live:{kind}-{layer}")
        for kind in ["bus", "tram", "trolley"]
        for layer in ["point", "vehicle-icon", "label"]
    ]
    assert max(route_lines) < min(vehicles), "Every route line must be under the vehicles and their numbers"
    assert max(vehicles) < order.index("route-plan-stops") < order.index("route-plan-endpoints") < order.index("selected-location")


def assert_cards_visible(page):
    visible = page.locator(".routing-options").evaluate("""rail => {
      const clip=rail.getBoundingClientRect(), form=rail.closest('form').getBoundingClientRect();
      const card=rail.querySelector('.routing-option'), box=card.getBoundingClientRect();
      const inside=(rect,outer)=>rect.top>=outer.top-.1 && rect.bottom<=outer.bottom+.1;
      const modes=document.querySelector('.routing-modes').getBoundingClientRect();
      return {viewport:[innerWidth,innerHeight],form:{top:form.top,bottom:form.bottom,height:form.height},modesBox:{top:modes.top,bottom:modes.bottom,height:modes.height},railHeight:clip.height,cardHeight:box.height,inside:inside(box,clip),inForm:inside(box,form),
        children:[...card.querySelectorAll('.routing-option-top,.routing-option-meta,.routing-option-legs')].every(node=>{
          const rect=node.getBoundingClientRect();return inside(rect,clip) && inside(rect,form);
        }),modes:inside(modes,form),
        endpoints:[...document.querySelectorAll('.routing-field')].every(node=>inside(node.getBoundingClientRect(),form))};
    }""")
    assert all(visible[key] for key in ["inside", "inForm", "children", "modes", "endpoints"]), visible


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--chromium"); parser.add_argument("--screenshot"); args = parser.parse_args()
    assets = Path(__file__).resolve().parents[1] / "app/src/main/assets"
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(assets)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_port}"
    errors, requested, pending = [], [], []
    block = {"value": False}
    transit_reply = {"value": TRANSIT}
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=args.chromium,
                args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
            context = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
            context.add_init_script("""(() => {
              window.locationCalls=0;
              Object.defineProperty(navigator,'geolocation',{configurable:true,value:{getCurrentPosition(resolve){
                locationCalls++;queueMicrotask(()=>resolve({coords:{longitude:30.32,latitude:59.85}}));
              }}});
            })()""")
            def handle(route):
                url = route.request.url
                if url.startswith(origin): route.continue_()
                elif "routing.openstreetmap.de/" in url or "/transit-api-otp/routes" in url:
                    requested.append(url)
                    if block["value"]: pending.append(route)
                    else: route.fulfill(json=transit_reply["value"] if "/transit-api-otp/routes" in url else ROAD)
                elif "photon.komoot.io/api/" in url:
                    from urllib.parse import urlparse, parse_qs
                    query = parse_qs(urlparse(url).query)["q"][0]
                    route.fulfill(json={"features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[30.34,59.87]},"properties":{"name":query+" выбран","city":"Петербург"}}]})
                elif "/api/visary/geometry/vehicle?" in url:
                    route.fulfill(json=[{
                        "VehicleId": 26, "RouteId": 1, "RouteShortName": "26", "TransportType": "bus", "Direction": 90,
                        "Location": {"Longitude": 30.3275, "Latitude": 59.8525},
                        "DateTime": datetime.now(timezone.utc).isoformat(),
                    }])
                else: route.abort()
            context.route("**/*", handle)
            page = context.new_page(); page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(origin); wait_for_map(page)
            page.evaluate("""() => {
              selectedPlace={name:'Конечная',longitude:30.33,latitude:59.86};
              window.routingTestUI=routingUI;
              map.jumpTo({center:[30.325,59.855],zoom:15,pitch:37,bearing:20,padding:{top:12,right:8,bottom:40,left:4}});
            }""")
            # The route's first render must stack below vehicles already on the map.
            page.evaluate("moduleHost.enable('spb-live')")
            page.wait_for_function("map.getSource('module-spb-live:bus-source')._data.features.length > 0")
            pin = page.evaluate("selectedPlace")
            original_padding = page.evaluate("map.getPadding()")
            page.locator("#route-open").click()
            page.locator("#routing-panel").evaluate("element=>Promise.all(element.getAnimations().map(animation=>animation.finished))")
            assert page.locator("#routing-to").input_value() == "Конечная"
            assert page.evaluate("locationCalls") == 0, "Opening a route must not immediately request geolocation"
            assert page.evaluate("routingTestUI.isOpen()")
            assert not page.locator("#map").evaluate("node=>node.inert"), "Routing is a nonmodal map workspace"
            assert page.locator(".routing-modes button svg[aria-hidden=true]").count() == 3
            assert page.locator('[data-mode="transit"] svg path').get_attribute('d') == page.evaluate("SloiTransportSymbols.get('bus').paths[0].d")
            assert page.locator(".routing-parameters").is_hidden()
            rect = page.locator("#routing-panel").bounding_box()
            page.locator(".routing-submit").click()
            page.locator(".routing-option").first.wait_for()
            assert page.locator(".routing-option").count() == 2
            assert "11 мин" in page.locator(".routing-option").first.inner_text()
            assert "routed-foot" in requested[-1]
            assert_route_in_view(page)
            assert abs(page.evaluate("map.getPitch()") - 37) < .01
            assert abs(page.evaluate("map.getBearing()") - 20) < .01
            assert page.evaluate("map.getPadding()") == original_padding
            assert page.evaluate("selectedPlace") == pin
            assert page.locator("#routing-panel").bounding_box() == rect, "Results must not move or resize the panel"
            page.wait_for_function("map.queryRenderedFeatures({layers:['route-plan-line']}).some(f=>f.properties.kind==='walk'&&f.properties.routeColor==='#23b34b')")
            assert_vehicle_layer_order(page)
            # Recreating vehicle layers while the route is active must preserve the order.
            page.evaluate("moduleHost.disable('spb-live')")
            assert not page.evaluate("map.getLayer('module-spb-live:bus-point') !== undefined")
            page.evaluate("moduleHost.enable('spb-live')")
            page.wait_for_function("map.getSource('module-spb-live:bus-source')._data.features.length > 0")
            assert_vehicle_layer_order(page)
            page.evaluate("moduleHost.disable('spb-live')")
            assert page.evaluate("map.queryRenderedFeatures({layers:['route-plan-walk']}).length") == 0
            assert page.evaluate("map.getPaintProperty('route-plan-line','line-dasharray')") is None
            rail = page.locator(".routing-options")
            assert rail.evaluate("node=>node.scrollWidth>node.clientWidth")
            cards = page.locator(".routing-option")
            first, second = cards.nth(0).bounding_box(), cards.nth(1).bounding_box()
            assert first["y"] == second["y"]
            assert second["x"] < rail.bounding_box()["x"] + rail.bounding_box()["width"], "Next alternative should preview at the rail edge"
            card_camera = camera(page)
            request_count = len(requested)
            cards.nth(1).click()
            assert cards.nth(1).get_attribute("aria-pressed") == "true"
            assert cards.nth(0).get_attribute("aria-pressed") == "false"
            assert page.evaluate("map.getSource('route-plan-source')._data.features[0].geometry.coordinates[1]") == [30.36, 59.879]
            assert_route_in_view(page)
            assert camera(page)["zoom"] < card_camera["zoom"], "Fit the wider detour, including its middle point"
            assert abs(page.evaluate("map.getPitch()") - 37) < .01
            assert abs(page.evaluate("map.getBearing()") - 20) < .01
            cdp = context.new_cdp_session(page)
            before_pan = camera(page)
            gesture(page, cdp, [(120, 170)], [(187, 201)])
            manual_camera = camera(page)
            assert manual_camera["center"] != before_pan["center"]
            page.wait_for_timeout(500)
            assert camera(page) == manual_camera, "A manual pan must never trigger another route fit"
            assert len(requested) == request_count, "Switching an alternative uses its current geometry without an HTTP request"
            page.locator(".routing-close").click()
            assert page.locator("#routing-panel").is_hidden()
            assert page.locator(".routing-chip").is_visible()
            assert not page.locator("#map").evaluate("element=>element.inert")
            page.locator(".routing-resume").click()
            page.locator('[data-mode="bicycle"]').click(); page.locator(".routing-submit").click()
            page.wait_for_function("document.querySelector('.routing-submit').disabled===false")
            assert "routed-bike" in requested[-1]
            page.wait_for_function("map.queryRenderedFeatures({layers:['route-plan-line']}).some(f=>f.properties.kind==='bicycle'&&f.properties.routeColor==='#168a85')")
            assert page.evaluate("map.getPaintProperty('route-plan-line','line-color')") == ['get', 'routeColor']
            page.locator('[data-mode="transit"]').click(); page.locator(".routing-submit").click()
            page.locator(".routing-itinerary > summary").wait_for()
            assert_route_in_view(page)
            assert not page.locator(".routing-itinerary").evaluate("node=>node.open")
            assert_cards_visible(page)
            page.locator(".routing-itinerary > summary").click()
            assert "Автобус 26" in page.locator(".routing-steps").inner_text()
            assert "Начальная → Конечная" in page.locator(".routing-steps").inner_text()
            assert page.evaluate("map.getLayer('route-plan-stops').minzoom") == 15
            assert page.evaluate("map.getSource('route-plan-source')._data.features.find(f=>f.properties.kind==='stop').geometry.coordinates") == [30.321, 59.851]
            assert page.locator(".routing-option").count() == 2
            page.wait_for_function("map.queryRenderedFeatures({layers:['route-plan-walk']}).some(f=>f.properties.walkConnector&&f.properties.routeColor==='#23b34b')")
            assert page.evaluate("map.getPaintProperty('route-plan-walk','line-dasharray')") == [1, 1.4]
            assert page.evaluate("""() => {
              const segments = map.queryRenderedFeatures({layers:['route-plan-line','route-plan-casing']});
              return segments.length > 0 && segments.every(f=>f.properties.transportType==='bus'&&f.properties.routeColor==='#1a73f0');
            }""")
            badge_colors = page.locator('.routing-option').first.locator('.routing-leg-badge svg').evaluate_all("nodes=>nodes.map(n=>getComputedStyle(n).color)")
            assert badge_colors == ['rgb(35, 179, 75)', 'rgb(26, 115, 240)']
            assert "Без пересадок" in page.locator(".routing-option").first.inner_text()
            assert "1 пересадка" in page.locator(".routing-option").nth(1).inner_text()
            assert "К 10:20" in page.locator(".routing-option").first.inner_text()
            assert page.locator(".routing-option").nth(1).locator("svg").count() == 3
            page.locator(".routing-itinerary > summary").click()
            page.locator(".routing-form").evaluate("node=>{node.scrollTop=0}")
            # Cards must be visible in full, not merely present under a clipped
            # grid row. Keep this geometric check alongside the screenshot.
            assert_cards_visible(page)
            geometry_failures = []
            for width, height in [(320, 740), (320, 568), (411, 683)]:
                page.set_viewport_size({"width": width, "height": height})
                try: assert_cards_visible(page)
                except AssertionError as failure: geometry_failures.append(failure.args[0])
                if (width, height) == (320, 568):
                    page.emulate_media(reduced_motion="reduce")
                    page.evaluate("map.jumpTo({pitch:55,bearing:43});document.querySelector('.routing-option').click()")
                    assert not page.evaluate("map.isMoving()"), "Reduced motion should fit without animation"
                    assert_route_in_view(page)
                    page.emulate_media(reduced_motion="no-preference")
            page.set_viewport_size({"width": 390, "height": 844})
            assert_cards_visible(page)
            assert not geometry_failures, geometry_failures
            if args.screenshot:
                page.wait_for_function("!map.isMoving()")
                page.screenshot(path=args.screenshot)
            page.locator(".routing-parameters > summary").click()
            assert page.locator('.routing-transport-options input:checked').count() == 4
            assert page.locator('.routing-transport-type svg').count() == 4
            assert page.locator('.routing-transport-type:has(#routing-transport-subway) svg path').get_attribute('d') == page.evaluate("SloiTransportSymbols.get('metro-plain').paths[0].d")
            page.locator("#routing-direct-only").check()
            page.locator(".routing-submit").click()
            page.locator(".routing-option").wait_for()
            assert page.locator(".routing-option").count() == 1
            assert_cards_visible(page)
            assert page.locator(".routing-option").get_attribute("aria-pressed") == "true"
            assert "Без пересадок" in page.locator(".routing-option").inner_text()
            assert "maxTransfers" not in requested[-1], "Do not send an unverified generic OTP parameter to the city wrapper"
            page.locator('[data-mode="walk"]').click()
            assert page.locator(".routing-parameters").is_hidden()
            page.locator('[data-mode="transit"]').click()
            assert page.locator("#routing-direct-only").is_checked()

            # A provider result with a real transfer is never presented as direct.
            transit_reply["value"] = {"success": True, "result": [TRANSFER]}
            page.locator(".routing-submit").click()
            page.wait_for_function("document.querySelector('.routing-submit').disabled===false")
            assert "нет маршрута без пересадок" in page.locator(".routing-status").inner_text()
            assert page.locator(".routing-option").count() == 0
            assert page.evaluate("map.getSource('route-plan-source')._data.features.length") == 0
            transit_reply["value"] = TRANSIT
            page.locator("#routing-direct-only").uncheck()

            # Vehicle choices are sent using the official transports argument;
            # even a server fixture returning a mixed journey cannot bypass them.
            for kind in ['tram', 'trolley', 'subway']:
                page.locator(f'#routing-transport-{kind}').uncheck()
            assert page.locator('#routing-from').input_value() == 'Моё место'
            page.locator('.routing-submit').click()
            page.locator('.routing-option').wait_for()
            assert page.locator('.routing-option').count() == 1
            assert parse_qs(urlparse(requested[-1]).query)['transports'] == ['bus']
            assert page.evaluate("map.getSource('route-plan-source')._data.features.filter(f=>f.geometry.type==='LineString').every(f=>f.properties.kind==='walk'||f.properties.transportType==='bus')")
            page.locator('.routing-close').click(); page.locator('.routing-resume').click()
            assert page.locator('#routing-transport-bus').is_checked()
            assert not page.locator('#routing-transport-subway').is_checked()
            page.locator('[data-mode="walk"]').click(); page.locator('[data-mode="transit"]').click()
            assert not page.locator('#routing-transport-subway').is_checked()
            prior_requests, prior_gps = len(requested), page.evaluate('locationCalls')
            page.locator('#routing-transport-bus').uncheck()
            page.locator('.routing-submit').click()
            assert 'хотя бы один вид транспорта' in page.locator('.routing-status').inner_text()
            assert len(requested) == prior_requests and page.evaluate('locationCalls') == prior_gps
            for kind in ['bus', 'tram', 'trolley', 'subway']:
                page.locator(f'#routing-transport-{kind}').check()

            # The exposed map remains interactive during planning. A late route
            # may draw its line but must not reclaim a manually moved camera.
            block["value"] = True
            page.locator(".routing-submit").click()
            page.wait_for_function("document.querySelector('.routing-cancel').hidden===false")
            page.wait_for_function("document.querySelector('.routing-status').textContent==='Строю маршрут…'")
            page.locator(".routing-cancel").is_visible()
            assert pending
            cdp = context.new_cdp_session(page)
            before_pan = camera(page)
            gesture(page, cdp, [(120, 180)], [(220, 205)])
            manually_moved = camera(page)
            assert manually_moved["center"] != before_pan["center"]
            for route in pending:
                route.fulfill(json=TRANSIT)
            pending.clear(); block["value"] = False
            page.locator(".routing-option").first.wait_for()
            assert camera(page) == manually_moved

            block["value"] = True
            page.locator(".routing-submit").click()
            page.wait_for_function("document.querySelector('.routing-status').textContent==='Строю маршрут…'")
            assert pending
            camera_before_close = camera(page)
            page.locator(".routing-close").click()
            for route in pending:
                try: route.fulfill(json=TRANSIT)
                except Exception: pass
            pending.clear(); block["value"] = False
            page.wait_for_timeout(500)
            assert not page.evaluate("routingTestUI.isOpen()")
            assert page.locator(".routing-option").count() == 0
            assert camera(page) == camera_before_close, "A late response cannot move a closed route panel's map"
            page.locator("#route-open").click()

            # Editing an endpoint invalidates its coordinates until a live suggestion is selected.
            page.locator("#routing-to").fill("Новая")
            page.locator(".routing-suggestion").wait_for(); page.locator(".routing-suggestion").click()
            assert page.locator("#routing-to").input_value() == "Новая выбран"
            block["value"] = True
            page.locator(".routing-submit").click()
            page.wait_for_function("document.querySelector('.routing-cancel').hidden===false")
            page.wait_for_function("document.querySelector('.routing-status').textContent==='Строю маршрут…'")
            page.locator("#routing-direct-only").check()
            assert page.locator(".routing-submit").is_enabled()
            assert page.locator(".routing-cancel").is_hidden()
            for route in pending:
                try: route.fulfill(json=TRANSIT)
                except Exception: pass
            pending.clear()
            assert page.locator(".routing-option").count() == 0, "Preference changes invalidate in-flight itineraries"
            block["value"] = False
            page.locator(".routing-submit").click()
            page.locator(".routing-option").wait_for()
            assert page.locator(".routing-option").count() == 1
            assert page.evaluate("SloiApp.closeTransientUi()") is True
            assert not page.evaluate("routingTestUI.isOpen()")
            assert page.evaluate("SloiApp.closeTransientUi()") is False
            page.locator(".routing-resume").click()
            assert page.locator("#routing-to").input_value() == "Новая выбран", "Reopening keeps the route endpoint instead of restoring the old map pin"
            assert page.locator("#routing-direct-only").is_checked()

            # A genuinely new map selection replaces the endpoint and clears
            # the previous route, rather than relabelling its old cards/line.
            origin_text = page.locator("#routing-from").input_value()
            previous_requests = len(requested)
            page.locator(".routing-close").click()
            page.evaluate("selectedPlace={name:'Новый пункт карты',longitude:30.4,latitude:59.91}")
            page.locator("#route-open").click()
            assert page.locator("#routing-to").input_value() == "Новый пункт карты"
            assert page.locator("#routing-from").input_value() == origin_text
            assert page.locator("#routing-direct-only").is_checked()
            assert page.locator(".routing-option").count() == 0
            assert page.evaluate("map.getSource('route-plan-source')._data.features.length") == 0
            assert page.locator(".routing-chip").is_hidden()
            assert len(requested) == previous_requests

            block["value"] = True
            page.locator(".routing-submit").click()
            page.wait_for_function("document.querySelector('.routing-cancel').hidden===false")
            page.locator(".routing-cancel").click()
            assert page.locator(".routing-submit").is_enabled()
            assert page.locator(".routing-cancel").is_hidden()
            # Cancellation cleared the uncommitted draft; rebuilding restores a
            # selected route and its compact map chip before explicit removal.
            block["value"] = False
            page.locator(".routing-submit").click(); page.locator(".routing-option").wait_for()
            page.locator(".routing-close").click(); page.locator(".routing-clear").click()
            assert page.locator(".routing-chip").is_hidden()
            assert page.evaluate("map.getSource('route-plan-source')._data.features.length") == 0
            for width, height in [(320, 568), (780, 360)]:
                page.set_viewport_size({"width": width, "height": height}); page.evaluate("routingTestUI.open()")
                page.locator("#routing-panel").evaluate("element=>Promise.all(element.getAnimations().map(animation=>animation.finished))")
                box = page.locator("#routing-panel").bounding_box()
                assert box["x"] >= 0 and box["y"] >= 0
                assert box["x"] + box["width"] <= width
                assert box["y"] + box["height"] <= height
                assert page.locator("#routing-panel").evaluate("element=>element.scrollWidth===element.clientWidth")
                page.locator(".routing-close").click()
            # Confirmed draft endpoints remain visible while picking the next
            # point. Optional reverse names may change labels, never coordinates.
            page.set_viewport_size({"width": 390, "height": 844})
            page.evaluate("""() => {
              window.previousPlaceNames=window.SloiPlaceNames;window.pendingPlaceNames=[];
              window.SloiPlaceNames={resolve(point,{signal}){return new Promise(resolve=>pendingPlaceNames.push({point,signal,resolve}))}};
              map.jumpTo({center:[30.325,59.855],zoom:16,pitch:0,bearing:0});routingTestUI.open();
            }""")
            page.locator('[aria-label="Выбрать начало на карте"]').click()
            start = page.evaluate("(()=>{const c=map.getCanvas(),p=map.unproject([c.clientWidth/2,c.clientHeight/2]);return [p.lng,p.lat]})()")
            page.locator('.routing-picker-confirm').click()
            assert page.locator('#routing-from').input_value() == 'Точка на карте'
            assert page.locator('.routing-draft-marker[data-endpoint=from]').count() == 1
            page.locator('[aria-label="Выбрать конец на карте"]').click()
            assert page.locator('.routing-draft-marker[data-endpoint=from]').is_visible()
            marker_point = page.locator('.routing-draft-marker[data-endpoint=from]').evaluate("""(element,point)=>{
              const box=element.getBoundingClientRect(),expected=map.project(point);
              return [box.x+box.width/2-expected.x,box.y+box.height/2-expected.y];
            }""", start)
            assert all(abs(delta)<1 for delta in marker_point), marker_point
            cdp = context.new_cdp_session(page)
            gesture(page, cdp, [(120, 180)], [(190, 205)])
            end = page.evaluate("(()=>{const c=map.getCanvas(),p=map.unproject([c.clientWidth/2,c.clientHeight/2]);return [p.lng,p.lat]})()")
            page.locator('.routing-picker-confirm').click()
            assert start != end
            assert page.locator('.routing-draft-marker').count() == 2
            page.evaluate("pendingPlaceNames[0].resolve({name:'Невский проспект 12',latitude:1,longitude:2})")
            page.wait_for_function("document.querySelector('#routing-from').value==='Невский проспект 12'")
            page.locator('[aria-label="Выбрать конец на карте"]').click()
            page.locator('.routing-picker-confirm').click()
            assert page.evaluate('pendingPlaceNames[1].signal.aborted')
            page.evaluate("pendingPlaceNames[1].resolve({name:'Устаревшее название'})")
            page.wait_for_timeout(20)
            assert page.locator('#routing-to').input_value() == 'Точка на карте'
            page.evaluate("pendingPlaceNames[2].resolve({name:'Московский проспект 185'})")
            page.wait_for_function("document.querySelector('#routing-to').value==='Московский проспект 185'")
            page.locator('[aria-label="Выбрать конец на карте"]').click()
            page.keyboard.press('Escape')
            assert page.locator('#routing-to').input_value() == 'Московский проспект 185'
            assert page.locator('.routing-draft-marker').count() == 2
            before_gps = page.evaluate('locationCalls')
            page.locator('[data-mode="walk"]').click();page.locator('.routing-submit').click()
            page.locator('.routing-option').first.wait_for()
            sent = parse_qs(urlparse(requested[-1]).query) if '/transit-api-otp/' in requested[-1] else None
            path = urlparse(requested[-1]).path.split('/')[-1]
            route_points = [[float(value) for value in point.split(',')] for point in path.split(';')]
            for actual, expected in zip(route_points, [start, end]):
                assert all(abs(a-b)<1e-8 for a,b in zip(actual,expected)), (route_points,start,end)
            assert page.evaluate('locationCalls') == before_gps
            page.wait_for_function('!map.isMoving()')
            page.locator('[aria-label="Выбрать начало на карте"]').click()
            page.locator('.routing-picker-confirm').click()
            assert page.locator('#routing-from').input_value() == 'Точка на карте'
            page.locator('.routing-close').click()
            assert page.evaluate('pendingPlaceNames[3].signal.aborted')
            page.evaluate("pendingPlaceNames[3].resolve({name:'Ответ после закрытия'})")
            page.wait_for_timeout(20)
            assert page.locator('#routing-from').input_value() == 'Точка на карте'
            assert page.locator('.routing-draft-marker').count() == 0
            page.evaluate('window.SloiPlaceNames=previousPlaceNames')
            page.evaluate("routingTestUI.dispose()")
            assert page.locator("#routing-panel").count() == 0
            assert not page.evaluate("Boolean(map.getSource('route-plan-source'))")
            assert not errors, errors
            browser.close()
    finally:
        server.shutdown(); server.server_close()
    print("Routing browser OK: vehicle filters, route colors and cards, whole-path camera fit above panel, reduced motion, manual pan and closed request guards, draft endpoints and cleanup")


if __name__ == "__main__": main()
