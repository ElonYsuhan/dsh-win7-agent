"""Generate the Agent app icons.

Three platform variants share one mark: a blue gradient "A" plus a dark slate
stroked second letter, on a white rounded square.

    AM -> Agent Mac    (macOS, becomes Contents/Resources/electron.icns)
    AL -> Agent Linux  (Linux, used directly as the window icon)
    AW -> Agent Win    (Windows, becomes the exe icon resource)

Outputs:
    assets/icons/am.png  al.png  aw.png    512x512 masters
    assets/icons/am.icns                   macOS bundle icon
    assets/icons/aw.ico                    Windows icon, multi size
    src/renderer/logo.png                  in-app brand mark (AW variant)

Requires Pillow and numpy:
    pip install Pillow numpy
    python scripts/make-logo.py
"""
import math
import os

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON_DIR = os.path.join(ROOT, 'assets', 'icons')
BRAND_MARK = os.path.join(ROOT, 'src', 'renderer', 'logo.png')

OUT = 512
SS = 4
S = OUT * SS
BG_RADIUS = int(S * 0.1980)
SMOOTH = Image.Resampling.LANCZOS
MITER_LIMIT = 3.5

# 字母排布：A 占 [62,242]，第二个字母占 [250,434]，上下都是 [128,384]
STROKE = 44 * SS

LETTER_PATHS = {
    # 与 W 同一套描边语言：竖笔起收在 128 / 384，尖角在中段
    'W': [(250, 128), (296, 384), (342, 292), (388, 384), (434, 128)],
    'M': [(250, 384), (250, 128), (342, 268), (434, 128), (434, 384)],
    'L': [(250, 128), (250, 384), (434, 384)]
}


def sc(pt):
    return (pt[0] * SS, pt[1] * SS)


def linear_gradient(size, c1, c2, p1, p2):
    ys, xs = np.mgrid[0:size, 0:size].astype(np.float32)
    x1, y1 = p1
    x2, y2 = p2
    dx, dy = x2 - x1, y2 - y1
    denom = float(dx * dx + dy * dy) or 1.0
    t = ((xs - x1) * dx + (ys - y1) * dy) / denom
    t = np.clip(t, 0.0, 1.0)[..., None]
    a = np.array(c1, np.float32)
    b = np.array(c2, np.float32)
    return (a + (b - a) * t).astype(np.uint8)


def miter_polyline(draw, points, width):
    """把折线描成一个带尖接的实心条带（W / M / L 都靠它）。"""
    hw = width / 2.0
    n = len(points)
    segs = []
    for i in range(n - 1):
        dx = points[i + 1][0] - points[i][0]
        dy = points[i + 1][1] - points[i][1]
        length = math.hypot(dx, dy)
        segs.append((dx / length, dy / length))

    def corner(index, side):
        if index == 0:
            ux, uy = segs[0]
            return (points[0][0] - uy * side * hw, points[0][1] + ux * side * hw)
        if index == n - 1:
            ux, uy = segs[-1]
            return (points[-1][0] - uy * side * hw, points[-1][1] + ux * side * hw)
        u1x, u1y = segs[index - 1]
        u2x, u2y = segs[index]
        n1x, n1y = -u1y * side, u1x * side
        n2x, n2y = -u2y * side, u2x * side
        denom = 1.0 + (n1x * n2x + n1y * n2y)
        if abs(denom) < 1e-4:
            denom = 1e-4
        mx = (n1x + n2x) / denom
        my = (n1y + n2y) / denom
        span = math.hypot(mx, my)
        if span > MITER_LIMIT:
            mx, my = mx / span * MITER_LIMIT, my / span * MITER_LIMIT
        return (points[index][0] + mx * hw, points[index][1] + my * hw)

    for i in range(n - 1):
        draw.polygon([corner(i, 1), corner(i + 1, 1), corner(i + 1, -1), corner(i, -1)], fill=255)


def mask_a():
    """实心 "A"：大三角挖掉内三角，再补一道横梁。"""
    mask = Image.new('L', (S, S), 0)
    draw = ImageDraw.Draw(mask)
    draw.polygon([sc((152, 128)), sc((62, 384)), sc((242, 384))], fill=255)
    draw.polygon([sc((152, 250)), sc((110, 384)), sc((194, 384))], fill=0)
    draw.rectangle([*sc((98, 308)), *sc((206, 348))], fill=255)
    return mask


def mask_letter(letter):
    mask = Image.new('L', (S, S), 0)
    miter_polyline(ImageDraw.Draw(mask), [sc(pt) for pt in LETTER_PATHS[letter]], STROKE)
    return mask


# 白底（2026-09-19 用户要求）：原来的深色底在深色侧边栏里糊成一团，看不清。
# 改白底带来两个连带修改，别漏：
#   1. 第二个字母不能再是银色 —— 白字压白底等于没有字，改成深灰蓝；
#   2. 边缘要补一道极淡描边，否则图标放在白色页面/浅色任务栏上没有轮廓。
BG_TOP = (0xff, 0xff, 0xff)
BG_BOTTOM = (0xe9, 0xed, 0xf3)
OUTLINE = (0xcd, 0xd3, 0xdc)
TONE_A = ((0x54, 0xa4, 0xff), (0x0b, 0x3f, 0xb8))
TONE_LETTER = ((0x8a, 0x93, 0xa3), (0x2f, 0x3a, 0x4a))


def render(letter):
    """画一枚 512x512 图标：白色圆角块 + 蓝色 A + 深灰第二个字母。"""
    radius_mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(radius_mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=BG_RADIUS, fill=255)

    canvas = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    backing = linear_gradient(S, BG_TOP, BG_BOTTOM, sc((0, 0)), sc((OUT, OUT)))
    canvas.paste(Image.fromarray(backing, 'RGB').convert('RGBA'), (0, 0), radius_mask)

    grad_letter = Image.fromarray(
        linear_gradient(S, TONE_LETTER[0], TONE_LETTER[1], sc((250, 128)), sc((434, 384))), 'RGB'
    ).convert('RGBA')
    canvas.paste(grad_letter, (0, 0), mask_letter(letter))

    grad_a = Image.fromarray(
        linear_gradient(S, TONE_A[0], TONE_A[1], sc((62, 128)), sc((242, 384))), 'RGB'
    ).convert('RGBA')
    canvas.paste(grad_a, (0, 0), mask_a())

    # 极淡描边，压着圆角块的边画：白底图标不靠它就「没有形状」
    inset = int(1 * SS)
    ImageDraw.Draw(canvas).rounded_rectangle(
        [inset, inset, S - 1 - inset, S - 1 - inset],
        radius=BG_RADIUS - inset,
        outline=OUTLINE + (255,),
        width=int(2 * SS)
    )

    return canvas.resize((OUT, OUT), SMOOTH)


def write_icns(image, path):
    """macOS bundle 图标。优先 Pillow 直写，不行就退回 iconutil（只在 macOS 有）。"""
    try:
        image.save(path, format='ICNS')
        return 'pillow'
    except Exception as error:  # noqa: BLE001 - 回退路径，任何失败都要兜住
        print('  icns via Pillow failed (%s), falling back to iconutil' % error)

    import shutil
    import subprocess
    import tempfile

    if not shutil.which('iconutil'):
        print('  iconutil unavailable, keeping existing ' + os.path.basename(path))
        return None

    # iconset 的尺寸与命名是 iconutil 硬性要求的
    specs = [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)]
    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, 'icon.iconset')
        os.makedirs(iconset)
        for size, scale in specs:
            pixels = size * scale
            name = 'icon_%dx%d%s.png' % (size, size, '@2x' if scale == 2 else '')
            image.resize((pixels, pixels), SMOOTH).save(os.path.join(iconset, name))
        subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', path], check=True)
    return 'iconutil'


def main():
    os.makedirs(ICON_DIR, exist_ok=True)

    variants = {'AM': 'M', 'AL': 'L', 'AW': 'W'}
    rendered = {}
    for name, letter in variants.items():
        image = render(letter)
        rendered[name] = image
        image.save(os.path.join(ICON_DIR, name.lower() + '.png'))

    # Windows 用多尺寸 ico，小尺寸要单独给，让系统挑最合适的一档
    rendered['AW'].save(
        os.path.join(ICON_DIR, 'aw.ico'),
        format='ICO',
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    )

    how = write_icns(rendered['AM'], os.path.join(ICON_DIR, 'am.icns'))

    # 界面里的品牌标：桌面版打包时会按平台覆盖成 AM / AL / AW，仓库里默认放 AW
    rendered['AW'].save(BRAND_MARK)

    # 自检图：512 原图 + 缩到实际显示尺寸的样子，用来确认小尺寸不糊
    cells = [('512px', rendered['AW'], 1.0), ('64px', rendered['AW'], 0.125),
             ('32px', rendered['AW'], 0.0625), ('22px', rendered['AW'], 0.0430)]
    pad = 20
    widths = [OUT] + [int(OUT * s * 5) for _, _, s in cells[1:]]
    sheet = Image.new('RGB', (sum(widths) + pad * (len(widths) + 1), OUT + pad * 2), (0x18, 0x18, 0x1a))
    x = pad
    for i, (_, img, s) in enumerate(cells):
        if i == 0:
            tile = img
        else:
            small = img.resize((int(OUT * s), int(OUT * s)), SMOOTH)
            tile = small.resize((small.width * 5, small.height * 5), Image.Resampling.NEAREST)
        sheet.paste(tile.convert('RGB'), (x, pad))
        x += tile.width + pad
    sheet.save('/tmp/logo-scale-check.png')

    print('generated: ' + ', '.join(sorted(os.path.basename(p) for p in os.listdir(ICON_DIR))))
    print('icns: ' + str(how))


if __name__ == '__main__':
    main()
