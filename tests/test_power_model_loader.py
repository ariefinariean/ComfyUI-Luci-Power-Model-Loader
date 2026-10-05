import importlib.util
import json
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).parents[1] / "power_model_loader.py"
SPEC = importlib.util.spec_from_file_location("power_model_loader", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class PowerModelLoaderTests(unittest.TestCase):
    def test_schema_survives_json_serialization_for_every_group(self):
        optional = json.loads(json.dumps(MODULE.PowerModelLoader.INPUT_TYPES()))["optional"]
        self.assertEqual(len(optional), 48)
        for group_id in range(1, 17):
            for kind, expected_type in MODULE._TYPE_BY_KIND.items():
                name = MODULE._input_name(group_id, kind)
                self.assertEqual(optional[name], [expected_type, {"lazy": True}])

    def test_group_four_serialized_schema_lazy_execution(self):
        optional = json.loads(json.dumps(MODULE.PowerModelLoader.INPUT_TYPES()))["optional"]
        submitted = {f"group_04_{kind}": None for kind in ("model", "clip", "vae")}
        # Model schema-based prompt filtering; the old schema dropped Group 4.
        accepted = {key: value for key, value in submitted.items() if key in optional}
        requested = MODULE.PowerModelLoader.check_lazy_status(active_group=4, **accepted)
        self.assertEqual(set(requested), set(submitted))
        resolved = {key: object() for key in requested}
        result = MODULE.PowerModelLoader.select_group(active_group=4, **resolved)
        self.assertEqual(result, tuple(resolved[f"group_04_{kind}"] for kind in ("model", "clip", "vae")))

    def test_dynamic_schema_resolves_all_supported_groups(self):
        optional = MODULE.PowerModelLoader.INPUT_TYPES()["optional"]
        self.assertEqual(optional["group_16_model"][0], "MODEL")
        self.assertEqual(optional["group_09_clip"][0], "CLIP")
        self.assertEqual(optional["group_02_vae"][0], "VAE")
        self.assertTrue(optional["group_16_model"][1]["lazy"])
        self.assertNotIn("group_17_model", optional)

    def test_lazy_status_requests_only_selected_triplet(self):
        status = MODULE.PowerModelLoader.check_lazy_status(
            active_group=2,
            group_config="",
            group_01_model=None,
            group_01_clip=None,
            group_01_vae=None,
            group_02_model=None,
            group_02_clip="clip",
            group_02_vae=None,
        )
        self.assertEqual(status, ["group_02_model", "group_02_vae"])

    def test_selected_values_are_forwarded_unchanged(self):
        model, clip, vae = MODULE.PowerModelLoader.select_group(
            active_group=3,
            group_config='{"groups":[{"id":3,"name":"BF16"}]}',
            group_01_model="wrong model",
            group_03_model="model",
            group_03_clip="clip",
            group_03_vae="vae",
        )
        self.assertEqual((model, clip, vae), ("model", "clip", "vae"))

    def test_missing_selected_input_has_clear_error(self):
        with self.assertRaisesRegex(ValueError, "BF16.*VAE"):
            MODULE.PowerModelLoader.select_group(
                active_group=2,
                group_config='{"groups":[{"id":2,"name":"BF16"}]}',
                group_02_model="model",
                group_02_clip="clip",
            )

    def test_group_id_is_bounded(self):
        with self.assertRaisesRegex(ValueError, "between 1 and 16"):
            MODULE.PowerModelLoader.select_group(active_group=17)


if __name__ == "__main__":
    unittest.main()
