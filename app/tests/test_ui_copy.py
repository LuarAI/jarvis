"""Copying part of a reply: code blocks, tables, and a visible selection.

Three bugs, one theme — the transcript rendered content beautifully and then made it
hard to get back out:

  * the selection highlight was painted UNDER code/table/user backgrounds, so dragging
    across a code span looked like nothing was selected;
  * a table is drawn on a Canvas, so it has no selectable text at all and was silently
    missing from anything copied by selection;
  * the only Copy button covered the WHOLE reply, so lifting out one code block meant
    taking the prose with it.

These drive the real Overlay on the shared fixture and assert on Tk state.
"""
from conftest import chat_text


def _windows(ov):
    return [ov.chat.nametowidget(w) for w in ov.chat.window_names()]


def _canvas_text(cv):
    return " ".join(cv.itemcget(i, "text") for i in cv.find_all()
                    if cv.type(i) == "text")


# ─── the selection must paint over the text, not under it ────────────────────

def test_selection_outranks_block_backgrounds(overlay):
    """Tk resolves conflicting tag options by creation order, and "sel" is built in —
    so every tag that sets a background used to outrank it and hide the highlight."""
    order = overlay.chat.tag_names()
    assert "sel" in order
    for tag in ("md_code", "md_codeblock", "tool", "user"):
        assert order.index("sel") > order.index(tag), (
            f"{tag} is raised above the selection, so highlighting text inside it "
            f"paints behind {tag}'s background and looks unselected")


def test_selection_visible_over_a_code_block(overlay):
    """The end-to-end version of the bug the user photographed."""
    overlay.add_delta("```\nselect me\n```\n")
    overlay._md_finalize()
    overlay.chat.tag_add("sel", "1.0", "end-1c")
    assert overlay.chat.tag_ranges("sel"), "nothing selected"
    names = overlay.chat.tag_names()
    assert names.index("sel") > names.index("md_codeblock")


# ─── code blocks copy without their fences ───────────────────────────────────

def test_code_block_gets_its_own_copy_button(overlay):
    before = len(overlay.chat.window_names())
    overlay.add_delta("here you go:\n\n```python\nprint('hi')\n```\n\nthat's it\n")
    overlay._md_finalize()
    assert len(overlay.chat.window_names()) > before, "no Copy button under the block"


def test_code_copy_excludes_the_fences(overlay):
    overlay.add_delta("```python\nprint('hi')\nprint('bye')\n```\n")
    overlay._md_finalize()
    btns = [w for w in _windows(overlay) if hasattr(w, "_on_click")]
    assert btns, "expected a Copy button for the code block"
    payload = getattr(btns[-1], "_copy_text", None)
    assert payload is not None
    assert "```" not in payload, "fences must not be copied"
    assert "python" not in payload.split("\n")[0], "the info string is not code"
    assert payload == "print('hi')\nprint('bye')"


def test_whitespace_only_block_gets_no_button(overlay):
    before = len(overlay.chat.window_names())
    overlay.add_delta("```\n\n   \n```\n")
    overlay._md_finalize()
    assert len(overlay.chat.window_names()) == before, (
        "an empty block offered a Copy button with nothing in it")


def test_two_blocks_each_copy_their_own_text(overlay):
    overlay.add_delta("```\nfirst\n```\nmiddle\n```\nsecond\n```\n")
    overlay._md_finalize()
    payloads = [w._copy_text for w in _windows(overlay) if hasattr(w, "_copy_text")]
    assert "first" in payloads
    assert "second" in payloads
    assert not any("middle" in p for p in payloads), "prose leaked into a code copy"


def test_unterminated_block_still_offers_its_text(overlay):
    """A reply that ends mid-block: the code is on screen, so it must be copyable."""
    overlay.add_delta("```\nhalf a block\n")
    overlay._md_finalize()
    payloads = [w._copy_text for w in _windows(overlay) if hasattr(w, "_copy_text")]
    assert any("half a block" in p for p in payloads)


def test_fence_state_does_not_leak_into_the_next_turn(overlay):
    overlay.add_delta("```\nunclosed\n")
    overlay._md_finalize()
    assert overlay._md_fence is False
    assert overlay._md_code is None


# ─── tables copy as TSV ──────────────────────────────────────────────────────

TABLE = (
    "| Application | Status |\n"
    "| --- | --- |\n"
    "| Noxx FDE | $7,500 ask |\n"
    "| Mappa | declined their $2,400 |\n"
)


def test_table_still_renders_as_a_canvas(overlay):
    """The user likes how tables look — copying must not change the rendering."""
    overlay.add_delta(TABLE)
    overlay._md_finalize()
    overlay.root.update_idletasks()
    cvs = [w for w in _windows(overlay) if hasattr(w, "_on_copy_click")]
    assert cvs, "the table canvas is gone"
    flat = _canvas_text(cvs[0])
    assert "Noxx FDE" in flat and "$7,500 ask" in flat


def test_table_tsv_is_tab_separated(overlay):
    tsv = overlay._table_tsv(["Application", "Status"],
                             [["Noxx FDE", "$7,500 ask"]])
    assert tsv == "Application\tStatus\nNoxx FDE\t$7,500 ask"
    assert "|" not in tsv, "pipes land in column A; spreadsheets split on tabs"
    assert "---" not in tsv, "the markdown separator row is not data"


def test_table_tsv_pads_ragged_rows(overlay):
    """A short row must keep the column count, or every later cell shifts left."""
    tsv = overlay._table_tsv(["A", "B", "C"], [["1"], ["1", "2", "3"]])
    assert [ln.count("\t") for ln in tsv.split("\n")] == [2, 2, 2]


def test_table_tsv_neutralises_embedded_tabs(overlay):
    """A tab inside a cell would invent a column that isn't there."""
    tsv = overlay._table_tsv(["A", "B"], [["has\ttab", "and\nnewline"]])
    assert tsv.count("\n") == 1, "an embedded newline split the row"
    assert tsv.split("\n")[1].count("\t") == 1, "an embedded tab invented a column"


def test_table_copy_click_puts_tsv_on_the_clipboard(overlay):
    overlay.add_delta(TABLE)
    overlay._md_finalize()
    overlay.root.update_idletasks()
    cvs = [w for w in _windows(overlay) if hasattr(w, "_on_copy_click")]
    assert cvs, "no table canvas"
    cv = cvs[0]

    class _Evt:
        pass
    e = _Evt()
    # click the icon's own hit box (a click elsewhere in the table must do nothing)
    box = cv._copy_box
    e.x = (box[0] + box[2]) / 2
    e.y = (box[1] + box[3]) / 2
    assert cv._on_copy_click(e) == "break"
    got = overlay.root.clipboard_get()
    assert "\t" in got
    assert "Noxx FDE\t$7,500 ask" in got
    assert "Mappa\tdeclined their $2,400" in got
    assert "|" not in got


def test_copy_icon_never_sits_on_the_header_text(overlay):
    """The icon lives in the last header cell's corner, so that cell must give up room
    for it — otherwise a long header renders straight through the glyph."""
    overlay.add_delta("| A | This is a very long header cell that wants all the room |\n"
                      "| --- | --- |\n| x | y |\n")
    overlay._md_finalize()
    overlay.root.update_idletasks()
    cv = [w for w in _windows(overlay) if hasattr(w, "_on_copy_click")][0]
    icon_left = cv._copy_box[0]
    for i in cv.find_all():
        if cv.type(i) != "text":
            continue
        label = cv.itemcget(i, "text")
        if label in ("⧉", "✓"):                     # the copy glyph is allowed to be there
            continue
        bb = cv.bbox(i)
        if bb and bb[1] < cv._copy_box[3]:          # a text item on the header row
            assert bb[2] <= icon_left, (
                f"header text {label!r} runs under the copy icon")


def test_click_elsewhere_in_the_table_is_not_a_copy(overlay):
    overlay.add_delta(TABLE)
    overlay._md_finalize()
    overlay.root.update_idletasks()
    cv = [w for w in _windows(overlay) if hasattr(w, "_on_copy_click")][0]

    class _Evt:
        pass
    e = _Evt()
    e.x, e.y = 2, cv.winfo_reqheight() - 2      # bottom-left: far from the icon
    assert cv._on_copy_click(e) is None, "a stray click inside the table copied"
