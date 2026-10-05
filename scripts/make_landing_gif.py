# Gera os GIFs do hero da landing a partir das cenas capturadas (2x).
# - hero-tour.gif: tour desktop (dashboard -> editor com karaokê -> busca)
# - hero-tour-mobile.gif: tour mobile (dashboard -> editor)
# Uso: python scripts/make_landing_gif.py
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "landing"

HOLD_MS = 1600        # tempo exibindo cada cena
FADE_MS = 500         # duracao do crossfade
FPS_MS = 100          # intervalo entre frames
COLORS = 128          # paleta adaptativa por frame


def fit(img: Image.Image, width: int) -> Image.Image:
    w, h = img.size
    target_h = int(w * 0.60)
    if h > target_h:
        top = (h - target_h) // 2
        img = img.crop((0, top, w, top + target_h))
    return img.resize((width, int(width * 0.60)), Image.LANCZOS)


def build(cenas: list, width: int, out: Path):
    screens = [fit(Image.open(p).convert("RGB"), width) for p in cenas]
    hold = max(1, HOLD_MS // FPS_MS)
    fade = max(2, FADE_MS // FPS_MS)
    frames, durations = [], []
    for i, screen in enumerate(screens):
        pal = screen.convert("P", palette=Image.ADAPTIVE, colors=COLORS)
        for _ in range(hold):
            frames.append(pal)
            durations.append(FPS_MS)
        nxt = screens[(i + 1) % len(screens)]
        for s in range(1, fade + 1):
            blend = Image.blend(screen, nxt, s / (fade + 1))
            frames.append(blend.convert("P", palette=Image.ADAPTIVE, colors=COLORS))
            durations.append(FPS_MS)
    frames[0].save(out, save_all=True, append_images=frames[1:],
                   duration=durations, loop=0, optimize=True)
    print(f"OK: {out.name} ({out.stat().st_size // 1024} KB, {len(frames)} frames)")


def main():
    build(
        [SRC / "cena-dashboard.png", SRC / "cena-editor.png", SRC / "cena-busca.png"],
        960, SRC / "hero-tour.gif",
    )
    build(
        [SRC / "cena-mobile-dashboard.png", SRC / "cena-mobile-editor.png"],
        420, SRC / "hero-tour-mobile.gif",
    )


if __name__ == "__main__":
    main()
