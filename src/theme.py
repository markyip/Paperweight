"""Warm-neutral palette for reading, not photo judging.

Tokens match the RAWviewer darkroom names so the reader widgets stay portable.
"""

VOID = "#14120f"
SURFACE = "#1d1a16"
RAISED = "#272219"
RAISED_HI = "#302a1f"
LINE = "#3a332a"
LINE_SOFT = "#2a251d"
INK = "#ede7dd"
INK_MUTED = "#96897a"
INK_FAINT = "#665d50"

EMBER = "#d9691e"
EMBER_DIM = "rgba(217, 105, 30, 0.28)"
EMBER_GLOW = "rgba(217, 105, 30, 0.45)"

DODGE = "#d9a441"

VOID_RGB = (20, 18, 15)
SURFACE_RGB = (29, 26, 22)
RAISED_RGB = (39, 34, 25)
RAISED_HI_RGB = (48, 42, 31)
LINE_RGB = (58, 51, 42)
LINE_SOFT_RGB = (42, 37, 29)
INK_RGB = (237, 231, 221)
INK_MUTED_RGB = (150, 137, 122)
INK_FAINT_RGB = (102, 93, 80)
EMBER_RGB = (217, 105, 30)
DODGE_RGB = (217, 164, 65)

FONT_FAMILIES = (".AppleSystemUIFont", "Segoe UI", "Helvetica Neue", "Arial")
FONT_BASE_BUMP_PT = 1.0


def rgba(rgb: tuple[int, int, int], alpha: int) -> str:
    r, g, b = rgb
    return f"rgba({r}, {g}, {b}, {alpha})"
