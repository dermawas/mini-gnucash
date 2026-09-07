# Renders the mini-gnucash app icon from the design handoff's SVG numbers.
#
# Not an SVG rasteriser: the mark is two stroked circles and two text runs, so
# it is redrawn directly from the values in icon-1024.svg. That avoids adding a
# rasteriser dependency AND fixes the reason this had to be redone at all --
# the handoff's own PNGs were rendered without IBM Plex Sans, so the lettering
# fell back to a generic grotesque.
#
# Fonts come from node_modules/@expo-google-fonts, which is where the app
# already gets IBM Plex, so the icon and the UI are guaranteed the same cut.
#
# Everything is drawn at SUPERSAMPLE x and downsampled with LANCZOS, because
# PIL's ellipse has no antialiasing of its own.

import os
from PIL import Image, ImageDraw, ImageFont

import pathlib
REPO = str(pathlib.Path(__file__).resolve().parent.parent)
OUT = os.path.join(REPO, "assets")
FONTS = os.path.join(REPO, "node_modules/@expo-google-fonts/ibm-plex-sans")
SEMI = os.path.join(FONTS, "600SemiBold/IBMPlexSans_600SemiBold.ttf")
MED = os.path.join(FONTS, "500Medium/IBMPlexSans_500Medium.ttf")

PAPER = (244, 238, 226, 255)   # #F4EEE2
INK = (28, 36, 48, 255)        # #1C2430
VERDIGRIS = (47, 125, 109, 255)  # #2F7D6D

SS = 4          # supersample factor
VB = 1024       # the SVG viewBox, all geometry below is in these units


def draw_mark(d, scale, ss, with_gnc, m_size, m_baseline):
    """The circles and lettering, in viewBox units, scaled about the centre."""
    def px(v):
        return (v - 512) * scale * ss + 512 * ss

    c = 512 * ss  # centre is invariant under a scale about the centre

    # Circles. PIL strokes INWARD from the bounding box, so the box is the
    # outer edge of the stroke: r + half the stroke width.
    for r, colour in ((330, INK), (250, VERDIGRIS)):
        sw = 40 * scale * ss
        outer = (r * scale * ss) + sw / 2
        d.ellipse(
            [c - outer, c - outer, c + outer, c + outer],
            outline=colour, width=int(round(sw)),
        )

    # "M". SVG y is the BASELINE, which is what anchor "ms" means in PIL.
    f = ImageFont.truetype(SEMI, int(round(m_size * scale * ss)))
    d.text((c, px(m_baseline)), "M", font=f, fill=INK, anchor="ms")

    if not with_gnc:
        return

    # "GNC" with letter-spacing 14. PIL has no letter-spacing, so the glyphs
    # are placed by hand. The run is centred on its INKED width -- spacing
    # between the letters only, with no trailing gap -- which is what centres
    # correctly to the eye. A browser would also add a trailing space and sit
    # the run ~7 units left of this; the difference is invisible at icon size
    # and this is the more defensible of the two.
    fg = ImageFont.truetype(MED, int(round(120 * scale * ss)))
    gap = 14 * scale * ss
    text = "GNC"
    widths = [fg.getlength(ch) for ch in text]
    total = sum(widths) + gap * (len(text) - 1)
    x = c - total / 2
    y = px(640)
    for ch, w in zip(text, widths):
        d.text((x, y), ch, font=fg, fill=INK, anchor="ls")
        x += w + gap


def render(size, scale=1.0, background=None, with_gnc=True,
           m_size=230, m_baseline=505):
    W = size * SS
    img = Image.new("RGBA", (W, W), background or (0, 0, 0, 0))
    draw_mark(ImageDraw.Draw(img), scale, SS * (size / VB), with_gnc, m_size, m_baseline)
    return img.resize((size, size), Image.LANCZOS)


def save(img, name, flatten=False):
    path = os.path.join(OUT, name)
    if flatten:
        # iOS rejects an app icon with an alpha channel.
        bg = Image.new("RGB", img.size, PAPER[:3])
        bg.paste(img, mask=img.split()[3])
        img = bg
    img.save(path)
    print(f"{name:<24} {img.size} {img.mode}")


# 1. iOS / general app icon: full mark on paper, no alpha.
save(render(1024, background=PAPER), "icon.png", flatten=True)

# 2. Android adaptive foreground: transparent, and scaled 0.7 about the centre
#    exactly as adaptive-foreground.svg does -- that inset is what keeps the
#    mark inside the safe zone once the launcher applies its mask.
save(render(1024, scale=0.7), "adaptive-icon.png")

# 3. Splash: the M-only mark, centred, transparent so it composites onto the
#    splash backgroundColor rather than carrying its own square of paper.
save(render(1024, with_gnc=False, m_size=360, m_baseline=640), "splash-icon.png")

# 4. Web favicon, 48px class, from the same M-only mark.
save(render(48, with_gnc=False, m_size=360, m_baseline=640), "favicon.png")

# 5. The 48px-class launcher/notification variant, kept opaque on paper so it
#    is legible against an arbitrary surface.
save(render(96, background=PAPER, with_gnc=False, m_size=360, m_baseline=640),
     "notification-icon.png", flatten=True)
