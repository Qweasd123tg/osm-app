"""Real MapLibre source/rendered positions interpolate without rebuilding sprites."""
import argparse
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
import threading
from playwright.sync_api import sync_playwright
from test_browser import QuietHandler, wait_for_map


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--chromium')
    args = parser.parse_args()
    assets = Path(__file__).resolve().parents[1] / 'app/src/main/assets'
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(assets)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=args.chromium, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
            context = browser.new_context(viewport={'width': 390, 'height': 844})
            context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(origin) else route.abort())
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(origin)
            wait_for_map(page)
            page.evaluate("""async () => {
              closeSheet();map.jumpTo({center:[30.33,59.93],zoom:17,pitch:40,bearing:30});
              moduleHost.register({id:'motion-proof',apiVersion:1,version:'1',title:'Motion',capabilities:['geojson'],defaults:{}},ctx=>{window.motionProof=ctx});
              await moduleHost.enable('motion-proof');
              window.motionOptions={pointMarker:'vehicle',pointHeading:'heading',pointType:'vehicleType',pointLabel:'label',pointLabelStyle:'vehicle',pointLabelColorProperty:'labelColor',pointTransitionMs:1200,color:'#1a73f0'};
              window.fix=(lon,heading,time)=>({type:'FeatureCollection',features:[{type:'Feature',id:'bus:1',properties:{route:'49',label:'49',labelColor:'#436abd',vehicleType:'bus',heading,rawTimestamp:time},geometry:{type:'Point',coordinates:[lon,59.93]}}]});
              motionProof.setGeoJson('positions',fix(30.3297,359,'2026-11-24T12:00:00Z'),motionOptions);
              window.motionSource=map.getSource('module-motion-proof:positions-source');
              window.uploads=[];const original=motionSource.setData.bind(motionSource);
              motionSource.setData=data=>{uploads.push({time:performance.now(),lon:data.features[0]?.geometry.coordinates[0]});return original(data)};
              window.initialSprites=map.listImages().filter(id=>id.startsWith('module-motion-proof:'));
              window.beforeCamera={center:map.getCenter().toArray(),zoom:map.getZoom(),pitch:map.getPitch(),bearing:map.getBearing()};
              motionProof.setGeoJson('positions',fix(30.3303,1,'2026-11-24T12:00:01Z'),motionOptions);
            }""")
            assert page.evaluate("map.getLayoutProperty('module-motion-proof:positions-label','icon-anchor')") == 'bottom-right'
            assert page.evaluate("map.getLayoutProperty('module-motion-proof:positions-label','icon-pitch-alignment')") == 'viewport'
            assert page.evaluate("(()=>{const id=motionSource._data.features[0].properties.__moduleLabelImage;const image=map.getImage(id);return image.data.height/image.pixelRatio})()") == 15
            # A real source must expose intermediate positions, not just an end
            # timer followed by a teleport. This includes the first rendered GPU update.
            page.wait_for_function("motionSource._data.features[0].geometry.coordinates[0]>30.32975 && motionSource._data.features[0].geometry.coordinates[0]<30.33025")
            mid = page.evaluate("motionSource._data.features[0]")
            assert mid['properties']['__moduleVehicleHeading'] < 3 or mid['properties']['__moduleVehicleHeading'] > 357, mid
            page.wait_for_function("map.queryRenderedFeatures({layers:['module-motion-proof:positions-point']}).some(f=>f.geometry.coordinates[0]>30.32975&&f.geometry.coordinates[0]<30.33029)")
            page.wait_for_function("Math.abs(motionSource._data.features[0].geometry.coordinates[0]-30.3303)<1e-10")
            result = page.evaluate("""() => ({uploads:[...uploads],sprites:map.listImages().filter(id=>id.startsWith('module-motion-proof:')),
              initialSprites, camera:{center:map.getCenter().toArray(),zoom:map.getZoom(),pitch:map.getPitch(),bearing:map.getBearing()},beforeCamera})""")
            assert 4 <= len(result['uploads']) <= 38, result['uploads']
            assert result['sprites'] == result['initialSprites'], 'Frames must reuse all existing sprite IDs'
            assert result['camera'] == result['beforeCamera'], 'Moving a vehicle must never move the camera'
            before = len(result['uploads'])
            page.wait_for_timeout(150)
            assert page.evaluate('uploads.length') == before, 'Stop uploading after reaching the latest GPS fix'
            # A repeated observation carries style changes but no backwards move.
            page.evaluate("motionProof.setGeoJson('positions',fix(30.3303,1,'2026-11-24T12:00:01Z'),motionOptions)")
            assert abs(page.evaluate('motionSource._data.features[0].geometry.coordinates[0]') - 30.3303) < 1e-10
            page.evaluate("motionProof.setGeoJson('positions',fix(30.3306,5,'2026-11-24T12:00:02Z'),motionOptions)")
            page.emulate_media(reduced_motion='reduce')
            page.wait_for_function("Math.abs(motionSource._data.features[0].geometry.coordinates[0]-30.3306)<1e-10")
            page.emulate_media(reduced_motion='no-preference')
            page.evaluate("""() => {
              const originalLoaded=motionSource.loaded.bind(motionSource);window.workerBusy=true;
              motionSource.loaded=()=>workerBusy?false:originalLoaded();window.beforeBusy=uploads.length;
              motionProof.setGeoJson('positions',fix(30.3309,10,'2026-11-24T12:00:03Z'),motionOptions);
            }""")
            page.wait_for_timeout(1400)
            assert page.evaluate('uploads.length===beforeBusy'), 'A busy tile worker must not queue old animation frames'
            page.evaluate("workerBusy=false;map.fire('sourcedata',{sourceId:'module-motion-proof:positions-source'})")
            page.wait_for_function("Math.abs(motionSource._data.features[0].geometry.coordinates[0]-30.3309)<1e-10")
            assert page.evaluate('uploads.length===beforeBusy+1'), 'Flush only the final, most recent queued frame'
            page.evaluate("motionProof.setGeoJson('positions',fix(30.3312,15,'2026-11-24T12:00:04Z'),motionOptions);window.oldUploads=uploads.length;moduleHost.disable('motion-proof')")
            page.wait_for_timeout(150)
            assert page.evaluate('uploads.length===oldUploads'), 'Disable must cancel all pending frames'
            assert page.evaluate("!map.getSource('module-motion-proof:positions-source')&&!map.listImages().some(id=>id.startsWith('module-motion-proof:'))")
            assert not errors, errors
            browser.close()
            print('Vehicle motion browser OK: intermediate source and rendered positions, shortest heading turn, bounded uploads and busy-worker backpressure, stable sprites/camera, no extrapolation, reduced motion and cleanup')
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
