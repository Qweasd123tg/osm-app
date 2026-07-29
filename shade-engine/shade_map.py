#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import html
import json
import math
import multiprocessing
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import warnings
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Sequence

import folium
from shapely.affinity import translate
from shapely.geometry import (
    GeometryCollection,
    LineString,
    MultiPolygon,
    Polygon,
    box,
    mapping,
    shape,
)
from shapely.geometry.base import BaseGeometry
from shapely.ops import polygonize, unary_union

DEFAULT_BBOX = (59.93097, 30.32310, 59.93733, 30.34590)
OVERPASS_URLS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)
OVERPASS_URL = OVERPASS_URLS[0]
QUERY_VERSION = "building-ways-relations-parts-v2"
CACHE_META_KEY = "_shade_map_cache"
CACHE_SCHEMA_VERSION = 1
EARTH_RADIUS_M = 6_378_137.0
MAX_SHADOW_LENGTH_M = 350.0
DEFAULT_TIME_STEP_MIN = 30
BBOX_TOLERANCE = 1e-7


@dataclass(frozen=True)
class LocalProjection:
    """Small-area equirectangular projection centered on the rendered map."""

    center_lat: float
    center_lon: float

    @property
    def meters_per_degree_lat(self) -> float:
        return math.pi * EARTH_RADIUS_M / 180.0

    @property
    def meters_per_degree_lon(self) -> float:
        return self.meters_per_degree_lat * max(
            1e-6, math.cos(math.radians(self.center_lat))
        )

    def project_point(self, lon: float, lat: float) -> tuple[float, float]:
        return (
            (lon - self.center_lon) * self.meters_per_degree_lon,
            (lat - self.center_lat) * self.meters_per_degree_lat,
        )

    def unproject_point(self, x: float, y: float) -> tuple[float, float]:
        return (
            self.center_lon + x / self.meters_per_degree_lon,
            self.center_lat + y / self.meters_per_degree_lat,
        )

    def project(self, geometry: BaseGeometry) -> BaseGeometry:
        return transform_geometry(geometry, self.project_point)

    def unproject(self, geometry: BaseGeometry) -> BaseGeometry:
        return transform_geometry(geometry, self.unproject_point)


@dataclass(frozen=True)
class PreparedBuilding:
    geometry_m: BaseGeometry
    height_m: float
    min_height_m: float


@dataclass(frozen=True)
class ShadowScene:
    projection: LocalProjection
    buildings: tuple[PreparedBuilding, ...]
    ground_footprints: BaseGeometry
    clip_geometry: BaseGeometry | None


_WORKER_SCENE: ShadowScene | None = None
_WORKER_MAX_LENGTH_M = MAX_SHADOW_LENGTH_M


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="shade-map",
        description="Generate a static HTML city map with building shadows.",
    )
    parser.add_argument(
        "--bbox", default=",".join(map(str, DEFAULT_BBOX)), help="south,west,north,east"
    )
    parser.add_argument(
        "--time",
        help=(
            "Timezone-aware ISO time, for example 2026-05-22T17:44:00+03:00. "
            "Defaults to current local time."
        ),
    )
    parser.add_argument("--cache", default="cache/spb_center_buildings.json")
    parser.add_argument("--output", default="index.html")
    parser.add_argument(
        "--label", default="SPb area", help="Map label shown in the legend."
    )
    parser.add_argument(
        "--refresh", action="store_true", help="Fetch OSM buildings again."
    )
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
    altitude, azimuth = sun_position(when, center_lat, center_lon)
    cache_path = Path(args.cache)
    output_path = Path(args.output)

    buildings_json = load_or_fetch_buildings(
        cache_path,
        bbox,
        refresh=args.refresh,
        padding_m=args.max_shadow_m,
    )
    buildings = parse_buildings(buildings_json)
    if not buildings:
        raise SystemExit("No valid OSM buildings found for the requested area")

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
    initial_frame = frames[initial_frame_index]
    display_bounds = box(bbox[1], bbox[0], bbox[3], bbox[2])
    visible_buildings = [
        building
        for building in buildings
        if building["geometry"].intersects(display_bounds)
    ]

    fmap = folium.Map(
        location=[center_lat, center_lon],
        zoom_start=16,
        tiles="cartodbpositron",
        control_scale=True,
    )
    fmap.fit_bounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]])

    shadow_layer = folium.GeoJson(
        data=(
            empty_feature_collection()
            if len(frames) > 1
            else initial_frame["geometry"] or empty_feature_collection()
        ),
        name="Ground shadows",
        style_function=lambda _feature: {
            "color": "#1f2937",
            "weight": 0,
            "fillColor": "#1f2937",
            "fillOpacity": 0.34,
        },
        smooth_factor=0.5,
    )
    shadow_layer.add_to(fmap)

    confidence_features = []
    for building in visible_buildings:
        color, label = confidence_style(building["height_source"])
        confidence_features.append(
            {
                "type": "Feature",
                "properties": {
                    "color": color,
                    "confidence": label,
                    "height": f"{building['height_m']:.0f} m",
                    "name": safe_text(building["name"] or building["source"]),
                },
                "geometry": mapping(building["geometry"]),
            }
        )

    confidence_group = folium.GeoJson(
        data={"type": "FeatureCollection", "features": confidence_features},
        name="Height confidence",
        show=False,
        style_function=lambda feature: {
            "color": feature["properties"]["color"],
            "weight": 1,
            "fillColor": feature["properties"]["color"],
            "fillOpacity": 0.28,
        },
        tooltip=folium.GeoJsonTooltip(
            fields=["confidence", "height", "name"],
            aliases=["Source", "Height", "Building"],
            localize=True,
            sticky=False,
        ),
    )
    confidence_group.add_to(fmap)

    folium.LayerControl(collapsed=False).add_to(fmap)
    height_counts = Counter(
        building["height_source"] for building in visible_buildings
    )
    add_legend(
        fmap,
        args.label,
        when,
        altitude,
        azimuth,
        len(visible_buildings),
        initial_frame["polygon_count"],
        height_counts,
    )
    if len(frames) > 1:
        add_time_controls(
            fmap,
            shadow_layer,
            frames,
            initial_frame_index,
        )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fmap.save(str(output_path))
    print(
        f"Wrote {output_path} with {len(visible_buildings)} visible buildings "
        f"and {len(frames)} time frame(s)"
    )


def parse_bbox(value: str) -> tuple[float, float, float, float]:
    raw_parts = value.split(",")
    if len(raw_parts) != 4:
        raise SystemExit("--bbox must be south,west,north,east")
    try:
        parts = tuple(float(part.strip()) for part in raw_parts)
    except ValueError as exc:
        raise SystemExit("--bbox values must be numbers") from exc

    south, west, north, east = parts
    if not all(math.isfinite(part) for part in parts):
        raise SystemExit("--bbox values must be finite")
    if not (-90 <= south < north <= 90):
        raise SystemExit("--bbox must satisfy -90 <= south < north <= 90")
    if not (-180 <= west < east <= 180):
        raise SystemExit("--bbox must satisfy -180 <= west < east <= 180")
    return south, west, north, east


def parse_time(value: str | None) -> dt.datetime:
    if value is None:
        return dt.datetime.now().astimezone().replace(microsecond=0)
    try:
        parsed = dt.datetime.fromisoformat(value)
    except ValueError as exc:
        raise SystemExit(f'Invalid --time value: "{value}"') from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise SystemExit("--time must include a UTC offset, for example +03:00")
    return parsed


def load_or_fetch_buildings(
    cache_path: Path,
    bbox: tuple[float, float, float, float],
    *,
    refresh: bool,
    padding_m: float = MAX_SHADOW_LENGTH_M,
) -> dict:
    desired_query_bbox = expand_bbox(bbox, padding_m)
    if cache_path.exists() and not refresh:
        try:
            data = json.loads(cache_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise SystemExit(f"Could not read OSM cache {cache_path}: {exc}") from exc
        if cache_matches(data, bbox):
            cached_query_bbox = cache_query_bbox(data)
            if cached_query_bbox and not bbox_contains(
                cached_query_bbox, desired_query_bbox
            ):
                warnings.warn(
                    f"Cache {cache_path} predates padded OSM queries; use --refresh "
                    "once to include buildings that cast shadows from outside the map.",
                    stacklevel=2,
                )
            return data

    query = build_overpass_query(desired_query_bbox)
    data = fetch_overpass(query)

    if not isinstance(data.get("elements"), list):
        raise SystemExit("Overpass response did not contain an elements list")
    data["_shade_map_query_version"] = QUERY_VERSION
    data[CACHE_META_KEY] = {
        "schema_version": CACHE_SCHEMA_VERSION,
        "query_version": QUERY_VERSION,
        "requested_bbox": list(bbox),
        "query_bbox": list(desired_query_bbox),
        "padding_m": padding_m,
        "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(),
    }

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = cache_path.with_suffix(cache_path.suffix + ".tmp")
    temporary_path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    temporary_path.replace(cache_path)
    return data


def fetch_overpass(
    query: str,
    *,
    urls: Sequence[str] = OVERPASS_URLS,
    timeout_s: float = 75.0,
) -> dict:
    payload = urllib.parse.urlencode({"data": query}).encode()
    errors = []
    for url in urls:
        request = urllib.request.Request(
            url,
            data=payload,
            method="POST",
            headers={"User-Agent": "shade-map/0.2"},
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout_s) as response:
                data = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            reason = getattr(exc, "reason", exc)
            errors.append(f"{url}: {reason}")
            continue
        if isinstance(data, dict):
            return data
        errors.append(f"{url}: response was not a JSON object")

    details = "; ".join(errors) if errors else "no endpoints configured"
    raise SystemExit(f"Could not fetch OSM buildings from Overpass. Tried: {details}")


def build_overpass_query(
    bbox: tuple[float, float, float, float],
) -> str:
    south, west, north, east = bbox
    return f"""
    [out:json][timeout:25];
    (
      way["building"]({south},{west},{north},{east});
      way["building:part"]({south},{west},{north},{east});
      relation["building"]({south},{west},{north},{east});
      relation["building:part"]({south},{west},{north},{east});
    );
    out body;
    >;
    out skel qt;
    """


def cache_matches(
    data: dict, bbox: tuple[float, float, float, float]
) -> bool:
    metadata = data.get(CACHE_META_KEY)
    if not isinstance(metadata, dict):
        return False
    if metadata.get("schema_version") != CACHE_SCHEMA_VERSION:
        return False
    if metadata.get("query_version") != QUERY_VERSION:
        return False
    cached_bbox = metadata.get("requested_bbox")
    return bbox_equal(cached_bbox, bbox)


def cache_query_bbox(data: dict) -> tuple[float, float, float, float] | None:
    metadata = data.get(CACHE_META_KEY)
    if not isinstance(metadata, dict):
        return None
    value = metadata.get("query_bbox")
    if not isinstance(value, list) or len(value) != 4:
        return None
    try:
        return tuple(float(part) for part in value)
    except (TypeError, ValueError):
        return None


def bbox_equal(value: object, expected: Sequence[float]) -> bool:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return False
    try:
        return all(
            math.isclose(float(actual), wanted, abs_tol=BBOX_TOLERANCE)
            for actual, wanted in zip(value, expected, strict=True)
        )
    except (TypeError, ValueError):
        return False


def bbox_contains(
    outer: Sequence[float], inner: Sequence[float]
) -> bool:
    return (
        outer[0] <= inner[0] + BBOX_TOLERANCE
        and outer[1] <= inner[1] + BBOX_TOLERANCE
        and outer[2] >= inner[2] - BBOX_TOLERANCE
        and outer[3] >= inner[3] - BBOX_TOLERANCE
    )


def expand_bbox(
    bbox: tuple[float, float, float, float], padding_m: float
) -> tuple[float, float, float, float]:
    south, west, north, east = bbox
    center_lat = (south + north) / 2
    meters_per_degree_lat = math.pi * EARTH_RADIUS_M / 180.0
    meters_per_degree_lon = meters_per_degree_lat * max(
        1e-6, math.cos(math.radians(center_lat))
    )
    lat_padding = padding_m / meters_per_degree_lat
    lon_padding = padding_m / meters_per_degree_lon
    return (
        max(-90.0, south - lat_padding),
        max(-180.0, west - lon_padding),
        min(90.0, north + lat_padding),
        min(180.0, east + lon_padding),
    )


def parse_buildings(data: dict) -> list[dict]:
    elements = data.get("elements")
    if not isinstance(elements, list):
        raise ValueError("OSM data must contain an elements list")

    nodes = {
        item["id"]: (float(item["lon"]), float(item["lat"]))
        for item in elements
        if item.get("type") == "node" and "lat" in item and "lon" in item
    }
    ways = {
        item["id"]: item
        for item in elements
        if item.get("type") == "way" and "id" in item
    }
    buildings: list[dict] = []
    seen: set[tuple] = set()
    relation_member_way_ids: set[int] = set()

    for item in elements:
        tags = item.get("tags", {})
        if item.get("type") != "relation" or not is_building_tags(tags):
            continue
        geometry = relation_geometry(item, ways, nodes)
        if geometry.is_empty:
            continue
        relation_member_way_ids.update(
            member["ref"]
            for member in item.get("members", [])
            if member.get("type") == "way" and isinstance(member.get("ref"), int)
        )
        append_building(buildings, seen, geometry, tags, f"relation/{item['id']}")

    for item in elements:
        tags = item.get("tags", {})
        if item.get("type") != "way" or not is_building_tags(tags):
            continue
        if item.get("id") in relation_member_way_ids:
            continue
        geometry = way_geometry(item, nodes)
        if geometry.is_empty:
            continue
        append_building(buildings, seen, geometry, tags, f"way/{item['id']}")
    return buildings


def append_building(
    buildings: list[dict],
    seen: set[tuple],
    geometry: BaseGeometry,
    tags: dict,
    source: str,
) -> None:
    geometry = polygonal_geometry(geometry)
    if geometry.is_empty:
        return
    key = geometry_key(geometry)
    if key in seen:
        return
    seen.add(key)
    buildings.append(
        {
            "geometry": geometry,
            **height_info(tags, geometry),
            "name": str(tags.get("name", "")),
            "source": source,
            "kind": "part" if "building:part" in tags else "building",
        }
    )


def is_building_tags(tags: dict) -> bool:
    return "building" in tags or "building:part" in tags


def way_geometry(
    way: dict, nodes: dict[int, tuple[float, float]]
) -> BaseGeometry:
    node_ids = way.get("nodes", [])
    if len(node_ids) < 4 or node_ids[0] != node_ids[-1]:
        return Polygon()
    if any(node_id not in nodes for node_id in node_ids):
        return Polygon()
    return valid_polygon(Polygon(nodes[node_id] for node_id in node_ids))


def relation_geometry(
    relation: dict,
    ways: dict[int, dict],
    nodes: dict[int, tuple[float, float]],
) -> BaseGeometry:
    outer_polygons = member_polygons(relation, ways, nodes, roles={"", "outer"})
    inner_polygons = member_polygons(relation, ways, nodes, roles={"inner"})
    if not outer_polygons:
        return Polygon()

    assembled = []
    for outer in outer_polygons:
        holes = [
            list(inner.exterior.coords)
            for inner in inner_polygons
            if outer.covers(inner.representative_point())
        ]
        assembled.append(valid_polygon(Polygon(outer.exterior.coords, holes=holes)))
    return polygonal_geometry(unary_union(assembled))


def member_polygons(
    relation: dict,
    ways: dict[int, dict],
    nodes: dict[int, tuple[float, float]],
    *,
    roles: set[str],
) -> list[Polygon]:
    lines = []
    for member in relation.get("members", []):
        if member.get("type") != "way" or member.get("role", "") not in roles:
            continue
        way = ways.get(member.get("ref"))
        if not way:
            continue
        node_ids = way.get("nodes", [])
        if len(node_ids) < 2 or any(node_id not in nodes for node_id in node_ids):
            continue
        lines.append(LineString(nodes[node_id] for node_id in node_ids))
    if not lines:
        return []
    return [
        polygon
        for polygon in polygonize(unary_union(lines))
        if not polygon.is_empty and polygon.area > 0
    ]


def geometry_key(geometry: BaseGeometry) -> tuple:
    if isinstance(geometry, Polygon):
        return (
            "Polygon",
            canonical_ring(geometry.exterior.coords),
            tuple(
                sorted(canonical_ring(interior.coords) for interior in geometry.interiors)
            ),
        )
    if isinstance(geometry, MultiPolygon):
        return ("MultiPolygon", tuple(sorted(geometry_key(part) for part in geometry.geoms)))
    return (geometry.geom_type, geometry.wkb_hex)


def canonical_ring(coords: Iterable[Sequence[float]]) -> tuple[tuple[float, float], ...]:
    points = [(round(float(x), 7), round(float(y), 7)) for x, y, *_ in coords]
    if len(points) > 1 and points[0] == points[-1]:
        points.pop()
    if not points:
        return ()

    def minimum_rotation(values: list[tuple[float, float]]) -> tuple[tuple[float, float], ...]:
        smallest = min(values)
        candidates = [
            tuple(values[index:] + values[:index])
            for index, value in enumerate(values)
            if value == smallest
        ]
        return min(candidates)

    forward = minimum_rotation(points)
    backward = minimum_rotation(list(reversed(points)))
    return min(forward, backward)


def height_info(tags: dict, geometry: BaseGeometry) -> dict:
    height = parse_number(tags.get("height"))
    if height is not None:
        height_m = min(height, 180.0)
        height_source = "height"
    else:
        levels = parse_number(tags.get("building:levels"))
        if levels is not None:
            height_m = min(max(levels * 3.0, 3.0), 120.0)
            height_source = "levels"
        else:
            defaults = {
                "garage": 3,
                "garages": 3,
                "shed": 3,
                "kiosk": 3,
                "house": 8,
                "residential": 16,
                "apartments": 24,
                "commercial": 18,
                "office": 22,
                "retail": 14,
                "church": 28,
                "cathedral": 36,
            }
            building_type = tags.get("building") or tags.get("building:part")
            height_m = float(
                defaults.get(building_type, default_height_by_area(geometry))
            )
            height_source = "default"

    min_height = parse_nonnegative_number(tags.get("min_height"))
    if min_height is None:
        min_level = parse_nonnegative_number(tags.get("building:min_level"))
        min_height = (min_level or 0.0) * 3.0
    min_height = min(float(min_height), max(0.0, height_m - 0.1))
    return {
        "height_m": height_m,
        "min_height_m": min_height,
        "height_source": height_source,
    }


def default_height_by_area(geometry: BaseGeometry) -> float:
    area = footprint_area_m2(geometry)
    if area < 80:
        return 3
    if area < 250:
        return 4
    if area < 700:
        return 6
    if area < 1500:
        return 9
    return 14


def footprint_area_m2(geometry: BaseGeometry) -> float:
    if geometry.is_empty:
        return 0.0
    centroid = geometry.centroid
    projection = LocalProjection(center_lat=centroid.y, center_lon=centroid.x)
    return float(projection.project(geometry).area)


def confidence_style(source: str) -> tuple[str, str]:
    if source == "height":
        return "#2e7d32", "exact height"
    if source == "levels":
        return "#f9a825", "levels estimate"
    return "#c62828", "default height"


def parse_number(value: object) -> float | None:
    parsed = parse_nonnegative_number(value)
    if parsed is None or parsed <= 0:
        return None
    return parsed


def parse_nonnegative_number(value: object) -> float | None:
    if value is None:
        return None
    match = re.search(r"-?\d+(?:[.,]\d+)?", str(value))
    if match is None:
        return None
    parsed = float(match.group(0).replace(",", "."))
    if parsed < 0:
        return None
    lowered = str(value).lower()
    if "ft" in lowered or "feet" in lowered or "foot" in lowered:
        parsed *= 0.3048
    return parsed


def sun_position(date: dt.datetime, lat: float, lon: float) -> tuple[float, float]:
    if date.tzinfo is None or date.utcoffset() is None:
        raise ValueError("sun_position requires a timezone-aware datetime")
    rad = math.pi / 180
    julian = date.timestamp() / 86400 - 0.5 + 2440588
    n = julian - 2451545
    mean_longitude = normalize_degrees(280.46 + 0.9856474 * n)
    mean_anomaly = normalize_degrees(357.528 + 0.9856003 * n) * rad
    ecliptic_longitude = (
        mean_longitude
        + 1.915 * math.sin(mean_anomaly)
        + 0.02 * math.sin(2 * mean_anomaly)
    ) * rad
    obliquity = (23.439 - 0.0000004 * n) * rad
    right_ascension = math.atan2(
        math.cos(obliquity) * math.sin(ecliptic_longitude),
        math.cos(ecliptic_longitude),
    )
    declination = math.asin(math.sin(obliquity) * math.sin(ecliptic_longitude))
    gmst = (
        normalize_degrees(280.46061837 + 360.98564736629 * (julian - 2451545))
        * rad
    )
    hour_angle = gmst + lon * rad - right_ascension
    latitude = lat * rad
    altitude = math.asin(
        math.sin(latitude) * math.sin(declination)
        + math.cos(latitude) * math.cos(declination) * math.cos(hour_angle)
    )
    azimuth = math.atan2(
        -math.sin(hour_angle),
        math.tan(declination) * math.cos(latitude)
        - math.sin(latitude) * math.cos(hour_angle),
    )
    return math.degrees(altitude), normalize_degrees(math.degrees(azimuth))


def build_ground_shadow_geometry(
    buildings: list[dict],
    altitude_deg: float,
    sun_azimuth_deg: float,
    *,
    projection: LocalProjection,
    clip_bbox: tuple[float, float, float, float] | None = None,
    max_length_m: float = MAX_SHADOW_LENGTH_M,
) -> BaseGeometry:
    scene = prepare_shadow_scene(
        buildings,
        projection=projection,
        clip_bbox=clip_bbox,
    )
    return render_shadow_scene(
        scene,
        altitude_deg,
        sun_azimuth_deg,
        max_length_m=max_length_m,
    )


def prepare_shadow_scene(
    buildings: list[dict],
    *,
    projection: LocalProjection,
    clip_bbox: tuple[float, float, float, float] | None = None,
) -> ShadowScene:
    projected = tuple(
        PreparedBuilding(
            geometry_m=projection.project(building["geometry"]),
            height_m=float(building["height_m"]),
            min_height_m=float(building.get("min_height_m", 0.0)),
        )
        for building in buildings
        if not building["geometry"].is_empty
    )
    ground_geometries = [
        building.geometry_m
        for building in projected
        if building.min_height_m <= 0.01
    ]
    ground_footprints = (
        unary_union(ground_geometries) if ground_geometries else GeometryCollection()
    )
    if clip_bbox is None:
        clip_geometry = None
    else:
        south, west, north, east = clip_bbox
        clip_geometry = projection.project(box(west, south, east, north))
    return ShadowScene(
        projection=projection,
        buildings=projected,
        ground_footprints=ground_footprints,
        clip_geometry=clip_geometry,
    )


def render_shadow_scene(
    scene: ShadowScene,
    altitude_deg: float,
    sun_azimuth_deg: float,
    *,
    max_length_m: float = MAX_SHADOW_LENGTH_M,
    simplify_m: float = 0.15,
    min_polygon_area_m2: float = 0.2,
) -> BaseGeometry:
    if not scene.buildings or altitude_deg <= 0.5:
        return GeometryCollection()

    shadow_pieces = []
    for building in scene.buildings:
        shadow_pieces.extend(
            make_shadow_pieces(
                building.geometry_m,
                building.height_m,
                altitude_deg,
                sun_azimuth_deg,
                min_height_m=building.min_height_m,
                max_length_m=max_length_m,
            )
        )
    if not shadow_pieces:
        return GeometryCollection()

    ground_shadow = unary_union(shadow_pieces).difference(scene.ground_footprints)
    if scene.clip_geometry is not None:
        ground_shadow = ground_shadow.intersection(scene.clip_geometry)
    if simplify_m > 0 and not ground_shadow.is_empty:
        ground_shadow = ground_shadow.simplify(simplify_m, preserve_topology=True)
    if min_polygon_area_m2 > 0 and not ground_shadow.is_empty:
        ground_shadow = polygonal_geometry(
            GeometryCollection(
                [
                    polygon
                    for polygon in extract_polygons(ground_shadow)
                    if polygon.area >= min_polygon_area_m2
                ]
            )
        )
    return polygonal_geometry(scene.projection.unproject(ground_shadow))


def build_time_grid(when: dt.datetime, step_minutes: int) -> list[dt.datetime]:
    if step_minutes < 5 or step_minutes > 180:
        raise ValueError("time step must be between 5 and 180 minutes")
    if when.tzinfo is None or when.utcoffset() is None:
        raise ValueError("time grid requires a timezone-aware datetime")

    day_start = when.replace(hour=0, minute=0, second=0, microsecond=0)
    day_end = day_start + dt.timedelta(days=1) - dt.timedelta(minutes=1)
    moments = {
        day_start + dt.timedelta(minutes=minute)
        for minute in range(0, 24 * 60, step_minutes)
    }
    moments.add(day_end)
    moments.add(when.replace(microsecond=0))
    return sorted(moments)


def build_shadow_frames(
    scene: ShadowScene,
    when: dt.datetime,
    *,
    center_lat: float,
    center_lon: float,
    step_minutes: int = DEFAULT_TIME_STEP_MIN,
    max_length_m: float = MAX_SHADOW_LENGTH_M,
    workers: int = 1,
    animate: bool = True,
) -> tuple[list[dict], int]:
    moments = build_time_grid(when, step_minutes) if animate else [when]
    frames = []
    tasks = []
    for index, moment in enumerate(moments):
        altitude, azimuth = sun_position(moment, center_lat, center_lon)
        frames.append(
            {
                "time": moment.isoformat(),
                "label": moment.strftime("%H:%M"),
                "date_label": moment.strftime("%d.%m.%Y"),
                "altitude": round(altitude, 1),
                "azimuth": round(azimuth, 1),
                "shadow_bearing": round(normalize_degrees(azimuth + 180), 1),
                "geometry": None,
                "polygon_count": 0,
            }
        )
        if altitude > 0.5:
            tasks.append((index, altitude, azimuth))

    if tasks:
        worker_count = max(1, min(workers, len(tasks)))
        print(
            f"Rendering {len(tasks)} daylight shadow frames "
            f"with {worker_count} worker(s)...",
            file=sys.stderr,
            flush=True,
        )
        if worker_count == 1:
            results = (
                render_frame_geometry(
                    scene,
                    task,
                    max_length_m=max_length_m,
                )
                for task in tasks
            )
            for completed, result in enumerate(results, start=1):
                apply_frame_result(frames, result)
                report_frame_progress(completed, len(tasks))
        else:
            start_method = (
                "fork"
                if "fork" in multiprocessing.get_all_start_methods()
                else "spawn"
            )
            with concurrent.futures.ProcessPoolExecutor(
                max_workers=worker_count,
                initializer=initialize_shadow_worker,
                initargs=(scene, max_length_m),
                mp_context=multiprocessing.get_context(start_method),
            ) as executor:
                futures = [executor.submit(render_frame_worker, task) for task in tasks]
                for completed, future in enumerate(
                    concurrent.futures.as_completed(futures),
                    start=1,
                ):
                    apply_frame_result(frames, future.result())
                    report_frame_progress(completed, len(tasks))

    initial_index = min(
        range(len(moments)),
        key=lambda index: abs((moments[index] - when).total_seconds()),
    )
    return frames, initial_index


def initialize_shadow_worker(scene: ShadowScene, max_length_m: float) -> None:
    global _WORKER_SCENE, _WORKER_MAX_LENGTH_M
    _WORKER_SCENE = scene
    _WORKER_MAX_LENGTH_M = max_length_m


def render_frame_worker(task: tuple[int, float, float]) -> tuple[int, dict, int]:
    if _WORKER_SCENE is None:
        raise RuntimeError("shadow worker was not initialized")
    return render_frame_geometry(
        _WORKER_SCENE,
        task,
        max_length_m=_WORKER_MAX_LENGTH_M,
    )


def render_frame_geometry(
    scene: ShadowScene,
    task: tuple[int, float, float],
    *,
    max_length_m: float,
) -> tuple[int, dict, int]:
    index, altitude, azimuth = task
    geometry = render_shadow_scene(
        scene,
        altitude,
        azimuth,
        max_length_m=max_length_m,
    )
    return (
        index,
        compact_geometry_mapping(geometry),
        len(extract_polygons(geometry)),
    )


def apply_frame_result(frames: list[dict], result: tuple[int, dict, int]) -> None:
    index, geometry, polygon_count = result
    frames[index]["geometry"] = geometry
    frames[index]["polygon_count"] = polygon_count


def report_frame_progress(completed: int, total: int) -> None:
    if completed == total or completed % 5 == 0:
        print(f"  rendered {completed}/{total}", file=sys.stderr, flush=True)


def compact_geometry_mapping(
    geometry: BaseGeometry,
    *,
    precision: int = 7,
) -> dict:
    source = mapping(geometry)
    for candidate_precision in (precision, precision + 1):
        compact = round_nested_coordinates(
            source,
            precision=candidate_precision,
        )
        if geometry.is_empty or shape(compact).is_valid:
            return compact
    return source


def round_nested_coordinates(value: object, *, precision: int) -> object:
    if isinstance(value, float):
        return round(value, precision)
    if isinstance(value, tuple):
        return [
            round_nested_coordinates(item, precision=precision) for item in value
        ]
    if isinstance(value, list):
        return [
            round_nested_coordinates(item, precision=precision) for item in value
        ]
    if isinstance(value, dict):
        return {
            key: round_nested_coordinates(item, precision=precision)
            for key, item in value.items()
        }
    return value


def make_shadow_pieces(
    footprint_m: BaseGeometry,
    height_m: float,
    altitude_deg: float,
    sun_azimuth_deg: float,
    *,
    min_height_m: float = 0.0,
    max_length_m: float = MAX_SHADOW_LENGTH_M,
) -> list[BaseGeometry]:
    if footprint_m.is_empty or altitude_deg <= 0.5:
        return []
    tangent = math.tan(math.radians(altitude_deg))
    top_length_m = min(height_m / tangent, max_length_m)
    base_length_m = min(max(0.0, min_height_m) / tangent, top_length_m)
    shadow_bearing = normalize_degrees(sun_azimuth_deg + 180)
    top_offset = bearing_offset(top_length_m, shadow_bearing)
    base_offset = bearing_offset(base_length_m, shadow_bearing)

    pieces = []
    for polygon in extract_polygons(footprint_m):
        pieces.extend(sweep_polygon(polygon, base_offset, top_offset))
    return pieces


def make_shadow(
    footprint_m: BaseGeometry,
    height_m: float,
    altitude_deg: float,
    sun_azimuth_deg: float,
    *,
    min_height_m: float = 0.0,
    max_length_m: float = MAX_SHADOW_LENGTH_M,
) -> BaseGeometry:
    pieces = make_shadow_pieces(
        footprint_m,
        height_m,
        altitude_deg,
        sun_azimuth_deg,
        min_height_m=min_height_m,
        max_length_m=max_length_m,
    )
    if not pieces:
        return GeometryCollection()
    return polygonal_geometry(unary_union(pieces))


def sweep_polygon(
    polygon: Polygon,
    base_offset: tuple[float, float],
    top_offset: tuple[float, float],
) -> list[BaseGeometry]:
    base = translate(polygon, xoff=base_offset[0], yoff=base_offset[1])
    top = translate(polygon, xoff=top_offset[0], yoff=top_offset[1])
    pieces: list[BaseGeometry] = [base, top]
    for ring in (polygon.exterior, *polygon.interiors):
        coords = list(ring.coords)
        for start, end in zip(coords, coords[1:]):
            quad = valid_polygon(
                Polygon(
                    [
                        (start[0] + base_offset[0], start[1] + base_offset[1]),
                        (end[0] + base_offset[0], end[1] + base_offset[1]),
                        (end[0] + top_offset[0], end[1] + top_offset[1]),
                        (start[0] + top_offset[0], start[1] + top_offset[1]),
                    ]
                )
            )
            if not quad.is_empty:
                pieces.append(quad)
    return pieces


def bearing_offset(distance_m: float, bearing_deg: float) -> tuple[float, float]:
    angle = math.radians(bearing_deg)
    return distance_m * math.sin(angle), distance_m * math.cos(angle)


def make_building_union(buildings: list[dict]) -> BaseGeometry:
    polygons = [
        building["geometry"]
        for building in buildings
        if not building["geometry"].is_empty
        and building.get("min_height_m", 0.0) <= 0.01
    ]
    if not polygons:
        return GeometryCollection()
    return polygonal_geometry(unary_union(polygons))


def ground_shadow_polygons(
    shadow: BaseGeometry, building_union: BaseGeometry
) -> list[Polygon]:
    if shadow.is_empty:
        return []
    return extract_polygons(shadow.difference(building_union))


def valid_polygon(polygon: Polygon) -> BaseGeometry:
    if not polygon.is_valid:
        polygon = polygon.buffer(0)
    if polygon.is_empty or polygon.area <= 0:
        return Polygon()
    return polygonal_geometry(polygon)


def polygonal_geometry(geometry: BaseGeometry) -> BaseGeometry:
    polygons = extract_polygons(geometry)
    if not polygons:
        return GeometryCollection()
    if len(polygons) == 1:
        return polygons[0]
    return MultiPolygon(polygons)


def extract_polygons(geometry: BaseGeometry) -> list[Polygon]:
    if geometry.is_empty:
        return []
    if isinstance(geometry, Polygon):
        return [geometry] if geometry.area > 0 else []
    if isinstance(geometry, MultiPolygon):
        return [polygon for polygon in geometry.geoms if polygon.area > 0]
    if isinstance(geometry, GeometryCollection):
        polygons = []
        for item in geometry.geoms:
            polygons.extend(extract_polygons(item))
        return polygons
    return []


def transform_geometry(
    geometry: BaseGeometry,
    transform: Callable[[float, float], tuple[float, float]],
) -> BaseGeometry:
    if geometry.is_empty:
        return GeometryCollection()
    if isinstance(geometry, Polygon):
        exterior = [transform(x, y) for x, y, *_ in geometry.exterior.coords]
        interiors = [
            [transform(x, y) for x, y, *_ in ring.coords]
            for ring in geometry.interiors
        ]
        return valid_polygon(Polygon(exterior, holes=interiors))
    if isinstance(geometry, MultiPolygon):
        return polygonal_geometry(
            MultiPolygon(
                [
                    transformed
                    for polygon in geometry.geoms
                    for transformed in extract_polygons(
                        transform_geometry(polygon, transform)
                    )
                ]
            )
        )
    if isinstance(geometry, GeometryCollection):
        return polygonal_geometry(
            GeometryCollection(
                [transform_geometry(item, transform) for item in geometry.geoms]
            )
        )
    raise TypeError(f"Unsupported geometry type: {geometry.geom_type}")


def polygon_locations(polygon: Polygon) -> list[list[tuple[float, float]]]:
    rings = [latlon_ring(polygon.exterior.coords)]
    rings.extend(latlon_ring(interior.coords) for interior in polygon.interiors)
    return rings


def latlon_ring(coords: object) -> list[tuple[float, float]]:
    return [(lat, lon) for lon, lat in coords]


def offset_point(
    lat: float, lon: float, distance_m: float, bearing_deg: float
) -> tuple[float, float]:
    delta = distance_m / EARTH_RADIUS_M
    theta = math.radians(bearing_deg)
    phi1 = math.radians(lat)
    lambda1 = math.radians(lon)
    phi2 = math.asin(
        math.sin(phi1) * math.cos(delta)
        + math.cos(phi1) * math.sin(delta) * math.cos(theta)
    )
    lambda2 = lambda1 + math.atan2(
        math.sin(theta) * math.sin(delta) * math.cos(phi1),
        math.cos(delta) - math.sin(phi1) * math.sin(phi2),
    )
    return math.degrees(phi2), math.degrees(lambda2)


def normalize_degrees(value: float) -> float:
    return value % 360


def safe_text(value: object) -> str:
    return html.escape(str(value), quote=True)


def empty_feature_collection() -> dict:
    return {"type": "FeatureCollection", "features": []}


def json_for_script(value: object) -> str:
    return (
        json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        .replace("&", "\\u0026")
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
    )


def add_time_controls(
    fmap: folium.Map,
    shadow_layer: folium.GeoJson,
    frames: list[dict],
    initial_index: int,
) -> None:
    initial = frames[initial_index]
    sun_text = (
        "солнце ниже горизонта"
        if initial["altitude"] <= 0.5
        else f"солнце {initial['altitude']:.0f}° · тень {initial['shadow_bearing']:.0f}°"
    )
    control = f"""
    <style>
      #shade-timeline {{
        position: fixed;
        left: 50%;
        bottom: 18px;
        transform: translateX(-50%);
        z-index: 10000;
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
      @media (max-width: 1050px) {{
        .shade-legend {{ display: none; }}
      }}
      @media (max-width: 520px) {{
        #shade-timeline {{ bottom: 10px; padding: 9px 11px 8px; }}
        .shade-time-copy strong {{ font-size: 14px; }}
      }}
    </style>
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
    fmap.get_root().html.add_child(folium.Element(control))

    script = f"""
    const shadeFrames = {json_for_script(frames)};
    const shadeLayer = {shadow_layer.get_name()};
    const shadeRange = document.getElementById("shade-range");
    const shadePlay = document.getElementById("shade-play");
    const shadeTimeline = document.getElementById("shade-timeline");
    const shadeTimeValue = document.getElementById("shade-time-value");
    const shadeSunValue = document.getElementById("shade-sun-value");
    let shadeTimer = null;

    function setShadeText(id, value) {{
      const element = document.getElementById(id);
      if (element) element.textContent = value;
    }}

    function showShadeFrame(index) {{
      const safeIndex = Math.max(0, Math.min(shadeFrames.length - 1, Number(index)));
      const frame = shadeFrames[safeIndex];
      shadeRange.value = String(safeIndex);
      shadeLayer.clearLayers();
      if (frame.geometry) shadeLayer.addData(frame.geometry);
      shadeTimeValue.textContent = frame.date_label + " · " + frame.label;
      shadeSunValue.textContent = frame.altitude <= 0.5
        ? "солнце ниже горизонта"
        : "солнце " + Math.round(frame.altitude) + "° · тень "
          + Math.round(frame.shadow_bearing) + "°";
      setShadeText("shade-legend-time", frame.date_label + " " + frame.label);
      setShadeText(
        "shade-legend-altitude",
        frame.altitude <= 0.5 ? "below horizon" : Math.round(frame.altitude) + " deg"
      );
      setShadeText("shade-legend-sun", Math.round(frame.azimuth) + " deg");
      setShadeText("shade-legend-bearing", Math.round(frame.shadow_bearing) + " deg");
      setShadeText("shade-polygon-count", String(frame.polygon_count));
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
    L.DomEvent.disableClickPropagation(shadeTimeline);
    L.DomEvent.disableScrollPropagation(shadeTimeline);
    showShadeFrame({initial_index});
    """
    fmap.get_root().script.add_child(folium.Element(script))


def add_legend(
    fmap: folium.Map,
    label: str,
    when: dt.datetime,
    altitude: float,
    azimuth: float,
    building_count: int,
    shadow_count: int,
    height_counts: Counter,
) -> None:
    shadow_bearing = normalize_degrees(azimuth + 180)
    safe_label = safe_text(label)
    daylight = "below horizon" if altitude <= 0.5 else f"{altitude:.0f} deg"
    legend = f"""
    <div class="shade-legend" style="
      position: fixed;
      bottom: 24px;
      left: 24px;
      z-index: 9999;
      max-width: min(310px, calc(100vw - 48px));
      background: rgba(255,255,255,.96);
      border: 1px solid #bbb;
      border-radius: 8px;
      padding: 10px 12px;
      font: 13px/1.4 system-ui, sans-serif;
      box-shadow: 0 2px 12px rgba(0,0,0,.18);
    ">
      <div><b>Building shadows</b></div>
      <div><span style="color:#1f2937">■</span> unified shadow on ground</div>
      <div style="margin-top:6px">
        {safe_label},
        <span id="shade-legend-time">{when.strftime("%d.%m.%Y %H:%M")}</span>
      </div>
      <div>Sun altitude: <span id="shade-legend-altitude">{daylight}</span></div>
      <div>Sun bearing: <span id="shade-legend-sun">{azimuth:.0f} deg</span></div>
      <div>Shadow bearing: <span id="shade-legend-bearing">{shadow_bearing:.0f} deg</span></div>
      <div>Visible buildings: {building_count}</div>
      <div>Shadow polygons: <span id="shade-polygon-count">{shadow_count}</span></div>
      <div style="margin-top:6px"><b>Height confidence layer</b></div>
      <div><span style="color:#2e7d32">■</span> height: {height_counts.get("height", 0)}</div>
      <div><span style="color:#f9a825">■</span> levels: {height_counts.get("levels", 0)}</div>
      <div><span style="color:#c62828">■</span> default: {height_counts.get("default", 0)}</div>
    </div>
    """
    fmap.get_root().html.add_child(folium.Element(legend))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("Cancelled", file=sys.stderr)
        raise SystemExit(130) from None
