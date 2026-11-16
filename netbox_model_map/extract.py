"""Reads the data model from the running NetBox: core models from Django's model
metadata, custom object types from the Custom Objects plugin (when installed).
Runs on every page view; it takes a few dozen queries and no writes."""
import inspect
import re
from datetime import date

from django.apps import apps
from django.conf import settings
from django.contrib.contenttypes.fields import GenericForeignKey, GenericRelation
from django.db.models import F, UniqueConstraint
from django.urls import NoReverseMatch, reverse
from django.utils.text import slugify

from circuits.constants import CIRCUIT_TERMINATION_TERMINATION_TYPES
from dcim.constants import LOCATION_SCOPE_TYPES
from ipam.constants import VLANGROUP_SCOPE_TYPES
from netbox.plugins import PluginConfig

try:
    from netbox_custom_objects.models import CustomObjectType
except ImportError:
    CustomObjectType = None

DOMAINS = {"tenancy": "Tenancy", "dcim": "DCIM", "ipam": "IPAM", "virtualization": "Virtualization",
           "circuits": "Circuits", "wireless": "Wireless", "vpn": "VPN"}
APPS = list(DOMAINS)
SKIP = {"id", "created", "last_updated", "custom_field_data", "comments", "description"}
# Generic FKs carry no limit_choices_to in NetBox 4.6. Their targets are the models
# that declare a GenericRelation back, plus the type constants NetBox uses for these.
GFK_TYPES = {("VLANGroup", "scope"): VLANGROUP_SCOPE_TYPES,
             ("CircuitTermination", "termination"): CIRCUIT_TERMINATION_TERMINATION_TYPES}

CORE_VIEWS = [
    ("tenancy", "Tenancy & contacts", "Who owns things and whom to call. Most models take an optional Tenant."),
    ("dcim-sites", "DCIM · Sites, racks & power", "Where things are: the site hierarchy, racks and power. Almost everything physical hangs off a Site."),
    ("dcim-devices", "DCIM · Devices & types", "The hardware catalogue and the Device itself. A Device needs a Device Type, a Device Role and a Site."),
    ("dcim-components", "DCIM · Components & cabling", "Ports, interfaces and bays that belong to a Device or Module, and the Cables that join them."),
    ("dcim-templates", "DCIM · Component templates", "Blueprints on a Device Type or Module Type, copied onto every new Device or Module."),
    ("ipam", "IPAM", "Addressing, VLANs and routing. Prefixes and IP addresses need no parent; containment follows from the addresses."),
    ("virtualization", "Virtualization", "Clusters and virtual machines."),
    ("circuits", "Circuits", "Providers, circuits and where they terminate."),
    ("wireless", "Wireless", "Wireless LANs and point-to-point links between interfaces."),
    ("vpn", "VPN", "Tunnels with their IKE/IPSec stack, and L2VPNs."),
]
OVERVIEW = ["Region", "Site", "Location", "Tenant", "Manufacturer", "DeviceType", "DeviceRole", "Platform",
            "Rack", "Device", "Interface", "Cable", "VRF", "VLAN", "Prefix", "IPRange", "IPAddress",
            "ClusterType", "Cluster", "VirtualMachine", "VMInterface", "Provider", "Circuit"]


def _label(text):
    return " ".join(w[:1].upper() + w[1:] for w in str(text).split())


def _expr(e):
    if isinstance(e, F):
        return e.name
    src = e.get_source_expressions() if hasattr(e, "get_source_expressions") else []
    return f"{_expr(src[0])} (any case)" if src else str(e)


def _cond(q):
    parts = []
    for c in q.children:
        if isinstance(c, tuple):
            k, v = c
            parts.append(f"{k[:-8]} is {'empty' if v else 'set'}" if k.endswith("__isnull") else f"{k} = {v}")
        else:
            parts.append(_cond(c))
    return f" {q.connector.lower()} ".join(parts)


def _rules(model):
    out = [f"{f.name} is unique" for f in model._meta.concrete_fields if f.unique and not f.primary_key]
    for c in model._meta.constraints:
        if isinstance(c, UniqueConstraint):
            names = list(c.fields) or [_expr(e) for e in c.expressions]
            out.append(" + ".join(names) + " is unique" + (f" when {_cond(c.condition)}" if c.condition else ""))
    return out


def _url(name):
    try:
        return reverse(name)
    except NoReverseMatch:
        return None


def _dcim_view(mid, m):
    parents = {t for r in m["rels"] if r["req"] for t in r["targets"] if t != mid}
    if mid.endswith("Template"):
        return "dcim-templates"
    if mid.startswith("Cable") or parents & {"Device", "Module"}:
        return "dcim-components"
    if mid in {"Region", "SiteGroup", "Site", "Location"} or mid.startswith(("Rack", "Power")):
        return "dcim-sites"
    return "dcim-devices"


def build():
    cfg = settings.PLUGINS_CONFIG.get("netbox_model_map", {})
    cots = list(CustomObjectType.objects.order_by("id")) if CustomObjectType else []
    core = [m for a in APPS for m in apps.get_app_config(a).get_models() if not m._meta.proxy]
    by_name = {m._meta.model_name: m.__name__ for m in core}
    cot_slug = {f"table{c.id}model": c.slug for c in cots}

    def ref(app_label, model_name):
        if model_name in cot_slug:
            return cot_slug[model_name]
        return by_name.get(model_name) if app_label in APPS else None

    generic = {}
    for model in apps.get_models():
        for f in model._meta.private_fields:
            if isinstance(f, GenericRelation):
                t = ref(model._meta.app_label, model._meta.model_name)
                if t:
                    generic.setdefault((f.related_model, f.content_type_field_name), set()).add(t)

    models = {}
    for model in core:
        rels = []
        for f in model._meta.get_fields():
            if isinstance(f, GenericForeignKey):
                names = GFK_TYPES.get((model.__name__, f.name), LOCATION_SCOPE_TYPES if f.name == "scope" else ())
                targets = generic.get((model, f.ct_field), set()) | {by_name[n] for n in names if n in by_name}
                rels.append({"field": f.name, "kind": "gfk", "req": not model._meta.get_field(f.ct_field).null,
                             "targets": sorted(targets)})
            elif f.concrete and f.is_relation and f.related_model and not f.name.startswith("_"):
                t = ref(f.related_model._meta.app_label, f.related_model._meta.model_name)
                if t:
                    kind = "m2m" if f.many_to_many else "o2o" if f.one_to_one else "fk"
                    rels.append({"field": f.name, "kind": kind, "req": kind != "m2m" and not (f.null or f.blank),
                                 "targets": [t]})
        doc = inspect.cleandoc(model.__doc__ or "")
        keys = [f.name for f in model._meta.concrete_fields if not f.is_relation and f.editable
                and f.name not in SKIP and not f.name.startswith("_") and f.get_internal_type() != "BooleanField"
                and (f.name == "name" or not f.blank)]
        models[model.__name__] = {
            "label": _label(model._meta.verbose_name), "app": model._meta.app_label,
            "domain": DOMAINS[model._meta.app_label],
            "desc": "" if doc.startswith(model.__name__ + "(") else doc.split("\n\n")[0].replace("\n", " "),
            "keys": keys[:6], "rules": _rules(model), "rels": rels,
            "url": _url(f"{model._meta.app_label}:{model._meta.model_name}_list"),
        }

    def ref_object_type(o):
        """A custom object field's target. Models outside the core apps (another plugin,
        extras, users) get a plain node of their own, so the relation is not lost."""
        t = ref(o.app_label, o.model)
        cls = o.model_class()
        if t or cls is None:
            return t
        xid = f"{o.app_label}-{cls.__name__}".replace("_", "-")
        models.setdefault(xid, {
            "label": _label(cls._meta.verbose_name), "app": "other", "domain": str(cls._meta.app_config.verbose_name),
            "desc": "", "keys": [], "rules": [], "rels": [], "url": _url(f"{o.app_label}:{o.model}_list")})
        return xid

    for c in cots:
        rels, keys, scalars, rules = [], [], [], []
        for f in c.fields.order_by("weight", "id"):
            if f.type in ("object", "multiobject"):
                ots = list(f.related_object_types.all()) if f.is_polymorphic else [f.related_object_type]
                kind = "m2m" if f.type == "multiobject" else "gfk" if f.is_polymorphic else "fk"
                rels.append({"field": f.name, "kind": kind, "req": f.required and kind != "m2m",
                             "targets": [t for t in (ref_object_type(o) for o in ots if o) if t]})
            else:
                scalars.append(f.name)
                if f.required or f.primary:
                    keys.append(f.name)
            lo, hi = f.validation_minimum, f.validation_maximum
            if lo is not None or hi is not None:
                rules.append(f"{f.name}: " + (f"between {lo} and {hi}" if lo is not None and hi is not None
                                              else f"at least {lo}" if lo is not None else f"at most {hi}"))
            if f.validation_regex:
                rules.append(f"{f.name} matches {f.validation_regex}")
            if f.choice_set_id:
                rules.append(f"{f.name}: a value from the choice set '{f.choice_set.name}'")
            if f.unique:
                rules.append(f"{f.name} is unique")
        models[c.slug] = {
            "label": c.verbose_name or _label(c.name), "app": "custom", "domain": c.group_name or "Custom object",
            "group": c.group_name or "", "desc": c.description or "", "keys": (keys or scalars)[:6],
            "rules": rules, "rels": rels, "url": f"/plugins/custom-objects/{c.slug}/",
        }

    # Two models can share a verbose name (Interface / VM interface is "interface" twice):
    # those get their class name split into words instead, e.g. "VM Interface".
    seen = {}
    for mid, m in models.items():
        seen.setdefault(m["label"], []).append(mid)
    for ids in seen.values():
        for mid in ids if len(ids) > 1 else ():
            if models[mid]["app"] != "custom":
                models[mid]["label"] = re.sub(r"(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])", " ", mid)

    groups = sorted({m["group"] for m in models.values() if m["app"] == "custom"}, key=lambda g: (g == "", g))
    blurbs = cfg.get("blurbs", {})
    views = [{"id": "overview", "name": "Overview",
              "blurb": "The main core models and every custom object type. Select a model for its "
                       "relations, or open a view for every model and field."}]
    views += [{"id": "custom-" + (slugify(g) or "other"), "name": g or "Custom objects", "custom": True,
               "blurb": blurbs.get(g, f"Custom object types in the group {g}." if g else "Custom object types without a group.")}
              for g in groups]
    if any(m["app"] == "other" for m in models.values()):
        views.append({"id": "other", "name": "Other models", "custom": True,
                      "blurb": blurbs.get("Other models", "Models from other apps and plugins that custom object types point at.")})
    views += [{"id": v, "name": n, "blurb": blurbs.get(n, b)} for v, n, b in CORE_VIEWS]
    notes = cfg.get("rules", {})
    for mid, m in models.items():
        if m["app"] == "custom":
            m["view"] = "custom-" + (slugify(m["group"]) or "other")
        elif m["app"] == "other":
            m["view"] = "other"
        else:
            m["view"] = _dcim_view(mid, m) if m["app"] == "dcim" else m["app"]
        m["notes"] = notes.get(mid, [])

    overview = cfg.get("overview") or OVERVIEW + [mid for mid, m in models.items() if m["app"] == "custom"]
    return {
        "netbox": settings.RELEASE.version,
        "plugins": {c.verbose_name: c.version for c in apps.get_app_configs()
                    if isinstance(c, PluginConfig) and c.name != "netbox_model_map"},
        "generated": date.today().isoformat(), "netbox_url": "",
        "views": views, "overview": [mid for mid in overview if mid in models], "models": models,
    }
