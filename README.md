# Слои — прототип картографического приложения

Монорепозиторий картографического приложения с необычными слоями. Здесь лежат
Android-прототип, Python-движок расчёта теней, тесты, исходные OSM-кэши и готовые
web-примеры. Первый рабочий слой показывает движение теней от зданий в течение
дня.

## Что уже работает

- мобильная карта на MapLibre;
- локально встроенные здания и 49 кадров теней для района Московской в
  Санкт-Петербурге;
- ползунок времени и автоматическое воспроизведение;
- режимы 2D и 3D;
- светлая и тёмная подложки;
- включение зданий и теней, прозрачность теней;
- фильтр достоверности высоты зданий;
- карточка здания по нажатию;
- заготовки каталога для следующих слоёв;
- сохранение выбранных настроек в `localStorage`.

MapLibre, геометрия зданий и все кадры теней лежат внутри APK. Интернет пока
нужен только для растровой подложки CARTO.

Python-движок отдельно строит статические 2D/3D-карты для любого загруженного
района и рассчитывает кадры на весь день. Подробнее: [`shade-engine/README.md`](shade-engine/README.md).

## Сборка

Нужны JDK 17 и Android SDK 36. Отдельно устанавливать Gradle не требуется:
репозиторий использует Gradle Wrapper.

```bash
git clone https://github.com/Qweasd123tg/osm-app.git
cd osm-app
./gradlew assembleDebug
```

Готовый APK появится здесь:

```text
app/build/outputs/apk/debug/app-debug.apk
```

Проект также можно открыть в Android Studio и запустить на телефоне обычной
кнопкой Run.

## Устройство проекта

- `app/src/main/java/app/sloi/map/MainActivity.java` — нативная Android-оболочка;
- `app/src/main/assets/index.html` — интерфейс карты и каталог слоёв;
- `app/src/main/assets/map-data.js` — встроенная демо-геометрия;
- `app/src/main/assets/vendor/` — локальная сборка MapLibre GL JS;
- `shade-engine/` — расчёт теней, OSM-загрузчик и web-экспорт;
- `shade-engine/cache/` — два сохранённых OSM-района для работы без Overpass;
- `shade-engine/examples/` — готовые 2D- и 3D-карты;
- `shade-engine/tests/` — регрессионные тесты геометрии и временной шкалы;
- `tools/build_map_data.py` — обновление данных из результата Shade Map;
- `tools/check_assets.mjs` — быстрая проверка web-части без Android SDK.
- [`ROADMAP.md`](ROADMAP.md) — текущее направление развития.

## Обновление демо-данных

Установи Python-движок и пересобери 3D-пример:

```bash
python -m venv shade-engine/.venv
source shade-engine/.venv/bin/activate
python -m pip install -e shade-engine

shade-map-3d \
  --bbox 59.8458,30.3100,59.8584,30.3358 \
  --time 2026-07-17T15:00:00+03:00 \
  --cache shade-engine/cache/moskovskaya_buildings.json \
  --label "Метро Московская" \
  --output shade-engine/examples/3d.html

python tools/build_map_data.py
node tools/check_assets.mjs
```

`build_map_data.py` извлекает здания и все временные кадры из нового примера и
обновляет данные внутри APK.

## Проверки без Android SDK

```bash
node tools/check_assets.mjs
shade-engine/.venv/bin/python -m unittest discover -s shade-engine/tests -v
```

## Что не перенесено

Экспериментальный проект `ветер` намеренно не включён: он использовался только
как пример и не относится к текущему продукту.

Подложка: © OpenStreetMap contributors, © CARTO. Движок: MapLibre GL JS.
