import json
import re
from typing import Any


MAX_GROUPS = 16
DEFAULT_GROUP_CONFIG = json.dumps(
    {
        "version": 1,
        "groups": [{"id": 1, "name": "Group 1"}],
    },
    separators=(",", ":"),
)

_DYNAMIC_INPUT_RE = re.compile(
    r"^group_(?P<group>\d{2})_(?P<kind>model|clip|vae)$"
)
_TYPE_BY_KIND = {
    "model": "MODEL",
    "clip": "CLIP",
    "vae": "VAE",
}


def _input_name(group_id: int, kind: str) -> str:
    return f"group_{group_id:02d}_{kind}"


def _parse_group_id(value: Any) -> int:
    try:
        group_id = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Invalid active group: {value!r}") from exc

    if not 1 <= group_id <= MAX_GROUPS:
        raise ValueError(
            f"Active group must be between 1 and {MAX_GROUPS}; got {group_id}."
        )
    return group_id


def _group_name(group_id: int, group_config: str) -> str:
    try:
        config = json.loads(group_config or DEFAULT_GROUP_CONFIG)
        for group in config.get("groups", []):
            if int(group.get("id", -1)) == group_id:
                name = str(group.get("name", "")).strip()
                if name:
                    return name
    except (TypeError, ValueError, json.JSONDecodeError):
        pass
    return f"Group {group_id}"


class DynamicGroupInputs(dict):
    """Optional-input mapping that accepts the 16 fixed group triplets.

    All supported inputs must be enumerable in the schema sent to the frontend.
    The JavaScript extension hides sockets for groups not currently in use.
    Dictionary lookup overrides alone do not survive schema JSON serialization.
    """

    def __init__(self) -> None:
        super().__init__(
            {
                _input_name(group_id, kind): (input_type, {"lazy": True})
                for group_id in range(1, MAX_GROUPS + 1)
                for kind, input_type in _TYPE_BY_KIND.items()
            }
        )

    @staticmethod
    def _dynamic_value(key: object):
        if not isinstance(key, str):
            return None
        match = _DYNAMIC_INPUT_RE.fullmatch(key)
        if match is None:
            return None
        group_id = int(match.group("group"))
        if not 1 <= group_id <= MAX_GROUPS:
            return None
        return (_TYPE_BY_KIND[match.group("kind")], {"lazy": True})

    def __contains__(self, key: object) -> bool:
        return super().__contains__(key) or self._dynamic_value(key) is not None

    def __getitem__(self, key: str):
        try:
            return super().__getitem__(key)
        except KeyError:
            value = self._dynamic_value(key)
            if value is None:
                raise
            return value

    def get(self, key: str, default=None):
        value = self._dynamic_value(key)
        if value is not None:
            return value
        return super().get(key, default)


class PowerModelLoader:
    """Lazily forwards one selected MODEL/CLIP/VAE input group."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "active_group": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": MAX_GROUPS,
                        "step": 1,
                    },
                ),
                "group_config": (
                    "STRING",
                    {
                        "default": DEFAULT_GROUP_CONFIG,
                        "multiline": False,
                    },
                ),
            },
            "optional": DynamicGroupInputs(),
        }

    RETURN_TYPES = ("MODEL", "CLIP", "VAE")
    RETURN_NAMES = ("model", "clip", "vae")
    FUNCTION = "select_group"
    CATEGORY = "👻 Luci/loaders"
    DESCRIPTION = (
        "Selects one complete MODEL, CLIP, and VAE group. Unselected groups "
        "remain lazy and are not evaluated."
    )

    @classmethod
    def check_lazy_status(
        cls,
        active_group: int,
        group_config: str = DEFAULT_GROUP_CONFIG,
        **kwargs,
    ):
        del group_config
        group_id = _parse_group_id(active_group)
        selected_inputs = (
            _input_name(group_id, "model"),
            _input_name(group_id, "clip"),
            _input_name(group_id, "vae"),
        )
        return [
            name
            for name in selected_inputs
            if name in kwargs and kwargs[name] is None
        ]

    @classmethod
    def select_group(
        cls,
        active_group: int,
        group_config: str = DEFAULT_GROUP_CONFIG,
        **kwargs,
    ):
        group_id = _parse_group_id(active_group)
        names = {
            kind: _input_name(group_id, kind)
            for kind in ("model", "clip", "vae")
        }
        missing = [kind.upper() for kind, name in names.items() if kwargs.get(name) is None]
        if missing:
            display_name = _group_name(group_id, group_config)
            raise ValueError(
                f"Power Model Loader group '{display_name}' is missing: "
                + ", ".join(missing)
                + ". Connect all three inputs for the selected group."
            )

        return (
            kwargs[names["model"]],
            kwargs[names["clip"]],
            kwargs[names["vae"]],
        )
