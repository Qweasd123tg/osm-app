"""Translucent buildings stop drawing/work early without dropping ready sources."""
import argparse
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
import threading
from playwright.sync_api import sync_playwright
from test_browser import QuietHandler, wait_for_map


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--chromium")
    args = parser.parse_args()
    assets = Path(__file__).resolve().parents[1] / "app/src/main/assets"
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(assets)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_port}"
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=args.chromium,
                args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
            context = browser.new_context(viewport={"width": 390, "height": 844})
            context.route("**/*", lambda r: r.continue_() if r.request.url.startswith(origin) else r.abort())
            page = context.new_page()
            page.goto(origin)
            wait_for_map(page)
            assert page.evaluate("state.buildingOpacity") == .65
            # Migrate an existing opaque install once. Preserve already more
            # transparent preferences and later changes after the migration.
            for previous in [.96, .4]:
                page.evaluate("""opacity=>{
                    localStorage.removeItem('sloi-building-transparency-v1');
                    localStorage.setItem('sloi-map-state',JSON.stringify({buildingOpacity:opacity}));
                }""", previous)
                page.reload()
                wait_for_map(page)
                assert page.evaluate("state.buildingOpacity") == min(previous, .65)
                assert page.evaluate("localStorage.getItem('sloi-building-transparency-v1')") == "done"
            page.evaluate("state.buildingOpacity=.85;saveState()")
            page.reload()
            wait_for_map(page)
            assert page.evaluate("state.buildingOpacity") == .85, "Migration must not override later choices"
            page.evaluate("""() => {
                window.buildingRequests=[];
                window.AndroidHost={requestViewportBuildings(text){buildingRequests.push(JSON.parse(text))},cancelViewportBuildings(){}};
                window.zoomForScale=meters=>Math.log2(SloiMapCamera.scaleMeters(59.9,0)/meters);
                map.jumpTo({center:[30.32,59.9],zoom:zoomForScale(100),pitch:40});
                cityPacks.set('fixture',{id:'fixture',status:'installed',revision:'1',bounds:[[30,59],[31,60.5]]});
                state.buildings=true;state.buildingOpacity=.65;refreshViewportTiles();
                const tile=[...viewport.desired.values()].find(t=>t.bounds.west<=30.32 && t.bounds.east>30.32 && t.bounds.south<=59.9 && t.bounds.north>59.9);
                window.fixtureTile=tile.id;
                addViewportTile(tile.id,{featureCount:1,buildings:{type:'FeatureCollection',features:[{
                    type:'Feature',properties:{height:24,min_height:0},geometry:{type:'Polygon',coordinates:[[
                        [30.3197,59.8998],[30.3203,59.8998],[30.3203,59.9002],[30.3197,59.9002],[30.3197,59.8998]
                    ]]}
                }]}});
                applyMapState();
                window.fixtureIds=viewportLayerIds(tile.id);
                window.originalBuildingSource=map.getSource(fixtureIds.source);
                window.missingBuildingFrames=0;
                window.distantDrawFrames=0;
                map.on('render',()=>{if(map.getSource(fixtureIds.source)!==originalBuildingSource)missingBuildingFrames++});
                map.on('render',()=>{
                    if(SloiMapCamera.scaleMeters(map.getCenter().lat,map.getZoom())>=250 && map.getLayoutProperty(fixtureIds.extrusion,'visibility')!=='none')distantDrawFrames++;
                });
            }""")
            page.wait_for_function("map.isSourceLoaded(fixtureIds.source)")
            assert page.evaluate("map.getPaintProperty(fixtureIds.extrusion,'fill-extrusion-opacity')") == .65
            assert page.evaluate("map.queryRenderedFeatures({layers:[fixtureIds.extrusion]}).length") > 0
            height = page.evaluate("map.getPaintProperty(fixtureIds.extrusion,'fill-extrusion-height')")
            scales = page.evaluate("stops=>stops.map(zoom=>SloiMapCamera.scaleMeters(59.9,zoom))", [height[3], height[5]])
            assert abs(scales[0] - 250) < 1e-8
            assert abs(scales[1] - 100) < 1e-8
            assert height[4] == 0 and height[6] == ["get", "height"]
            for scale in [80, 175, 251, 600, 100]:
                requests_before = page.evaluate("buildingRequests.length")
                page.evaluate("scale=>map.zoomTo(zoomForScale(scale),{duration:180})", scale)
                page.wait_for_function("!map.isMoving()")
                page.evaluate("refreshViewportTiles()")
                page.wait_for_timeout(220)
                assert page.evaluate("map.getSource(fixtureIds.source)===originalBuildingSource")
                assert page.evaluate("map.getSource(fixtureIds.source)._data.features.length") == 1
                assert abs(page.evaluate("map.getPitch()") - 40) < .01
                if scale >= 250:
                    assert page.evaluate("buildingRequests.length") == requests_before
                    assert page.evaluate("viewport.requestId") is None
                    assert page.evaluate("map.getLayoutProperty(fixtureIds.extrusion,'visibility')") == "none"
                    assert page.evaluate("map.queryRenderedFeatures({layers:[fixtureIds.extrusion]}).length") == 0
                else:
                    assert page.evaluate("map.getLayoutProperty(fixtureIds.extrusion,'visibility')") == "visible"
            assert page.evaluate("distantDrawFrames") == 0
            requests_before = page.evaluate("buildingRequests.length")
            page.evaluate("state.mode='2d';applyMapState();refreshViewportTiles()")
            page.wait_for_timeout(220)
            assert page.evaluate("buildingRequests.length") == requests_before
            assert page.evaluate("map.getLayoutProperty(fixtureIds.extrusion,'visibility')") == "none"
            assert page.evaluate("map.getSource(fixtureIds.source)===originalBuildingSource")
            page.evaluate("state.mode='3d';applyMapState();refreshViewportTiles()")
            assert page.evaluate("map.getLayoutProperty(fixtureIds.extrusion,'visibility')") == "visible"
            page.evaluate("disableViewportForCurrentSignature('synthetic replacement failure')")
            assert page.evaluate("map.getSource(fixtureIds.source)===originalBuildingSource")
            assert page.evaluate("missingBuildingFrames") == 0
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print("Buildings OK: translucent defaults/migration, 100–250m detail, no distant/2D work or drawing, stable camera and ready sources")


if __name__ == "__main__":
    main()
