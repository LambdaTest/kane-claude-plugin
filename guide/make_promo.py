"""Cuts a short captioned promo from a recorded walkthrough.

    python3 make_promo.py promo.json

promo.json: { "source": "take.mp4", "output": "promo.mp4", "title": [..lines], "end": [..lines],
              "segments": [ { "from": 12.0, "to": 17.5, "speed": 1, "caption": "...", "sub": "...",
                              "crop": [x, y, w, h], "mask": [[x, y, w, h], ...] }, ... ] }
The recording plays in a frame above a caption bar. Captions and cards are drawn with Pillow (this ffmpeg has no drawtext)."""
import json
import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080
BAR = 132                      # caption bar height
VH = H - BAR                   # the recording's height in the frame
VW = round(VH * 16 / 9)
BG = (13, 11, 22)
INK = (233, 230, 245)
MUTED = (160, 155, 187)
PURPLE = (179, 136, 255)
FONT = '/System/Library/Fonts/Avenir Next.ttc'
FPS = 30


def font(size: int, weight: str = 'demi'):
    return ImageFont.truetype(FONT, size, index={'bold': 0, 'demi': 2, 'medium': 5, 'regular': 7}[weight])


def caption_png(path: str, caption: str, sub: str):
    """The full frame, transparent where the recording shows: only the bar is painted."""
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle([0, VH, W, H], fill=BG + (255,))
    d.rectangle([0, VH, W, VH + 2], fill=(50, 45, 72, 255))
    x = (W - VW) // 2 + 6
    d.rectangle([x, VH + 34, x + 6, H - 34], fill=PURPLE + (255,))
    d.text((x + 26, VH + 26), caption, font=font(40, 'demi'), fill=INK + (255,))
    if sub:
        d.text((x + 26, VH + 80), sub, font=font(26, 'regular'), fill=MUTED + (255,))
    im.save(path)


def card_png(path: str, lines: list[str]):
    """A title or end card: the first line large, the rest smaller; a line starting with `$ ` is a command."""
    im = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(im)
    sizes = [(l, font(34, 'medium') if l.startswith('$ ') else font(84 if i == 0 else 40, 'bold' if i == 0 else 'regular')) for i, l in enumerate(lines)]
    heights = [f.getbbox('Ag')[3] + (44 if i == 0 else 22) for i, (_, f) in enumerate(sizes)]
    y = (H - sum(heights)) // 2
    for i, (l, f) in enumerate(sizes):
        text = l[2:] if l.startswith('$ ') else l
        w = d.textlength(text, font=f)
        colour = PURPLE if l.startswith('$ ') else INK if i == 0 else MUTED
        d.text(((W - w) / 2, y), text, font=f, fill=colour)
        y += heights[i]
    im.save(path)


def run(args: list[str]):
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', *args], check=True)


def main():
    cfg = json.load(open(sys.argv[1]))
    tmp = tempfile.mkdtemp(prefix='promo-')
    parts: list[str] = []
    enc = ['-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-r', str(FPS)]

    def card(name: str, lines: list[str], seconds: float):
        png, mp4 = f'{tmp}/{name}.png', f'{tmp}/{name}.mp4'
        card_png(png, lines)
        run(['-loop', '1', '-t', str(seconds), '-i', png, '-vf', f'fade=in:0:10,fade=out:{int(seconds * FPS) - 10}:10', *enc, mp4])
        parts.append(mp4)

    if cfg.get('title'):
        card('title', cfg['title'], cfg.get('title_seconds', 2.6))
    for i, s in enumerate(cfg['segments']):
        png, mp4 = f'{tmp}/c{i}.png', f'{tmp}/s{i}.mp4'
        caption_png(png, s['caption'], s.get('sub', ''))
        speed = s.get('speed', 1)
        length = (s['to'] - s['from']) / speed
        frames = int(length * FPS)
        # An optional crop (x, y, w, h in source pixels) zooms into one part of the screen.
        crop = f"crop={s['crop'][2]}:{s['crop'][3]}:{s['crop'][0]}:{s['crop'][1]}," if s.get('crop') else ''
        # Optional masks ([x, y, w, h] in source pixels) paint over part of the chat in the terminal's own background.
        mask = ''.join(f"drawbox=x={m[0]}:y={m[1]}:w={m[2]}:h={m[3]}:color=0x171717:t=fill," for m in s.get('mask', []))
        filt = (
            f"[0:v]trim=start={s['from']}:end={s['to']},setpts=(PTS-STARTPTS)/{speed},fps={FPS},{mask}{crop}scale={VW}:{VH}:flags=lanczos,"
            f"pad={W}:{H}:{(W - VW) // 2}:0:color=0x0d0b16[v];[v][1:v]overlay=0:0,fade=in:0:6,fade=out:{max(0, frames - 6)}:6[out]"
        )
        run(['-i', cfg['source'], '-i', png, '-filter_complex', filt, '-map', '[out]', *enc, mp4])
        parts.append(mp4)
    if cfg.get('end'):
        card('end', cfg['end'], cfg.get('end_seconds', 4))
    listing = f'{tmp}/list.txt'
    open(listing, 'w').write(''.join(f"file '{p}'\n" for p in parts))
    run(['-f', 'concat', '-safe', '0', '-i', listing, '-c', 'copy', '-movflags', '+faststart', cfg['output']])
    total = sum(float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p], capture_output=True, text=True).stdout) for p in parts)
    print(f"{cfg['output']}: {len(parts)} parts, {total:.1f}s")


if __name__ == '__main__':
    main()
