"""Draw the PasteShot toolbar icons into icons/*.png.

Run with `python3 tools/make-icons.py` (needs Pillow). Every shape is drawn
here, so the icons contain no outside artwork.
"""

from pathlib import Path

from PIL import Image, ImageDraw

GREEN = (29, 60, 50, 255)  # Same as the toolbar badge.
MINT = (134, 214, 170, 255)
PAPER = (250, 248, 242, 255)
INK = (29, 60, 50, 255)
SIZES = (16, 32, 48, 128)
OVERSAMPLE = 8
OUT = Path(__file__).resolve().parent.parent / "icons"


def draw(size):
    s = size * OVERSAMPLE
    u = s / 32  # Shapes are laid out on a 32-unit grid.
    image = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(image)

    d.rounded_rectangle((0, 0, s - 1, s - 1), radius=7 * u, fill=GREEN)

    # A tall page: the whole scrolled page in one image.
    page = (8 * u, 4 * u, 20 * u, 28 * u)
    d.rounded_rectangle(page, radius=1.6 * u, fill=PAPER)
    if size >= 32:
        for y in (8, 11.5, 15, 18.5):
            d.rounded_rectangle((10.5 * u, y * u, 17.5 * u, (y + 1.4) * u), radius=0.7 * u, fill=INK)

    # A mint badge with an arrow: it lands on the clipboard.
    cx, cy, r = 22 * u, 22 * u, 7 * u
    d.ellipse((cx - r - 1.5 * u, cy - r - 1.5 * u, cx + r + 1.5 * u, cy + r + 1.5 * u), fill=GREEN)
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=MINT)
    shaft = 1.1 * u
    d.rectangle((cx - shaft, cy - 4.2 * u, cx + shaft, cy + 0.8 * u), fill=INK)
    d.polygon([(cx - 3.6 * u, cy), (cx + 3.6 * u, cy), (cx, cy + 4 * u)], fill=INK)

    return image.resize((size, size), Image.LANCZOS)


def main():
    for size in SIZES:
        draw(size).save(OUT / f"{size}.png", optimize=True)


if __name__ == "__main__":
    main()
