# Gera o GIF do hero da landing: crossfade entre as telas reais do app.
# Uso: python scripts/make_landing_gif.py
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "landing"
OUT = SRC / "hero-tour.gif"

WIDTH = 960           # largura do GIF (hero da landing)
HOLD_MS = 1400        # tempo exibindo cada tela
FADE_MS = 500         # duracao do crossfade
FPS_MS = 100          # intervalo entre frames
COLORS = 128          # paleta adaptativa por frame (GIF otimizado)


def fit(img: Image.Image) -> Image.Image:
    # mesma largura, crop central na altura padrao
    w, h = img.size
    target_h = int(w * 0.60)
    if h > target_h:
        top = (h - target_h) // 2
        img = img.crop((0, top, w, top + target_h))
    return img.resize((WIDTH, int(WIDTH * 0.60)), Image.LANCZOS)


def main():
    screens = [fit(Image.open(p).convert("RGB")) for p in [
        SRC / "app-dashboard.png",
        SRC / "app-editor.png",
        SRC / "app-mobile.png",
    ]]
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

    frames[0].save(
        OUT, save_all=True, append_images=frames[1:],
        duration=durations, loop=0, optimize=True,
    )
    print(f"OK: {OUT} ({OUT.stat().st_size // 1024} KB, {len(frames)} frames)")


if __name__ == "__main__":
    main()
