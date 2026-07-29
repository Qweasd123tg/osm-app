#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import math
import os
from pathlib import Path

from shapely.geometry import box, mapping

from shade_map import (
    DEFAULT_BBOX,
    DEFAULT_TIME_STEP_MIN,
    MAX_SHADOW_LENGTH_M,
    LocalProjection,
    build_shadow_frames,
    load_or_fetch_buildings,
    parse_bbox,
    parse_buildings,
    parse_time,
    prepare_shadow_scene,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="shade-map-3d",
        description="Generate a MapLibre 3D building and ground-shadow map.",
    )
    parser.add_argument(
        "--bbox", default=",".join(map(str, DEFAULT_BBOX)), help="south,west,north,east"
    )
    parser.add_argument(
        "--time",
        help="Timezone-aware ISO time. Defaults to current local time.",
    )
    parser.add_argument("--cache", default="cache/spb_center_buildings.json")
    parser.add_argument("--output", default="3d.html")
    parser.add_argument("--label", default="SPb area")
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument(
        "--max-shadow-m",
        type=float,
        default=MAX_SHADOW_LENGTH_M,
        help="Maximum rendered shadow length and OSM query padding in meters.",
    )
    parser.add_argument(
        "--time-step-min",
        type=int,
        default=DEFAULT_TIME_STEP_MIN,
        help="Minutes between animation frames. Defaults to 30.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=min(4, os.cpu_count() or 1),
        help="Worker processes used to render animation frames.",
    )
    parser.add_argument(
        "--no-animation",
        action="store_true",
        help="Render only the selected time without an interactive timeline.",
    )
    return parser


def main() -> None:
    args = build_parser().parse_args()
    bbox = parse_bbox(args.bbox)
    when = parse_time(args.time)
    if not math.isfinite(args.max_shadow_m) or args.max_shadow_m <= 0:
        raise SystemExit("--max-shadow-m must be a positive number")
    if not 5 <= args.time_step_min <= 180:
        raise SystemExit("--time-step-min must be between 5 and 180")
    if not 1 <= args.workers <= 16:
        raise SystemExit("--workers must be between 1 and 16")

    center_lat = (bbox[0] + bbox[2]) / 2
    center_lon = (bbox[1] + bbox[3]) / 2
    data = load_or_fetch_buildings(
        Path(args.cache),
        bbox,
        refresh=args.refresh,
        padding_m=args.max_shadow_m,
    )
    buildings = parse_buildings(data)
    if not buildings:
        raise SystemExit("No valid OSM buildings found for the requested area")

    display_bounds = box(bbox[1], bbox[0], bbox[3], bbox[2])
    visible_buildings = [
        building
        for building in buildings
        if building["geometry"].intersects(display_bounds)
    ]
    projection = LocalProjection(center_lat=center_lat, center_lon=center_lon)
    scene = prepare_shadow_scene(
        buildings,
        projection=projection,
        clip_bbox=bbox,
    )
    frames, initial_frame_index = build_shadow_frames(
        scene,
        when,
        center_lat=center_lat,
        center_lon=center_lon,
        step_minutes=args.time_step_min,
        max_length_m=args.max_shadow_m,
        workers=args.workers,
        animate=not args.no_animation,
    )

    building_features = [
        {
            "type": "Feature",
            "properties": {
                "height": building["height_m"],
                "min_height": building.get("min_height_m", 0.0),
                "height_source": building["height_source"],
                "osm_source": building["source"],
                "name": building["name"] or building["source"],
                "color": confidence_color(building["height_source"]),
            },
            "geometry": mapping(building["geometry"]),
        }
        for building in visible_buildings
    ]

    rendered = render_html(
        label=args.label,
        bbox=bbox,
        center_lat=center_lat,
        center_lon=center_lon,
        buildings={"type": "FeatureCollection", "features": building_features},
        frames=frames,
        initial_frame_index=initial_frame_index,
    )
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(rendered, encoding="utf-8")
    print(
        f"Wrote {output_path} with {len(building_features)} visible buildings "
        f"and {len(frames)} time frame(s)"
    )


def confidence_color(source: str) -> str:
    if source == "height":
        return "#2e7d32"
    if source == "levels":
        return "#f9a825"
    return "#c62828"


def json_for_script(value: object) -> str:
    """Serialize JSON without allowing data to terminate the script element."""

    return (
        json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        .replace("&", "\\u0026")
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
    )


def shadow_feature_collection(geometry: dict | None) -> dict:
    if geometry is None:
        return {"type": "FeatureCollection", "features": []}
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {},
                "geometry": geometry,
            }
        ],
    }


def timeline_markup(frames: list[dict], initial_index: int) -> str:
    if len(frames) <= 1:
        return ""
    initial = frames[initial_index]
    sun_text = (
        "солнце ниже горизонта"
        if initial["altitude"] <= 0.5
        else f"солнце {initial['altitude']:.0f}° · тень {initial['shadow_bearing']:.0f}°"
    )
    return f"""
    <div id="shade-timeline" role="group" aria-label="Время и движение тени">
      <div class="shade-time-row">
        <button id="shade-play" type="button" aria-label="Запустить анимацию"
                aria-pressed="false">▶</button>
        <div class="shade-time-copy">
          <strong id="shade-time-value">{initial['date_label']} · {initial['label']}</strong>
          <span id="shade-sun-value">{sun_text}</span>
        </div>
      </div>
      <input id="shade-range" type="range" min="0" max="{len(frames) - 1}"
             value="{initial_index}" step="1" aria-label="Время суток">
      <div class="shade-time-ends">
        <span>{frames[0]['label']}</span><span>{frames[-1]['label']}</span>
      </div>
    </div>
    """


def timeline_script(frames: list[dict], initial_index: int) -> str:
    if len(frames) <= 1:
        return ""
    return f"""
      const shadeRange = document.getElementById("shade-range");
      const shadePlay = document.getElementById("shade-play");
      const shadeTimeline = document.getElementById("shade-timeline");
      const shadeTimeValue = document.getElementById("shade-time-value");
      const shadeSunValue = document.getElementById("shade-sun-value");
      let shadeTimer = null;

      function shadowData(geometry) {{
        if (!geometry) return {{ type: "FeatureCollection", features: [] }};
        return {{
          type: "FeatureCollection",
          features: [{{ type: "Feature", properties: {{}}, geometry }}]
        }};
      }}

      function showShadeFrame(index) {{
        const safeIndex = Math.max(0, Math.min(shadeFrames.length - 1, Number(index)));
        const frame = shadeFrames[safeIndex];
        shadeRange.value = String(safeIndex);
        const source = map.getSource("shadows");
        if (source) source.setData(shadowData(frame.geometry));
        shadeTimeValue.textContent = frame.date_label + " · " + frame.label;
        shadeSunValue.textContent = frame.altitude <= 0.5
          ? "солнце ниже горизонта"
          : "солнце " + Math.round(frame.altitude) + "° · тень "
            + Math.round(frame.shadow_bearing) + "°";
        document.getElementById("panel-time").textContent =
          frame.date_label + " " + frame.label;
        document.getElementById("panel-sun").textContent = frame.altitude <= 0.5
          ? "Солнце ниже горизонта"
          : "Солнце: " + Math.round(frame.azimuth) + "°, высота "
            + Math.round(frame.altitude) + "°";
        document.getElementById("panel-shadow").textContent =
          "Тень: " + Math.round(frame.shadow_bearing) + "°";
      }}

      function stopShadePlayback() {{
        if (shadeTimer !== null) window.clearInterval(shadeTimer);
        shadeTimer = null;
        shadePlay.textContent = "▶";
        shadePlay.setAttribute("aria-label", "Запустить анимацию");
        shadePlay.setAttribute("aria-pressed", "false");
      }}

      shadeRange.addEventListener("input", () => {{
        stopShadePlayback();
        showShadeFrame(shadeRange.value);
      }});
      shadePlay.addEventListener("click", () => {{
        if (shadeTimer !== null) {{
          stopShadePlayback();
          return;
        }}
        if (Number(shadeRange.value) >= shadeFrames.length - 1) showShadeFrame(0);
        shadePlay.textContent = "❚❚";
        shadePlay.setAttribute("aria-label", "Остановить анимацию");
        shadePlay.setAttribute("aria-pressed", "true");
        shadeTimer = window.setInterval(() => {{
          const next = Number(shadeRange.value) + 1;
          if (next >= shadeFrames.length) {{
            stopShadePlayback();
            return;
          }}
          showShadeFrame(next);
        }}, 280);
      }});
      for (const eventName of ["mousedown", "dblclick", "wheel", "touchstart"]) {{
        shadeTimeline.addEventListener(eventName, (event) => event.stopPropagation());
      }}
      showShadeFrame({initial_index});
    """


def render_html(
    *,
    label: str,
    bbox: tuple[float, float, float, float],
    center_lat: float,
    center_lon: float,
    buildings: dict,
    frames: list[dict],
    initial_frame_index: int,
) -> str:
    initial = frames[initial_frame_index]
    safe_label = html.escape(label, quote=True)
    south, west, north, east = bbox
    timeline = timeline_markup(frames, initial_frame_index)
    timeline_js = timeline_script(frames, initial_frame_index)
    initial_shadows = shadow_feature_collection(
        None if len(frames) > 1 else initial["geometry"]
    )
    return f"""<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>3D тени: {safe_label}</title>
    <link href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css" rel="stylesheet">
    <script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
    <style>
      html, body, #map {{ width: 100%; height: 100%; margin: 0; }}
      body {{ font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
      .panel {{
        position: fixed;
        left: 14px;
        bottom: 14px;
        z-index: 2;
        width: min(290px, calc(100vw - 52px));
        padding: 12px;
        border: 1px solid #c8ccd2;
        border-radius: 8px;
        background: rgba(255,255,255,.94);
        box-shadow: 0 4px 18px rgba(0,0,0,.18);
        color: #17202a;
        font-size: 13px;
        line-height: 1.35;
      }}
      .panel b {{ display: block; margin-bottom: 6px; font-size: 14px; }}
      .row {{ display: flex; align-items: center; gap: 7px; margin-top: 4px; }}
      .swatch {{ width: 14px; height: 14px; border-radius: 3px; display: inline-block; }}
      .controls {{ margin-top: 10px; display: flex; gap: 8px; }}
      .controls button {{
        min-height: 34px;
        padding: 4px 10px;
        border: 1px solid #c8ccd2;
        border-radius: 6px;
        background: #fff;
        cursor: pointer;
        font: inherit;
      }}
      .controls button[aria-pressed="false"] {{ opacity: .58; }}
      #shade-timeline {{
        position: fixed;
        left: 50%;
        bottom: 18px;
        transform: translateX(-50%);
        z-index: 3;
        box-sizing: border-box;
        width: min(590px, calc(100vw - 32px));
        padding: 11px 14px 10px;
        border: 1px solid rgba(31,41,55,.22);
        border-radius: 12px;
        background: rgba(255,255,255,.96);
        box-shadow: 0 4px 20px rgba(0,0,0,.2);
        color: #17202a;
        font: 13px/1.3 system-ui, sans-serif;
      }}
      .shade-time-row {{ display: flex; align-items: center; gap: 11px; }}
      .shade-time-copy {{ min-width: 0; flex: 1; }}
      .shade-time-copy strong {{ display: block; font-size: 15px; }}
      .shade-time-copy span {{ color: #58616d; }}
      #shade-play {{
        width: 40px;
        height: 40px;
        flex: 0 0 auto;
        border: 1px solid #b8c0ca;
        border-radius: 50%;
        background: #fff;
        color: #17202a;
        cursor: pointer;
        font: 17px/1 system-ui, sans-serif;
      }}
      #shade-play:hover {{ background: #f3f5f7; }}
      #shade-range {{ width: 100%; margin: 9px 0 2px; accent-color: #283442; }}
      .shade-time-ends {{ display: flex; justify-content: space-between; color: #69727e; }}
      @media (max-width: 1050px) {{ .panel {{ display: none; }} }}
      @media (max-width: 520px) {{
        #shade-timeline {{ bottom: 10px; padding: 9px 11px 8px; }}
        .shade-time-copy strong {{ font-size: 14px; }}
      }}
    </style>
  </head>
  <body>
    <div id="map"></div>
    <div class="panel">
      <b>{safe_label}: 3D</b>
      <div id="panel-time">{initial['date_label']} {initial['label']}</div>
      <div id="panel-sun">Солнце: {initial['azimuth']:.0f}°, высота {initial['altitude']:.0f}°</div>
      <div id="panel-shadow">Тень: {initial['shadow_bearing']:.0f}°</div>
      <div class="row"><span class="swatch" style="background:#111827"></span>тень на земле</div>
      <div class="row"><span class="swatch" style="background:#2e7d32"></span>height</div>
      <div class="row"><span class="swatch" style="background:#f9a825"></span>levels</div>
      <div class="row"><span class="swatch" style="background:#c62828"></span>default</div>
      <div class="controls">
        <button id="toggleShadows" type="button" aria-pressed="true">Тени</button>
        <button id="toggleBuildings" type="button" aria-pressed="true">Здания</button>
      </div>
    </div>
    {timeline}
    <script>
      const buildings = {json_for_script(buildings)};
      const shadeFrames = {json_for_script(frames)};
      const shadows = {json_for_script(initial_shadows)};

      const map = new maplibregl.Map({{
        container: "map",
        center: [{center_lon}, {center_lat}],
        zoom: 15.6,
        pitch: 58,
        bearing: -22,
        hash: true,
        style: {{
          version: 8,
          sources: {{
            carto: {{
              type: "raster",
              tiles: ["https://a.basemaps.cartocdn.com/light_all/{{z}}/{{x}}/{{y}}.png"],
              tileSize: 256,
              attribution: "© OpenStreetMap contributors © CARTO"
            }}
          }},
          layers: [
            {{ id: "carto", type: "raster", source: "carto" }}
          ]
        }}
      }});
      map.addControl(new maplibregl.NavigationControl({{ visualizePitch: true }}), "top-right");

      map.on("load", () => {{
        map.fitBounds([[{west}, {south}], [{east}, {north}]], {{ padding: 24, duration: 0 }});
        map.addSource("shadows", {{ type: "geojson", data: shadows }});
        map.addSource("buildings", {{ type: "geojson", data: buildings }});

        map.addLayer({{
          id: "ground-shadows",
          type: "fill",
          source: "shadows",
          paint: {{
            "fill-color": "#111827",
            "fill-opacity": 0.36
          }}
        }});

        map.addLayer({{
          id: "buildings-3d",
          type: "fill-extrusion",
          source: "buildings",
          paint: {{
            "fill-extrusion-color": ["get", "color"],
            "fill-extrusion-height": ["get", "height"],
            "fill-extrusion-base": ["get", "min_height"],
            "fill-extrusion-opacity": 0.72
          }}
        }});

        map.on("click", "buildings-3d", (event) => {{
          const props = event.features[0].properties;
          const content = document.createElement("div");
          const title = document.createElement("b");
          title.textContent = String(props.name);
          content.append(title, document.createElement("br"));
          content.append(String(Math.round(props.height)) + " m", document.createElement("br"));
          content.append(String(props.height_source) + " · " + String(props.osm_source));
          new maplibregl.Popup()
            .setLngLat(event.lngLat)
            .setDOMContent(content)
            .addTo(map);
        }});
        {timeline_js}
      }});

      function toggleLayer(id, button) {{
        const visibility = map.getLayoutProperty(id, "visibility");
        const visible = visibility === "none";
        map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
        button.setAttribute("aria-pressed", String(visible));
      }}
      const shadowsButton = document.getElementById("toggleShadows");
      const buildingsButton = document.getElementById("toggleBuildings");
      shadowsButton.onclick = () => toggleLayer("ground-shadows", shadowsButton);
      buildingsButton.onclick = () => toggleLayer("buildings-3d", buildingsButton);
    </script>
  </body>
</html>
"""


if __name__ == "__main__":
    main()
