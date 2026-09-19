import gzip
import json
import math

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from build_climb import Terrain, edge_shape, gain_and_loss, main, read_graph, resample

EAST_M = 111_320.0
NORTH_M = 110_540.0


class TestGainAndLoss:
    def test_flat_ground_gains_nothing(self):
        assert gain_and_loss(np.array([10.0] * 20), 2.0) == (0.0, 0.0)

    def test_a_steady_climb_is_its_own_height(self):
        gain, loss = gain_and_loss(np.linspace(0, 50, 100), 2.0)
        assert gain == pytest.approx(50.0)
        assert loss == 0.0

    def test_noise_under_the_threshold_is_not_climb(self):
        # The whole point: a metre of jitter on a flat road is the model's error, not
        # a hill, and summing it is how naive ascent reaches absurd numbers.
        rng = np.random.default_rng(1)
        flat = 12.0 + rng.uniform(-0.9, 0.9, 400)
        gain, loss = gain_and_loss(flat, 2.0)
        assert gain < 2.0
        assert gain_and_loss(flat, 0.0)[0] > 100.0  # what it costs to not filter

    def test_a_real_bump_survives_the_threshold(self):
        gain, loss = gain_and_loss(np.array([0, 5, 10, 5, 0, 5, 10.0]), 2.0)
        assert gain == pytest.approx(20.0)
        assert loss == pytest.approx(10.0)

    def test_up_and_back_down_counts_both(self):
        gain, loss = gain_and_loss(np.concatenate([np.linspace(0, 30, 50), np.linspace(30, 4, 50)]), 2.0)
        assert gain == pytest.approx(30.0)
        assert loss == pytest.approx(26.0)

    def test_holes_in_the_model_are_skipped_not_counted_as_cliffs(self):
        with_hole = np.array([0.0, 5.0, np.nan, 10.0])
        assert gain_and_loss(with_hole, 2.0)[0] == pytest.approx(10.0)

    def test_too_little_to_say_anything(self):
        assert gain_and_loss(np.array([np.nan, np.nan]), 2.0) == (0.0, 0.0)


class TestResample:
    def _line(self, metres):
        return np.array([[24.9, 60.17], [24.9 + metres / (EAST_M * math.cos(math.radians(60.17))), 60.17]])

    def test_keeps_both_ends(self):
        points = resample(self._line(1000), 25.0)
        assert points[0] == pytest.approx(self._line(1000)[0])
        assert points[-1] == pytest.approx(self._line(1000)[1])

    def test_spaces_them_about_right(self):
        points = resample(self._line(1000), 25.0)
        assert 40 <= len(points) <= 43

    def test_an_edge_shorter_than_the_spacing_still_has_two_ends(self):
        # Half the edges in the real graph are under 28 m, so this is the common case.
        points = resample(self._line(8), 25.0)
        assert len(points) == 2

    def test_a_zero_length_edge_does_not_divide_by_zero(self):
        same = np.array([[24.9, 60.17], [24.9, 60.17]])
        assert len(resample(same, 25.0)) == 1


def _slope_raster(path, slope_per_metre=0.01):
    """A plane in ETRS-TM35FIN rising `slope_per_metre` towards the east."""
    width = height = 400
    pixel = 50.0
    # Placed over the test coordinates: 24.90E 60.17N is about (383 400, 6 672 100)
    # in ETRS-TM35FIN, and the raster spans 20 km from this corner.
    left, top = 375_000.0, 6_680_000.0
    columns = np.arange(width, dtype=np.float32) * pixel * slope_per_metre
    band = np.tile(columns, (height, 1))
    with rasterio.open(
        path, "w", driver="GTiff", width=width, height=height, count=1,
        dtype="float32", crs="EPSG:3067", transform=from_origin(left, top, pixel, pixel),
    ) as out:
        out.write(band, 1)
    return path


class TestTerrain:
    def test_reads_a_known_slope_back(self, tmp_path):
        terrain = Terrain([_slope_raster(tmp_path / "dem.tif")])
        # Two points 1 km apart east-west should differ by 10 m on a 1% slope.
        lon = np.array([24.90, 24.90 + 1000 / (EAST_M * math.cos(math.radians(60.17)))])
        lat = np.array([60.17, 60.17])
        heights = terrain.sample(lon, lat)
        assert np.isfinite(heights).all()
        assert heights[1] - heights[0] == pytest.approx(10.0, abs=1.0)

    def test_points_off_the_edge_come_back_missing(self, tmp_path):
        terrain = Terrain([_slope_raster(tmp_path / "dem.tif")])
        heights = terrain.sample(np.array([10.0]), np.array([50.0]))
        assert np.isnan(heights).all()


class TestEndToEnd:
    def test_writes_a_sidecar_the_page_can_read(self, tmp_path):
        graph_dir = tmp_path / "graph"
        graph_dir.mkdir()
        _tiny_graph(graph_dir)
        dem = _slope_raster(tmp_path / "dem.tif")
        assert main([str(dem), str(graph_dir), "--spacing", "25", "--threshold", "0.5"]) == 0

        manifest = json.loads((graph_dir / "climb.json").read_text())
        assert manifest["version"] == 3
        assert manifest["threshold_m"] == 0.5
        assert manifest["node_count"] == 3
        blob = gzip.decompress((graph_dir / "climb.bin.gz").read_bytes())
        entry = manifest["layout"]["edge_ascent"]
        ascent = np.frombuffer(blob, dtype="uint16", count=entry["count"], offset=entry["offset"])
        entry = manifest["layout"]["edge_descent"]
        descent = np.frombuffer(blob, dtype="uint16", count=entry["count"], offset=entry["offset"])
        # The edge runs 1 km east up a 1% slope: 10 m of climb, nothing back.
        assert ascent[0] / manifest["scale"] == pytest.approx(10.0, abs=1.0)
        assert descent[0] == 0
        # And the one running west off it drops the same.
        assert descent[1] / manifest["scale"] == pytest.approx(10.0, abs=1.0)
        assert ascent[1] == 0

        # Junction heights travel too, or the page can total a ride's climb but not
        # draw it. The slope rises east, so the middle node sits above the first.
        entry = manifest["layout"]["node_height"]
        heights = np.frombuffer(blob, dtype="uint16", count=entry["count"], offset=entry["offset"])
        assert heights[1] > heights[0]
        assert heights[2] == pytest.approx(heights[0], abs=manifest["scale"])


def _tiny_graph(directory):
    """Two edges: one running east, one running back west."""
    scale, shape_scale = 10_000_000, 1_000_000
    step = 1000 / (EAST_M * math.cos(math.radians(60.17)))
    lons = np.array([24.90, 24.90 + step, 24.90], dtype=np.float64)
    lats = np.array([60.17, 60.17, 60.17], dtype=np.float64)
    sections, blob, layout = {}, bytearray(), {}
    sections["lon"] = (np.round(lons * scale).astype("int32"), "int32")
    sections["lat"] = (np.round(lats * scale).astype("int32"), "int32")
    sections["edge_a"] = (np.array([0, 1], dtype="uint32"), "uint32")
    sections["edge_b"] = (np.array([1, 2], dtype="uint32"), "uint32")
    sections["shape_count"] = (np.array([0, 0], dtype="uint16"), "uint16")
    sections["shape_delta"] = (np.array([], dtype="uint16"), "uint16")
    for name, (array, dtype) in sections.items():
        layout[name] = {"offset": len(blob), "count": len(array), "type": dtype}
        blob.extend(array.tobytes())
    (directory / "graph.bin.gz").write_bytes(gzip.compress(bytes(blob)))
    (directory / "graph.json").write_text(json.dumps({
        "version": 6, "coordinate_scale": scale, "shape_scale": shape_scale,
        "node_count": 3, "edge_count": 2, "layout": layout,
    }))
