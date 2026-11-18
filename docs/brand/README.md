# BlockFlow logo

The mark: a trigger block (clock) wired to a browser block, with a "done" block. Violet `#7c3aed`, sky
`#0284c7`, green `#059669`; tinted fills at 12% so it reads on light and dark backgrounds.

| File | Background | Use |
| --- | --- | --- |
| [public/logo.svg](../../public/logo.svg) | transparent | Source of the 48 and 128 px extension icons; anywhere the mark sits on a page. |
| [public/logo-white.svg](../../public/logo-white.svg) | white rounded square | Store listing, README, social images, anywhere a tile is wanted. |
| [public/logo-small.svg](../../public/logo-small.svg) | transparent | Simplified (two blocks, one link) for the 16 and 32 px icons. |
| `logo-transparent-512.png`, `-1024.png` | transparent | Exports of `logo.svg`. |
| `logo-white-512.png`, `-1024.png` | white | Exports of `logo-white.svg`. |

In the editor the mark is `src/entrypoints/editor/components/Logo.tsx` (same paths); its colours are the
`--logo-a`, `--logo-b`, `--logo-ok` tokens in `style.css`, lighter in dark mode.

Regenerate the PNGs after changing an SVG (ImageMagick):

```bash
r(){ magick -background none -density 1200 "$1" -resize ${2}x${2} PNG32:"$3"; }
r public/logo.svg 128 public/icon/128.png;  r public/logo.svg 48 public/icon/48.png
r public/logo-small.svg 32 public/icon/32.png; r public/logo-small.svg 16 public/icon/16.png
for n in 512 1024; do r public/logo.svg $n docs/brand/logo-transparent-$n.png; r public/logo-white.svg $n docs/brand/logo-white-$n.png; done
```
