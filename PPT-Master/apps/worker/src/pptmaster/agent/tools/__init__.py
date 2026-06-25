"""Tool definitions for each agent role.

Tool ACL (matching spec §5.1):
  Source Loader (Step 1):  pdf_to_md, doc_to_md, excel_to_md, ppt_to_md, web_to_md
  Project Init (Step 2):   project_manager_init, project_manager_import_sources, project_manager_validate
  Template Picker (Step 3): list_layouts, list_brands, list_charts, list_icons, read_template_spec
  Strategist (Step 4):     read_source_content, read_templates, write_outline, write_design_spec, write_spec_lock, analyze_images
  Image Generator (Step 5): read_spec_lock, image_gen, image_search, latex_render, write_image_manifest
  Executor (Step 6):       read_spec_lock, read_image_manifest, list_layouts, list_charts, list_icons, write_svg_page, svg_quality_checker
  Post-Processor (Step 7): total_md_split, finalize_svg, svg_to_pptx
"""

from .project import project_manager_import_sources, project_manager_init, project_manager_validate
from .source import doc_to_md, excel_to_md, pdf_to_md, ppt_to_md, web_to_md
from .template import (
    list_brands, list_charts, list_icons, list_layouts, read_template_spec,
    run_pptx_template_import, run_register_template, run_svg_quality_checker,
)

__all__ = [
    # Step 1
    "pdf_to_md", "doc_to_md", "excel_to_md", "ppt_to_md", "web_to_md",
    # Step 2
    "project_manager_init", "project_manager_import_sources", "project_manager_validate",
    # Step 3
    "list_layouts", "list_brands", "list_charts", "list_icons", "read_template_spec",
    # G3 — template wizard subprocess wrappers
    "run_pptx_template_import", "run_register_template", "run_svg_quality_checker",
]
