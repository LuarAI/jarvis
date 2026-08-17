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


def test_table_is_real_selectable_text(overlay):
    """The whole point: a table drawn on a canvas has no characters to select, so it
    was invisible to both highlighting and any select-all copy."""
    overlay.add_delta(TABLE)
    overlay._md_finalize()
    overlay.root.update_idletasks()
    overlay.chat.tag_add("sel", "1.0", "end-1c")
    selected = overlay.chat.get("sel.first", "sel.last")
    assert "Noxx FDE" in selected
    assert "$7,500 ask" in selected
    assert "declined their $2,400" in selected


def test_table_columns_line_up(overlay):
    """Alignment is what makes it read as a table without vertical rules."""
    overlay.add_delta(TABLE)
    overlay._md_finalize()
    txt = chat_text(overlay)
    # the second column starts at the same offset on every row, header included
    marks = [("Application", "Status"), ("Noxx FDE", "$7,500"),
             ("Mappa", "declined")]
    starts = []
    for row_key, col2 in marks:
        line = next(ln for ln in txt.split("\n") if ln.startswith(row_key))
        starts.append(line.index(col2))
    assert len(set(starts)) == 1, f"second column not aligned: {starts}"


def test_table_has_a_header_rule_but_no_vertical_rules(overlay):
    overlay.add_delta(TABLE)
    overlay._md_finalize()
    txt = chat_text(overlay)
    assert "─" in txt, "no rule under the header"
    assert "|" not in txt, "pipes are markdown source, not a rendered table"


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


def test_table_copy_button_puts_tsv_on_the_clipboard(overlay):
    overlay.add_delta(TABLE)
    overlay._md_finalize()
    overlay.root.update_idletasks()
    btns = [w for w in _windows(overlay) if hasattr(w, "_on_click")]
    assert btns, "no Copy button under the table"
    assert btns[-1]._on_click(None) == "break"
    got = overlay.root.clipboard_get()
    assert "Noxx FDE\t$7,500 ask" in got
    assert "Mappa\tdeclined their $2,400" in got
    assert "|" not in got


def test_wide_table_wraps_instead_of_truncating(overlay):
    """Truncation would silently corrupt what you paste — the copy is the point."""
    long_note = ("this is a very long note that cannot possibly fit inside a narrow "
                 "overlay column without being wrapped onto several lines")
    overlay.add_delta(f"| Item | Note |\n| --- | --- |\n| Thing | {long_note} |\n")
    overlay._md_finalize()
    txt = chat_text(overlay)
    assert "…" not in txt and "..." not in txt, "a cell was truncated"
    # every word survives somewhere in the rendered table
    for word in long_note.split():
        assert word in txt, f"{word!r} was lost in wrapping"


def test_alignment_survives_a_row_where_both_columns_wrap(overlay):
    """The continuation lines of column 1 must still pad to full width, or column 2
    slides left on every wrapped row."""
    overlay.root.update_idletasks()
    overlay.add_delta("| Application | Status |\n| --- | --- |\n"
                      "| Noxx client Founding Engineer SF in-person role"
                      " | first second third fourth |\n")
    overlay._md_finalize()
    lines = [ln for ln in chat_text(overlay).split("\n") if ln.strip()]
    first = next(ln for ln in lines if "first" in ln)
    cont = next(ln for ln in lines if "fourth" in ln)
    assert first.index("first") == cont.index("fourth"), (
        f"second column drifted on the wrapped row:\n{first!r}\n{cont!r}")


def test_wide_table_stays_inside_the_window(overlay):
    """A line that runs past the edge would force the whole transcript to scroll
    sideways, which is worse than slightly narrower columns."""
    overlay.root.update_idletasks()
    overlay.add_delta("| A | B |\n| --- | --- |\n| " + "x" * 400 + " | y |\n")
    overlay._md_finalize()
    txt = chat_text(overlay)
    longest = max(len(ln) for ln in txt.split("\n"))
    assert longest < 300, f"a {longest}-char line will overflow the overlay"
