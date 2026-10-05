from .power_model_loader import PowerModelLoader

NODE_CLASS_MAPPINGS = {
    "PowerModelLoader": PowerModelLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PowerModelLoader": "👻 Power Model Loader",
}

WEB_DIRECTORY = "./web"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]
