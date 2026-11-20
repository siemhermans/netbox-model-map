from netbox.plugins import PluginConfig


class ModelMapConfig(PluginConfig):
    name = "netbox_model_map"
    verbose_name = "Model map"
    description = "Interactive map of the data model, custom object types included"
    version = "0.2.0"
    base_url = "model-map"
    min_version = "4.6.0"
    # rules: {model id: [extra rules]}, blurbs: {view name: text}, overview: [model ids]
    default_settings = {"rules": {}, "blurbs": {}, "overview": None}


config = ModelMapConfig
