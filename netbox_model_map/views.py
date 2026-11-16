from pathlib import Path

from django.http import HttpResponse
from django.shortcuts import render
from django.template.loader import render_to_string
from django.views import View

from utilities.views import TokenConditionalLoginRequiredMixin

from . import config
from .extract import build

STATIC = Path(__file__).parent / "static" / "netbox_model_map"


class ModelMapView(TokenConditionalLoginRequiredMixin, View):
    """The map inside NetBox, or with ?download a single HTML file that works without NetBox."""

    def get(self, request):
        data = build()
        if "download" not in request.GET:
            return render(request, "netbox_model_map/map.html", {"data": data, "version": config.version})
        data["netbox_url"] = request.build_absolute_uri("/").rstrip("/")
        html = render_to_string("netbox_model_map/standalone.html", {
            "data": data, "css": (STATIC / "map.css").read_text(), "js": (STATIC / "map.js").read_text()})
        return HttpResponse(html, headers={"Content-Disposition": 'attachment; filename="model-map.html"'})
