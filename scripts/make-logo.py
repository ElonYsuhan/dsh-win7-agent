"""Convert the unified logo master to desktop icon formats (Pillow required).

All platforms use assets/icons/source.png. 只有 Windows 的 .ico 会按平台惯例
做一次「裁掉透明外边、接近满幅」的处理，源图本身不改。
Run: python3 scripts/make-logo.py
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / 'assets' / 'icons'

# Windows 的任务栏 / 桌面 / 开始菜单图标是**满幅**绘制的（微信在 72px 的桌面格子里
# 就是 72px），而 master 是按 macOS 圆角图标留了 ~10% 边（内容只占 80%）。
# 直接复用会让 Windows 里的图标明显比别的应用小一圈。
# 2026-11-03：0.96 → 1.0。0.96 仍留 2% 安全边，桌面对比微信还是偏小（实测微信
# 方块 72px、Agent 58px），Windows 不会替我们补这圈边，所以直接铺满。
WIN_FILL = 1.0


def windows_master(master):
    """先裁掉 master 的透明外边，再按 WIN_FILL 居中缩放铺满画布。"""
    alpha = master.split()[3]
    box = alpha.point(lambda value: 255 if value >= 8 else 0).getbbox()
    if not box:
        return master
    content = master.crop(box)
    side = max(content.width, content.height)
    square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    square.paste(content, ((side - content.width) // 2, (side - content.height) // 2))
    target = int(round(master.width * WIN_FILL))
    scaled = square.resize((target, target), Image.Resampling.LANCZOS)
    out = Image.new('RGBA', master.size, (0, 0, 0, 0))
    offset = (master.width - target) // 2
    out.paste(scaled, (offset, offset))
    return out


def main():
    image = Image.open(ICONS / 'source.png').convert('RGBA')
    if image.width != image.height:
        raise ValueError('Logo master must be square')
    master = image.resize((1024, 1024), Image.Resampling.LANCZOS)
    png = master.resize((512, 512), Image.Resampling.LANCZOS)
    png.save(ICONS / 'icon.png')
    windows_master(master).save(ICONS / 'icon.ico', format='ICO', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    master.save(ICONS / 'icon.icns', format='ICNS')
    png.save(ROOT / 'src' / 'renderer' / 'logo.png')
    # Keep legacy resource paths visually identical for existing integrations.
    for name in ['am.png', 'al.png', 'aw.png']:
        (ICONS / name).write_bytes((ICONS / 'icon.png').read_bytes())
    (ICONS / 'am.icns').write_bytes((ICONS / 'icon.icns').read_bytes())
    (ICONS / 'aw.ico').write_bytes((ICONS / 'icon.ico').read_bytes())
    print('Unified PNG, ICO (windows full-bleed), ICNS and renderer logo generated')


if __name__ == '__main__':
    main()
