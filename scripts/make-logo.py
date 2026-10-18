"""Convert the unified logo master to desktop icon formats (Pillow required).

All platforms use assets/icons/source.png. No platform-specific artwork.
Run: python3 scripts/make-logo.py
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / 'assets' / 'icons'

def main():
    image = Image.open(ICONS / 'source.png').convert('RGBA')
    if image.width != image.height:
        raise ValueError('Logo master must be square')
    master = image.resize((1024, 1024), Image.Resampling.LANCZOS)
    png = master.resize((512, 512), Image.Resampling.LANCZOS)
    png.save(ICONS / 'icon.png')
    master.save(ICONS / 'icon.ico', format='ICO', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    master.save(ICONS / 'icon.icns', format='ICNS')
    png.save(ROOT / 'src' / 'renderer' / 'logo.png')
    # Keep legacy resource paths visually identical for existing integrations.
    for name in ['am.png', 'al.png', 'aw.png']:
        (ICONS / name).write_bytes((ICONS / 'icon.png').read_bytes())
    (ICONS / 'am.icns').write_bytes((ICONS / 'icon.icns').read_bytes())
    (ICONS / 'aw.ico').write_bytes((ICONS / 'icon.ico').read_bytes())
    print('Unified PNG, ICO, ICNS and renderer logo generated')

if __name__ == '__main__':
    main()
