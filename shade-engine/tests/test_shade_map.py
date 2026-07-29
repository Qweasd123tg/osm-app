from __future__ import annotations

import datetime as dt
import unittest
import urllib.error
from unittest import mock

from shapely.geometry import MultiPolygon, Point, Polygon, box, shape

import shade_map
from shade_3d import json_for_script, shadow_feature_collection, timeline_markup


class InputValidationTest(unittest.TestCase):
    def test_parse_bbox_accepts_valid_order(self) -> None:
        self.assertEqual(
            shade_map.parse_bbox("59.9,30.2,60.0,30.4"),
            (59.9, 30.2, 60.0, 30.4),
        )

    def test_parse_bbox_rejects_reversed_latitudes(self) -> None:
        with self.assertRaises(SystemExit):
            shade_map.parse_bbox("60.0,30.2,59.9,30.4")

    def test_parse_time_requires_timezone(self) -> None:
        with self.assertRaises(SystemExit):
            shade_map.parse_time("2026-07-17T15:00:00")

    def test_sun_position_requires_timezone(self) -> None:
        with self.assertRaises(ValueError):
            shade_map.sun_position(dt.datetime(2026, 7, 17, 15), 59.93, 30.33)


class CacheTest(unittest.TestCase):
    def setUp(self) -> None:
        self.bbox = (59.9, 30.2, 60.0, 30.4)
        self.data = {
            shade_map.CACHE_META_KEY: {
                "schema_version": shade_map.CACHE_SCHEMA_VERSION,
                "query_version": shade_map.QUERY_VERSION,
                "requested_bbox": list(self.bbox),
                "query_bbox": list(self.bbox),
            }
        }

    def test_cache_is_bound_to_requested_bbox(self) -> None:
        self.assertTrue(shade_map.cache_matches(self.data, self.bbox))
        self.assertFalse(
            shade_map.cache_matches(self.data, (55.7, 37.5, 55.8, 37.7))
        )

    def test_expanded_query_bbox_contains_requested_bbox(self) -> None:
        expanded = shade_map.expand_bbox(self.bbox, 350)
        self.assertTrue(shade_map.bbox_contains(expanded, self.bbox))
        self.assertLess(expanded[0], self.bbox[0])
        self.assertLess(expanded[1], self.bbox[1])
        self.assertGreater(expanded[2], self.bbox[2])
        self.assertGreater(expanded[3], self.bbox[3])

    def test_overpass_falls_back_to_second_endpoint(self) -> None:
        response = FakeResponse(b'{"elements": []}')
        with mock.patch(
            "shade_map.urllib.request.urlopen",
            side_effect=[urllib.error.URLError("first is down"), response],
        ) as urlopen:
            data = shade_map.fetch_overpass(
                "[out:json];node(0,0,0,0);out;",
                urls=("https://first.invalid", "https://second.invalid"),
                timeout_s=1,
            )

        self.assertEqual(data, {"elements": []})
        self.assertEqual(urlopen.call_count, 2)


class OsmGeometryTest(unittest.TestCase):
    def test_relation_preserves_inner_courtyard_and_is_not_duplicated(self) -> None:
        data = {
            "elements": [
                {
                    "type": "way",
                    "id": 101,
                    "nodes": [1, 2, 3],
                    "tags": {"building": "yes"},
                },
                {"type": "way", "id": 102, "nodes": [3, 4, 1]},
                {"type": "way", "id": 103, "nodes": [5, 6, 7, 8, 5]},
                {
                    "type": "relation",
                    "id": 201,
                    "members": [
                        {"type": "way", "ref": 101, "role": "outer"},
                        {"type": "way", "ref": 102, "role": "outer"},
                        {"type": "way", "ref": 103, "role": "inner"},
                    ],
                    "tags": {"type": "multipolygon", "building": "yes", "building:levels": "4"},
                },
                node(1, 59.0, 30.0),
                node(2, 59.0, 30.01),
                node(3, 59.01, 30.01),
                node(4, 59.01, 30.0),
                node(5, 59.003, 30.003),
                node(6, 59.003, 30.007),
                node(7, 59.007, 30.007),
                node(8, 59.007, 30.003),
            ]
        }

        buildings = shade_map.parse_buildings(data)

        self.assertEqual(len(buildings), 1)
        self.assertEqual(buildings[0]["geometry"].geom_type, "Polygon")
        self.assertEqual(len(buildings[0]["geometry"].interiors), 1)
        self.assertEqual(buildings[0]["height_m"], 12.0)

    def test_incomplete_standalone_way_is_not_closed_with_fake_edge(self) -> None:
        data = {
            "elements": [
                {
                    "type": "way",
                    "id": 101,
                    "nodes": [1, 2, 3],
                    "tags": {"building": "yes"},
                },
                node(1, 59.0, 30.0),
                node(2, 59.0, 30.01),
                node(3, 59.01, 30.01),
            ]
        }
        self.assertEqual(shade_map.parse_buildings(data), [])


class ProjectionAndShadowTest(unittest.TestCase):
    def test_local_projection_round_trip(self) -> None:
        projection = shade_map.LocalProjection(59.93, 30.33)
        polygon = Polygon(
            [(30.329, 59.929), (30.331, 59.929), (30.331, 59.931), (30.329, 59.929)]
        )
        restored = projection.unproject(projection.project(polygon))
        self.assertTrue(restored.equals_exact(polygon, tolerance=1e-10))

    def test_courtyard_wall_casts_shadow_without_filling_whole_courtyard(self) -> None:
        footprint = Polygon(
            [(0, 0), (20, 0), (20, 20), (0, 20), (0, 0)],
            holes=[[(5, 5), (15, 5), (15, 15), (5, 15), (5, 5)]],
        )
        shadow = shade_map.make_shadow(
            footprint,
            height_m=5,
            altitude_deg=45,
            sun_azimuth_deg=0,
        )
        self.assertTrue(shadow.is_valid)
        self.assertTrue(shadow.covers(Point(10, 12)))
        self.assertFalse(shadow.covers(Point(10, 7)))

    def test_elevated_part_does_not_cast_from_ground_level(self) -> None:
        footprint = Polygon([(0, 0), (10, 0), (10, 10), (0, 10), (0, 0)])
        shadow = shade_map.make_shadow(
            footprint,
            height_m=10,
            min_height_m=5,
            altitude_deg=45,
            sun_azimuth_deg=0,
        )
        self.assertTrue(shadow.covers(Point(5, -7)))
        self.assertFalse(shadow.covers(Point(5, 9)))

    def test_night_produces_no_ground_shadow(self) -> None:
        building = {
            "geometry": Polygon(
                [(30.0, 59.0), (30.001, 59.0), (30.001, 59.001), (30.0, 59.0)]
            ),
            "height_m": 10,
            "min_height_m": 0,
        }
        shadow = shade_map.build_ground_shadow_geometry(
            [building],
            altitude_deg=-5,
            sun_azimuth_deg=0,
            projection=shade_map.LocalProjection(59.0, 30.0),
        )
        self.assertTrue(shadow.is_empty)

    def test_compact_mapping_increases_precision_if_rounding_breaks_geometry(self) -> None:
        geometry = MultiPolygon(
            [
                box(0, 0, 1, 1),
                box(1.0000001, 0, 2, 1),
            ]
        )
        compact = shade_map.compact_geometry_mapping(geometry, precision=6)
        self.assertTrue(shape(compact).is_valid)


class TimeFrameTest(unittest.TestCase):
    def setUp(self) -> None:
        self.when = dt.datetime.fromisoformat("2026-07-17T15:00:00+03:00")

    def test_time_grid_covers_day_and_preserves_selected_time(self) -> None:
        selected = self.when.replace(hour=15, minute=17)
        moments = shade_map.build_time_grid(selected, 180)

        self.assertEqual(moments[0].strftime("%H:%M"), "00:00")
        self.assertEqual(moments[-1].strftime("%H:%M"), "23:59")
        self.assertIn(selected, moments)

    def test_frames_include_night_and_valid_daylight_geometry(self) -> None:
        building = {
            "geometry": Polygon(
                [
                    (30.33, 59.93),
                    (30.331, 59.93),
                    (30.331, 59.931),
                    (30.33, 59.93),
                ]
            ),
            "height_m": 12,
            "min_height_m": 0,
        }
        projection = shade_map.LocalProjection(59.9305, 30.3305)
        scene = shade_map.prepare_shadow_scene(
            [building],
            projection=projection,
            clip_bbox=(59.929, 30.329, 59.932, 30.332),
        )

        frames, initial_index = shade_map.build_shadow_frames(
            scene,
            self.when,
            center_lat=projection.center_lat,
            center_lon=projection.center_lon,
            step_minutes=180,
            workers=1,
        )

        self.assertEqual(frames[initial_index]["time"], self.when.isoformat())
        self.assertTrue(any(frame["geometry"] is None for frame in frames))
        daylight = [frame for frame in frames if frame["geometry"] is not None]
        self.assertTrue(daylight)
        self.assertTrue(all(shape(frame["geometry"]).is_valid for frame in daylight))

    def test_3d_timeline_and_empty_shadow_collection(self) -> None:
        frames = [
            {
                "date_label": "17.07.2026",
                "label": "12:00",
                "altitude": 45.0,
                "shadow_bearing": 30.0,
            },
            {
                "date_label": "17.07.2026",
                "label": "12:30",
                "altitude": 44.0,
                "shadow_bearing": 35.0,
            },
        ]
        markup = timeline_markup(frames, 0)
        self.assertIn('id="shade-range"', markup)
        self.assertIn('id="shade-play"', markup)
        self.assertEqual(
            shadow_feature_collection(None),
            {"type": "FeatureCollection", "features": []},
        )


class HtmlSafetyTest(unittest.TestCase):
    def test_json_cannot_close_script_element(self) -> None:
        serialized = json_for_script({"name": "</script><script>alert(1)</script>"})
        self.assertNotIn("</script>", serialized)
        self.assertIn("\\u003c", serialized)


def node(identifier: int, lat: float, lon: float) -> dict:
    return {"type": "node", "id": identifier, "lat": lat, "lon": lon}


class FakeResponse:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self) -> bytes:
        return self.payload


if __name__ == "__main__":
    unittest.main()
