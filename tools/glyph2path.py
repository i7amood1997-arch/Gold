"""Shape Arabic text with HarfBuzz and emit it as an SVG path, fitted to a box.

Usage: python glyph2path.py FONT TEXT INK_HEIGHT CENTER_X CENTER_Y [MAX_WIDTH]
Prints the path "d" attribute in final (y-down) coordinates. Used by
make-icons.mjs so the app icon never depends on an installed font.
Needs: pip install fonttools brotli uharfbuzz
"""
import sys
import uharfbuzz as hb
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import RecordingPen

font_path, text = sys.argv[1], sys.argv[2]
ink_h, cx, cy = map(float, sys.argv[3:6])
max_w = float(sys.argv[6]) if len(sys.argv) > 6 else float('inf')

import io
tt = TTFont(font_path)
glyphs = tt.getGlyphSet()
order = tt.getGlyphOrder()

# HarfBuzz cannot read WOFF2; hand it the decompressed sfnt bytes.
raw = io.BytesIO()
tt.flavor = None
tt.save(raw)
face = hb.Face(hb.Blob(raw.getvalue()))
hbfont = hb.Font(face)
buf = hb.Buffer()
buf.add_str(text)
buf.guess_segment_properties()
hb.shape(hbfont, buf, {})

# Lay the shaped glyphs out in font units (y-up), recording outlines.
rec = RecordingPen()
x = 0
for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
    name = order[info.codepoint]
    glyphs[name].draw(TransformPen(rec, (1, 0, 0, 1, x + pos.x_offset, pos.y_offset)))
    x += pos.x_advance

bp = BoundsPen(glyphs)
rec.replay(bp)
xmin, ymin, xmax, ymax = bp.bounds
scale = min(ink_h / (ymax - ymin), max_w / (xmax - xmin))
# Map ink box centre to (cx, cy), flipping y.
tx = cx - scale * (xmin + xmax) / 2
ty = cy + scale * (ymin + ymax) / 2
svg = SVGPathPen(glyphs, ntos=lambda v: f"{v:.1f}".rstrip('0').rstrip('.'))
rec.replay(TransformPen(svg, (scale, 0, 0, -scale, tx, ty)))
print(svg.getCommands())
