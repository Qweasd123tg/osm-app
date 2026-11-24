"""Exercise transport UI and real preset persistence with bounded map/feed fixtures.

No external network, physical phone or municipal feed behavior is claimed here.
"""
import argparse
from datetime import datetime, timezone
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright
from test_browser import QuietHandler, wait_for_map


FIXTURE = """<!doctype html><html lang="ru"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/transport.css">
<button id="map-action" style="position:fixed;top:20px;left:20px" onclick="mapClicks++">Карта</button>
<button id="launch" style="position:fixed;top:70px;left:20px">Транспорт</button>
<main id="settings-page" class="settings-page" hidden><div id="editor" class="settings-panel"></div></main>
<script src="/modules/live-transport.js"></script><script src="/transport-presets.js"></script><script src="/transport-ui.js"></script>
<script>
window.mapClicks=0;window.cameraCalls=[];window.events=new Map();
window.map={getZoom:()=>15,on:(type,fn)=>events.set(type,fn),off:(type,fn)=>events.get(type)===fn&&events.delete(type),
 fitBounds:(bounds,options)=>cameraCalls.push({kind:'fit',bounds,options}),easeTo:options=>cameraCalls.push({kind:'station',options})};
window.snapshots={
 'spb-live':{enabled:false,status:'disabled',settings:{routes:''},error:null},
 'spb-metro':{enabled:false,status:'disabled',settings:{selectedLine:'',entrances:true},error:null}};
window.configureCalls=[];
window.host={get:id=>JSON.parse(JSON.stringify(snapshots[id])),
 async configure(id,patch){configureCalls.push({id,patch});Object.assign(snapshots[id].settings,patch);
   if(window.deferConfigure)await new Promise(resolve=>window.finishConfigure=resolve);
   return this.get(id);},
 async enable(id){snapshots[id].enabled=true;snapshots[id].status='ready';return this.get(id)},
 disable(id){snapshots[id].enabled=false;snapshots[id].status='disabled'}};
window.presets=SloiTransportPresets.create({storage:localStorage,onSelect:async routes=>{
 if(window.failSelection){window.failSelection=false;throw new Error('Нет соединения')}
 if(window.deferSelection)await new Promise(resolve=>window.finishSelection=resolve);
 snapshots['spb-live'].settings.routes=routes===null?'':JSON.stringify(routes);await host.enable('spb-live');}});
window.catalogCalls=0;
window.SloiMetro={lines:Array.from({length:6},(_,i)=>({id:String(i+1),name:'Линия '+(i+1),color:['#d33431','#176bc1','#168e59','#e87322','#8755a4','#8b5b3b'][i]})),
 async catalog({signal}){catalogCalls++;if(signal.aborted)throw new DOMException('Отмена','AbortError');return {lines:this.lines.map(line=>({...line,bounds:[[30.2,59.8],[30.4,60]],
 stations:[{id:line.id+'-a',name:'Станция '+line.id,coordinates:[30.3,59.9]}]}))}}};
window.ui=SloiTransportUI.install({map,host,presets,editor:document.getElementById('editor'),onEditPresets(){document.getElementById('settings-page').hidden=false;ui.showEditor()}});
document.getElementById('launch').onclick=()=>ui.open();
</script></html>"""


class Handler(QuietHandler):
    def do_GET(self):
        if self.path == '/fixture':
            body = FIXTURE.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html;charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            super().do_GET()


def assert_no_overflow(page):
    assert not page.locator('#editor').evaluate('node=>node.scrollWidth>node.clientWidth'), 'Editor horizontal overflow'
    assert not page.locator('.transport-preset-form').evaluate('node=>node.scrollWidth>node.clientWidth'), 'Form horizontal overflow'


def check_view(browser, origin, width, height):
    context = browser.new_context(viewport={'width': width, 'height': height})
    context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(origin) else route.abort())
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(origin + '/fixture')
    page.locator('#launch').click()
    panel = page.locator('#transport-panel')
    assert panel.is_visible() and panel.get_attribute('aria-modal') is None
    assert panel.bounding_box()['height'] <= height * .56
    page.locator('#map-action').click()
    assert page.evaluate('mapClicks') == 1, 'Nonmodal transport panel must leave map interactive'
    page.locator('[data-transport-edit]').click()
    assert panel.is_hidden() and page.locator('#settings-page').is_visible()
    page.locator('[data-create-transport-preset]').click()
    page.locator('.transport-preset-form').get_by_label('Название набора', exact=True).fill('На работу')
    values = [('bus', '49', '#3974d5'), ('tram', '49', '#bb4853'), ('trolley', '17', '#168a85'), ('bus', '10', '#8253b0'), ('bus', '50', '#b76c18')]
    for i, (kind, number, color) in enumerate(values, 1):
        if i > 1:
            page.locator('[data-add-transport-route]').click()
        page.get_by_label(f'Тип транспорта {i}', exact=True).select_option(kind)
        page.get_by_label(f'Номер маршрута {i}', exact=True).fill(number)
        page.get_by_label(f'Цвет маршрута {i}', exact=True).fill(color)
    assert_no_overflow(page)
    page.locator('.transport-preset-form').get_by_role('button', name='Сохранить', exact=True).click()
    page.locator('[data-edit-transport-preset]').wait_for()
    saved = page.evaluate('presets.list()')
    assert len(saved) == 1 and len(saved[0]['routes']) == 5, saved
    assert saved[0]['routes'][1] == {'type': 'tram', 'number': '49', 'color': '#bb4853'}
    assert page.evaluate('presets.activeId()') == saved[0]['id']
    assert page.evaluate("snapshots['spb-live'].enabled")
    page.evaluate("document.getElementById('settings-page').hidden=true;ui.open()")
    chosen = page.locator('[data-transport-preset]')
    assert chosen.get_attribute('aria-pressed') == 'true'
    assert chosen.locator('.transport-route-chip').count() == 5
    assert chosen.locator('.transport-route-chip strong').all_text_contents() == ['49', '49', '17', '10', '50']
    page.locator('[data-transport-hide]').click()
    assert not page.evaluate("snapshots['spb-live'].enabled")
    chosen.click()
    page.wait_for_function("snapshots['spb-live'].enabled")
    page.locator('[data-transport-all]').click()
    page.wait_for_function('presets.activeId()===null')
    assert page.evaluate("snapshots['spb-live'].settings.routes") == ''
    page.evaluate("snapshots['spb-live'].settings.route='49';ui.refresh()")
    assert page.locator('[data-transport-all]').get_attribute('aria-pressed') == 'false', 'A single route opened by search is not all routes'
    page.evaluate("snapshots['spb-live'].settings.route='';ui.refresh()")
    assert not page.evaluate('cameraCalls.length'), 'Preset switching must not move map camera'

    # Metro line and station controls are operational data, separate from preset settings.
    page.locator('[data-transport-tab="metro"]').click()
    page.locator('.transport-line-row').first.wait_for()
    assert page.locator('[data-metro-line]').count() == 7
    page.locator('[data-metro-line="2"]').click()
    page.wait_for_function("snapshots['spb-metro'].enabled && cameraCalls.length===1")
    assert page.locator('[data-metro-line="2"]').get_attribute('aria-pressed') == 'true'
    assert page.locator('.transport-line-title').inner_text() == 'Линия 2'
    page.locator('[data-metro-station="2-a"]').click()
    assert page.evaluate('cameraCalls.at(-1).options.center') == [30.3, 59.9]
    assert page.evaluate('cameraCalls.at(-1).kind') == 'station'
    before = page.evaluate('cameraCalls.length')
    page.evaluate('deferConfigure=true')
    page.locator('[data-metro-line="1"]').click()
    page.locator('.transport-close').click()
    page.evaluate('finishConfigure();deferConfigure=false')
    page.wait_for_function("snapshots['spb-metro'].settings.selectedLine==='1'")
    page.wait_for_timeout(100)
    assert page.evaluate('cameraCalls.length') == before, 'Late metro response must not move camera after close'
    page.evaluate("ui.open('metro')")
    assert page.evaluate('catalogCalls') == 1, 'Opening again reuses loaded catalog'
    page.keyboard.press('Escape')
    assert panel.is_hidden()

    # Persisted editing, validation, retry without duplicate presets and nested Back.
    page.evaluate("document.getElementById('settings-page').hidden=false;ui.showEditor()")
    page.locator('[data-edit-transport-preset]').click()
    assert page.evaluate('ui.editorBack()') is True
    assert page.evaluate('ui.editorBack()') is False
    page.locator('[data-edit-transport-preset]').click()
    page.get_by_label('Тип транспорта 2', exact=True).select_option('bus')
    page.locator('.transport-preset-form').get_by_role('button', name='Сохранить', exact=True).click()
    page.locator('.transport-preset-form .transport-status.is-error').wait_for()
    assert len(page.evaluate('presets.list()')) == 1
    page.get_by_label('Тип транспорта 2', exact=True).select_option('tram')
    page.locator('.transport-preset-form').get_by_label('Название набора', exact=True).fill('Домой')
    page.evaluate('failSelection=true')
    page.locator('.transport-preset-form').get_by_role('button', name='Сохранить', exact=True).click()
    page.locator('.transport-preset-form .transport-status.is-error').wait_for()
    assert page.evaluate('presets.list()[0].name') == 'Домой'
    page.locator('.transport-preset-form').get_by_role('button', name='Сохранить', exact=True).click()
    page.locator('[data-edit-transport-preset]').wait_for()
    assert len(page.evaluate('presets.list()')) == 1
    page.locator('[data-edit-transport-preset]').click()
    page.evaluate('deferSelection=true')
    page.locator('.transport-preset-form').get_by_role('button', name='Сохранить', exact=True).click()
    page.wait_for_function("typeof finishSelection==='function'")
    page.locator('.transport-preset-form').get_by_role('button', name='Отмена', exact=True).click()
    page.locator('[data-create-transport-preset]').click()
    page.locator('.transport-preset-form').get_by_label('Название набора', exact=True).fill('Новый черновик')
    page.evaluate('finishSelection();deferSelection=false')
    page.wait_for_timeout(60)
    assert page.locator('.transport-preset-form').get_by_label('Название набора', exact=True).input_value() == 'Новый черновик', 'Late save must not replace a newer draft'
    page.reload()
    assert page.evaluate('presets.list()[0].name') == 'Домой'
    assert len(page.evaluate('presets.list()[0].routes')) == 5
    page.evaluate("document.getElementById('settings-page').hidden=false;ui.showEditor()")
    page.locator('[data-edit-transport-preset]').click()
    page.locator('.transport-delete-preset').click()
    page.locator('[data-create-transport-preset]').wait_for()
    assert page.evaluate('presets.list()') == []
    assert not page.evaluate("snapshots['spb-live'].enabled"), 'Deleting an active but hidden preset must not turn on all transport'
    assert page.evaluate("snapshots['spb-live'].settings.routes") == ''
    page.evaluate('ui.dispose()')
    assert page.locator('#transport-panel').count() == 0
    assert page.evaluate('events.size') == 0
    assert not errors, errors
    context.close()


def check_app(browser, origin):
    context = browser.new_context(viewport={'width': 390, 'height': 844})
    requests = []

    def handle(route):
        url = route.request.url
        if url.startswith(origin):
            route.continue_()
        elif '/api/visary/geometry/vehicle?' in url:
            requests.append(url)
            current = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
            route.fulfill(json=[{'VehicleId': 100 + i, 'RouteId': 1278 + i,
                'Location': {'Longitude': 30.33 + i * .0002, 'Latitude': 59.93},
                'TransportType': kind, 'RouteShortName': str(number),
                'Direction': 90, 'DateTime': current}
                for i, (kind, number) in enumerate([('bus', 49), ('tram', 49), ('trolley', 17), ('bus', 10), ('bus', 50), ('bus', 999)])])
        else:
            route.abort()

    context.route('**/*', handle)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(origin)
    wait_for_map(page)
    page.wait_for_function("document.getElementById('loading').classList.contains('is-hidden') && transportUI")
    page.evaluate("map.jumpTo({center:[30.33,59.93],zoom:16,pitch:0,bearing:0})")
    before = page.evaluate("({center:map.getCenter().toArray(),zoom:map.getZoom(),bearing:map.getBearing(),pitch:map.getPitch()})")
    page.locator('#transport-open').click()
    page.locator('[data-transport-edit]').click()
    assert page.locator('#settings-page').is_visible()
    assert page.locator('#map').evaluate('node=>node.inert')
    page.locator('[data-create-transport-preset]').click()
    page.locator('.transport-preset-form').get_by_label('Название набора', exact=True).fill('Пять маршрутов')
    values = [('bus', '49', '#3974d5'), ('tram', '49', '#bb4853'), ('trolley', '17', '#168a85'), ('bus', '10', '#8253b0'), ('bus', '50', '#b76c18')]
    for i, (kind, number, color) in enumerate(values, 1):
        if i > 1:
            page.locator('[data-add-transport-route]').click()
        page.get_by_label(f'Тип транспорта {i}', exact=True).select_option(kind)
        page.get_by_label(f'Номер маршрута {i}', exact=True).fill(number)
        page.get_by_label(f'Цвет маршрута {i}', exact=True).fill(color)
    page.locator('.transport-preset-form').get_by_role('button', name='Сохранить', exact=True).click()
    page.locator('[data-edit-transport-preset]').wait_for()
    page.wait_for_function("moduleHost.get('spb-live').status==='ready'")
    features = page.evaluate("['bus','tram','trolley'].flatMap(type=>map.getSource('module-spb-live:'+type+'-source')._data.features)")
    assert len(features) == 5, features
    expected = {(kind, number): color for kind, number, color in values}
    for feature in features:
        props = feature['properties']
        # Type is encoded in the stable feature id; the same number for bus and
        # tram must remain distinct and receive each preset color independently.
        kind = feature['id'].split(':')[0]
        assert props['color'] == expected[(kind, props['route'])], props
        assert props['__moduleColor'] == props['color'], props
    assert page.evaluate("map.getLayer('module-spb-live:bus-point').type==='symbol' && map.getLayer('module-spb-live:bus-vehicle-icon').type==='symbol'")
    assert page.evaluate("({center:map.getCenter().toArray(),zoom:map.getZoom(),bearing:map.getBearing(),pitch:map.getPitch()})") == before
    page.locator('#settings-back').click()
    assert page.locator('#panel-settings').is_visible()
    page.locator('#settings-back').click()
    page.locator('#transport-open').click()
    assert page.locator('[data-transport-preset]').get_attribute('aria-pressed') == 'true'
    assert not page.locator('#map').evaluate('node=>node.inert')
    page.locator('[data-transport-tab="metro"]').click()
    page.locator('.transport-line-row').first.wait_for()
    page.locator('[data-metro-line="6"]').click()
    page.wait_for_function("moduleHost.get('spb-metro').status==='ready' && moduleHost.get('spb-metro').settings.selectedLine==='6'")
    assert page.locator('.transport-station').count() == 2
    assert page.locator('.transport-station').all_text_contents() == ['Путиловская', 'Юго-Западная'] or page.locator('.transport-station').all_text_contents() == ['Юго-Западная', 'Путиловская']
    metro_features = page.evaluate("map.getSource('module-spb-metro:lines-source')._data.features")
    assert len(metro_features) == 1 and metro_features[0]['properties']['line'] == '6'
    assert metro_features[0]['properties']['color'] == '#8b5a35'
    assert metro_features[0]['geometry']['type'] == 'MultiLineString'
    assert sum(map(len, metro_features[0]['geometry']['coordinates'])) > 2
    page.locator('.transport-station').first.click()
    page.wait_for_function('!map.isMoving()')
    page.keyboard.press('Escape')
    assert page.locator('#transport-panel').is_hidden()
    page.reload()
    wait_for_map(page)
    page.wait_for_function("transportUI && moduleHost.get('spb-metro').status==='ready' && moduleHost.get('spb-live').status==='ready'")
    assert len(page.evaluate('transportPresets.list()[0].routes')) == 5
    assert page.evaluate('transportPresets.activeId()') == page.evaluate('transportPresets.list()[0].id')
    assert page.evaluate("moduleHost.get('spb-metro').settings.selectedLine") == '6'
    page.locator('#transport-open').click()
    page.locator('[data-transport-hide]').click()
    assert not page.evaluate("moduleHost.get('spb-live').enabled")
    assert not page.evaluate("map.getSource('module-spb-live:bus-source')")
    page.evaluate("""() => { window.configureOriginal=moduleHost.configure.bind(moduleHost);
      moduleHost.configure=async(id,patch)=>{const result=await configureOriginal(id,patch);
      if(id==='spb-live')await new Promise(resolve=>window.releaseLiveConfigure=resolve);return result;}; }""")
    page.locator('[data-transport-preset]').click()
    page.wait_for_function("typeof releaseLiveConfigure==='function'")
    page.locator('[data-transport-hide]').click()
    page.evaluate('() => { releaseLiveConfigure();moduleHost.configure=configureOriginal; }')
    page.wait_for_timeout(100)
    assert not page.evaluate("moduleHost.get('spb-live').enabled"), 'Hide must cancel a pending selection before it can re-enable live transport'
    assert not page.evaluate("map.getSource('module-spb-live:bus-source')")
    assert requests
    assert not errors, errors
    context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--chromium')
    args = parser.parse_args()
    assets = Path(__file__).resolve().parents[1] / 'app/src/main/assets'
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(assets)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=args.chromium,
                args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
            for width, height in [(390, 844), (320, 568)]:
                check_view(browser, f'http://127.0.0.1:{server.server_port}', width, height)
            check_app(browser, f'http://127.0.0.1:{server.server_port}')
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print('Transport workspace UI OK: five-route colored presets, persistence, exact typed numbers, editor validation/retry/Back, nonmodal map, late-response camera guard and disposal at 390/320px; full app real MapLibre sources/colors, typed number collision, six-line offline metro and line-6 stations, reload and hide cleanup (synthetic live HTTP)')


if __name__ == '__main__':
    main()
