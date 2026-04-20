"""Smoke tests that the 18 new tools are registered and dispatchable.

NOTE: agent_tools.py has heavy runtime deps (sqlalchemy, etc.) that may not
be installed in local dev. These tests use AST extraction to validate schemas
without importing. For full dispatch tests, run inside Docker.
"""

import ast
import re
from pathlib import Path

import pytest


PLAYWRIGHT_TOOL_NAMES = {
    "playwright_browser_navigate",
    "playwright_browser_snapshot",
    "playwright_browser_click",
    "playwright_browser_type",
    "playwright_browser_select",
    "playwright_browser_hover",
    "playwright_browser_screenshot",
    "playwright_browser_click_xy",
    "playwright_browser_type_xy",
    "playwright_browser_wait_for",
    "playwright_browser_eval",
    "playwright_browser_get_text",
    "playwright_browser_back",
    "playwright_browser_close_tab",
    "playwright_browser_download",
    "playwright_browser_list_downloads",
    "doc_read",
    "doc_extract_tables",
}

AGENT_TOOLS_FILE = Path(__file__).parent.parent / "app" / "services" / "agent_tools.py"


def _extract_tool_names_from_source() -> list[str]:
    """Extract all tool 'name' values from AGENT_TOOLS using regex on source."""
    src = AGENT_TOOLS_FILE.read_text()
    # Match: "name": "some_tool_name"
    return re.findall(r'"name":\s*"([a-z_]+)"', src)


def _extract_elif_tool_names() -> set[str]:
    """Extract tool names from elif dispatch branches."""
    src = AGENT_TOOLS_FILE.read_text()
    return set(re.findall(r'tool_name\s*==\s*"([a-z_]+)"', src))


class TestToolRegistration:
    def test_all_18_tools_registered_in_schema(self):
        registered = set(_extract_tool_names_from_source())
        missing = PLAYWRIGHT_TOOL_NAMES - registered
        assert not missing, f"Missing tool schemas: {missing}"

    def test_no_duplicate_tool_names(self):
        names = _extract_tool_names_from_source()
        dupes = [n for n in PLAYWRIGHT_TOOL_NAMES if names.count(n) > 1]
        assert not dupes, f"Duplicate tool schemas: {dupes}"

    def test_all_18_tools_have_elif_dispatch(self):
        dispatched = _extract_elif_tool_names()
        missing = PLAYWRIGHT_TOOL_NAMES - dispatched
        assert not missing, f"Missing elif dispatch: {missing}"

    def test_handler_functions_exist(self):
        src = AGENT_TOOLS_FILE.read_text()
        expected_handlers = [
            "_playwright_browser_navigate",
            "_playwright_browser_snapshot",
            "_playwright_browser_click",
            "_playwright_browser_type",
            "_playwright_browser_select",
            "_playwright_browser_hover",
            "_playwright_browser_screenshot",
            "_playwright_browser_click_xy",
            "_playwright_browser_type_xy",
            "_playwright_browser_wait_for",
            "_playwright_browser_eval",
            "_playwright_browser_get_text",
            "_playwright_browser_back",
            "_playwright_browser_close_tab",
            "_playwright_browser_download",
            "_playwright_browser_list_downloads",
            "_doc_read_tool",
            "_doc_extract_tables_tool",
        ]
        for handler in expected_handlers:
            assert f"async def {handler}(" in src, f"Missing handler: {handler}"

    def test_session_id_injection_exists(self):
        """Verify session_id is injected for playwright/doc tools."""
        src = AGENT_TOOLS_FILE.read_text()
        assert 'tool_name.startswith("playwright_browser_")' in src
        assert '"doc_read", "doc_extract_tables"' in src
        assert 'arguments["_session_id"] = session_id' in src

    def test_screenshot_uses_vision_inject(self):
        """Verify screenshot handler uses store_temp_screenshot, not _fmt."""
        src = AGENT_TOOLS_FILE.read_text()
        # Find the screenshot handler
        match = re.search(
            r'async def _playwright_browser_screenshot\(.*?\n(?:.*?\n)*?(?=\nasync def |\Z)',
            src,
        )
        assert match, "Screenshot handler not found"
        handler_body = match.group(0)
        assert "store_temp_screenshot" in handler_body
        assert "_fmt(png)" not in handler_body and "_fmt(raw_bytes)" not in handler_body
