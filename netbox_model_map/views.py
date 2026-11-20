import hashlib
from pathlib import Path

from django.http import HttpResponse
from django.shortcuts import render
from django.templatetags.static import static
from django.template.loader import render_to_string
from django.views import View

from utilities.views import TokenConditionalLoginRequiredMixin

from .extract import build

STATIC = Path(__file__).parent / "static" / "netbox_model_map"
# Cache buster for map.js/map.css: NetBox serves static files with max-age=86400, so the
# URL must change whenever the files do, not only when the plugin version does.
ASSET_VERSION = hashlib.sha256((STATIC / "map.js").read_bytes() + (STATIC / "map.css").read_bytes()).hexdigest()[:12]


class ModelMapView(TokenConditionalLoginRequiredMixin, View):
    """The map inside NetBox, or with ?download a single HTML file that works without NetBox."""

    def get(self, request):
        data = build()
        if "compare" in request.GET:
            # Two panes side by side, each the full map in a frame (?embed) with its own view picker.
            known = [v["id"] for v in data["views"]]
            default = [v["id"] for v in data["views"] if v.get("configured")] + ["overview", "overview"]
            side = {s: request.GET.get(s) if request.GET.get(s) in known else default[i]
                    for i, s in enumerate(("left", "right"))}
            return render(request, "netbox_model_map/compare.html", {**side, "version": ASSET_VERSION})
        embed = "embed" in request.GET
        if not embed and "download" not in request.GET:
            return render(request, "netbox_model_map/map.html", {"data": data, "version": ASSET_VERSION})
        if embed:
            data["embed"] = True
        else:
            data["netbox_url"] = request.build_absolute_uri("/").rstrip("/")
        html = render_to_string("netbox_model_map/standalone.html", {
            "data": data, "css": (STATIC / "map.css").read_text(), "js": (STATIC / "map.js").read_text(),
            "embed": embed, "nolegend": request.GET.get("legend") == "0", "theme": request.GET.get("theme") if request.GET.get("theme") in ("light", "dark") else "",
            "elk_src": f"{static('netbox_model_map/elk.bundled.js')}?v=0.9.3" if embed
            else "https://cdn.jsdelivr.net/npm/elkjs@0.9.3/lib/elk.bundled.js"})
        if embed:
            return HttpResponse(html)
        return HttpResponse(html, headers={"Content-Disposition": 'attachment; filename="model-map.html"'})
