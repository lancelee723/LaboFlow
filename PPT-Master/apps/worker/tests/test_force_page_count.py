from pptmaster.agent.strategist import _force_page_count


def _page(idx: int) -> dict:
    return {
        "index": idx,
        "name": f"page_{idx:02d}",
        "title": f"Page {idx}",
        "type": "content",
        "layout_basename": None,
        "rhythm": "dense",
        "chart_basename": None,
        "content": [],
    }


def test_returns_outline_as_is_when_count_matches():
    outline = {"canvas": {"format": "ppt169"}, "pages": [_page(1), _page(2), _page(3)]}
    forced = _force_page_count(outline, 3)
    assert len(forced["pages"]) == 3
    assert forced["pages"][0]["index"] == 1
    assert forced["pages"][2]["index"] == 3


def test_truncates_pages_when_target_lower():
    outline = {"canvas": {"format": "ppt169"}, "pages": [_page(i) for i in range(1, 6)]}
    forced = _force_page_count(outline, 3)
    assert len(forced["pages"]) == 3
    assert [p["index"] for p in forced["pages"]] == [1, 2, 3]


def test_pads_with_placeholder_pages_when_target_higher():
    outline = {"canvas": {"format": "ppt169"}, "pages": [_page(1), _page(2)]}
    forced = _force_page_count(outline, 5)
    assert len(forced["pages"]) == 5
    assert forced["pages"][0]["index"] == 1
    assert forced["pages"][2]["index"] == 3
    assert forced["pages"][2]["type"] == "content"
    assert forced["pages"][4]["index"] == 5


def test_preserves_canvas_block():
    outline = {"canvas": {"format": "ppt43", "width": 1024}, "pages": [_page(1)]}
    forced = _force_page_count(outline, 1)
    assert forced["canvas"] == {"format": "ppt43", "width": 1024}
