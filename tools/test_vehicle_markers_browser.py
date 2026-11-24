"""Actual WebGL drop pixels vs projected compass vectors; synthetic live feed."""
import argparse
from datetime import datetime, timezone
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
import threading
from playwright.sync_api import sync_playwright
from test_browser import QuietHandler, wait_for_map


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--chromium'); parser.add_argument('--screenshot'); args = parser.parse_args()
    assets = Path(__file__).resolve().parents[1] / 'app/src/main/assets'
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(assets)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    errors = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=args.chromium, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
            context = browser.new_context(viewport={'width': 390, 'height': 844})
            def handle(route):
                if route.request.url.startswith(origin): route.continue_()
                elif '/api/visary/geometry/vehicle?' in route.request.url:
                    route.fulfill(json=[{'VehicleId': 1, 'RouteId': 1, 'RouteShortName': '49', 'TransportType': 'bus', 'Direction': 0,
                        'Location': {'Longitude': 30.33, 'Latitude': 59.93}, 'DateTime': datetime.now(timezone.utc).isoformat()}])
                else: route.abort()
            context.route('**/*', handle)
            page = context.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(origin); wait_for_map(page)
            page.evaluate("""async () => {
              closeSheet(); map.jumpTo({center:[30.33,59.93],zoom:16,pitch:0,bearing:0});
              await moduleHost.configure('spb-live',{routes:JSON.stringify([{type:'bus',number:'49',color:'#ef2345'}])});
              await moduleHost.enable('spb-live');
              window.markerFeature=JSON.parse(JSON.stringify(map.getSource('module-spb-live:bus-source')._data.features[0]));
              window.markerContext=moduleHost.entries.get('spb-live').session;
            }""")
            page.wait_for_function("map.queryRenderedFeatures({layers:['module-spb-live:bus-point','module-spb-live:bus-vehicle-icon']}).length>=2")
            assert page.evaluate("map.getLayer('module-spb-live:bus-point').type") == 'symbol'
            assert page.evaluate("map.getLayoutProperty('module-spb-live:bus-point','icon-pitch-alignment')") == 'map'
            assert page.evaluate("map.getLayoutProperty('module-spb-live:bus-vehicle-icon','icon-rotation-alignment')") == 'viewport'
            # Capture the factory context through a test-only module, using the
            # same host renderer and real map, independent of polling timers.
            page.evaluate("""async () => {
              moduleHost.disable('spb-live');
              moduleHost.register({id:'marker-proof',apiVersion:1,version:'1',title:'Proof',capabilities:['geojson'],defaults:{}},ctx=>{window.markerProof=ctx});
              await moduleHost.enable('marker-proof');
              window.setProofMarker=(heading,type='bus')=>markerProof.setGeoJson('vehicles',{type:'FeatureCollection',features:[{...markerFeature,properties:{...markerFeature.properties,heading,vehicleType:type,opacity:1}}]},
                {color:'#ef2345',colorProperty:'color',pointMarker:'vehicle',pointHeading:'heading',pointType:'vehicleType',pointMinZoom:12,pointLabelMinZoom:13});
            }""")
            measurements = []
            for heading, bearing, pitch in [(0,0,0),(90,0,0),(180,0,0),(270,0,0),(45,0,60),(135,0,60),(45,37,50),(135,37,50),(270,-90,45)]:
                page.evaluate("([heading,bearing,pitch])=>{map.jumpTo({center:[30.33,59.93],zoom:16,bearing,pitch});setProofMarker(heading)}", [heading,bearing,pitch])
                page.wait_for_function("map.queryRenderedFeatures({layers:['module-marker-proof:vehicles-point']}).length>0")
                # MapLibre symbols fade in over 300ms; measure their settled pixels.
                page.wait_for_timeout(350)
                # Read pixels within the renderer callback, before the default
                # non-preserved WebGL drawing buffer is discarded.
                result = page.evaluate("""() => new Promise(resolve=>{
                  map.once('render',()=>{
                    const gl=map.painter.context.gl, canvas=map.getCanvas(), sx=gl.drawingBufferWidth/canvas.clientWidth, sy=gl.drawingBufferHeight/canvas.clientHeight;
                    const anchor=map.project([30.33,59.93]), e=map.project([30.3301,59.93]), n=map.project([30.33,59.93+.0001*Math.cos(59.93*Math.PI/180)]);
                    const ex=e.x-anchor.x,ey=e.y-anchor.y,nx=n.x-anchor.x,ny=n.y-anchor.y,det=ex*ny-ey*nx;
                    const x0=Math.floor((anchor.x-40)*sx), y0=Math.floor(gl.drawingBufferHeight-(anchor.y+40)*sy), w=Math.ceil(80*sx),h=Math.ceil(80*sy);
                    const pixels=new Uint8Array(w*h*4);gl.readPixels(x0,y0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
                    let tip=null,count=0;
                    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
                      const i=(y*w+x)*4;
                      if(pixels[i]<160||pixels[i+1]>100||pixels[i+2]>125)continue;
                      const dx=(x0+x+.5)/sx-anchor.x,dy=(gl.drawingBufferHeight-y0-y-.5)/sy-anchor.y;
                      // Ignore the separate route-number label below the body.
                      if(Math.abs(dx)>25||Math.abs(dy)>25)continue;
                      const gx=(dx*ny-dy*nx)/det,gy=(ex*dy-ey*dx)/det,d=gx*gx+gy*gy;
                      count++;if(!tip||d>tip.d)tip={dx,dy,gx,gy,d};
                    }
                    resolve({count,tip});
                  });map.triggerRepaint();
                })""")
                if not result['count']: page.screenshot(path='/tmp/sloi-vehicle-pixel-failure.png')
                assert result['count'] > 20 and result['tip'], (heading,bearing,pitch,result)
                import math
                angle = math.degrees(math.atan2(result['tip']['gx'], result['tip']['gy'])) % 360
                error = abs((angle-heading+180)%360-180)
                assert error < 13, {'heading':heading,'bearing':bearing,'pitch':pitch,'measured':angle,'error':error,'pixels':result}
                measurements.append((heading,bearing,pitch,round(angle,1)))
            page.evaluate("setProofMarker(null)")
            unknown = page.evaluate("map.getSource('module-marker-proof:vehicles-source')._data.features[0].properties")
            page.evaluate("setProofMarker(0)")
            north = page.evaluate("map.getSource('module-marker-proof:vehicles-source')._data.features[0].properties")
            assert unknown['__moduleVehicleBodyImage'] != north['__moduleVehicleBodyImage'], 'Unknown direction uses a round marker'
            ids = []
            for kind in ['bus','tram','trolley']:
                page.evaluate("kind=>setProofMarker(90,kind)",kind)
                ids.append(page.evaluate("map.getSource('module-marker-proof:vehicles-source')._data.features[0].properties.__moduleVehicleIconImage"))
            assert len(set(ids)) == 3
            # Restored stops are a bundled, independently visible layer; they
            # survive without a live service or an opened route.
            page.wait_for_function("moduleHost.get('spb-stops').status==='ready' && map.getSource('module-spb-stops:stops-source')._data.features.length>0")
            assert page.evaluate("map.getLayer('module-spb-stops:stops-point').minzoom") == 15
            assert page.evaluate("map.getLayer('module-spb-stops:stops-label').minzoom") == 16
            page.evaluate("map.jumpTo({center:[30.33,59.93],bearing:0,pitch:0,zoom:14})")
            page.wait_for_function("map.getSource('module-spb-stops:stops-source')._data.features.length===0")
            page.evaluate("map.jumpTo({bearing:0,pitch:0,zoom:16});setProofMarker(45)")
            if args.screenshot: page.screenshot(path=args.screenshot)
            page.evaluate("moduleHost.disable('marker-proof')")
            assert page.evaluate("!map.listImages().some(id=>id.startsWith('module-marker-proof:'))")
            assert not errors, errors
            print('Vehicle drop pixels OK:',measurements,'; 3 distinct upright glyphs, neutral unknown course, complete cleanup')
            browser.close()
    finally:
        server.shutdown(); server.server_close()


if __name__ == '__main__': main()
