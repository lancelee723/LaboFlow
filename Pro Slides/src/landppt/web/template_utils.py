"""
Shared Jinja2 template configuration.

All Jinja2Templates instances in the project should use `build_templates(...)`
so they share the same global helpers — particularly `ppt_prefix`, which is
needed by every template to render correct paths under the /ppt reverse-proxy
mount.
"""

from fastapi.templating import Jinja2Templates

from ..core.url_utils import prefixed, ROOT_PATH


def build_templates(directory: str = "src/landppt/web/templates") -> Jinja2Templates:
    """Create a Jinja2Templates with project-wide globals attached."""
    templates = Jinja2Templates(directory=directory)
    _attach_globals(templates)
    return templates


def _attach_globals(templates: Jinja2Templates) -> None:
    env = templates.env
    # The reverse-proxy mount path (e.g. "/ppt") or "" when running standalone.
    env.globals.setdefault("PPT_PREFIX", ROOT_PATH)
    # Callable helper: use as {{ ppt_url('/dashboard') }} in templates.
    env.globals.setdefault("ppt_url", prefixed)
