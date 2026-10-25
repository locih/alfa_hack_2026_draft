"""Скачивает иконку из @alfalab/icons (MIT) с jsDelivr и сохраняет как SVG.
Использование: python3 tools/alfa_icon.py CheckmarkMIcon DocumentMIcon ... [-o static/vendor/alfa-icons]
Список имён: https://data.jsdelivr.com/v1/package/npm/@alfalab/icons@3.510.0/flat (папка /glyph/dist/*.js)."""
import re, sys, pathlib, urllib.request
VER = "3.510.0"
out = pathlib.Path("design/alfa-icons")
names = [a for a in sys.argv[1:] if not a.startswith("-")]
if "-o" in sys.argv: out = pathlib.Path(sys.argv[sys.argv.index("-o") + 1])
out.mkdir(parents=True, exist_ok=True)
attr_re = re.compile(r'(\w+):"([^"]*)"')
for name in names:
    url = f"https://cdn.jsdelivr.net/npm/@alfalab/icons@{VER}/glyph/dist/{name}.js"
    js = urllib.request.urlopen(url, timeout=30).read().decode()
    svg_attrs = dict(attr_re.findall(re.search(r'createElement\("svg",t\.__assign\(\{([^}]*)\}', js).group(1)))
    shapes = []
    for tag, body in re.findall(r'createElement\("(path|circle|rect|ellipse|polygon|line)",\{([^}]*)\}', js):
        attrs = dict(attr_re.findall(body))
        attrs = {re.sub(r'([A-Z])', lambda m: '-' + m.group(1).lower(), k): v for k, v in attrs.items()}  # fillRule -> fill-rule
        shapes.append(f'<{tag} ' + " ".join(f'{k}="{v}"' for k, v in attrs.items()) + "/>")
    vb = svg_attrs.get("viewBox", "0 0 24 24"); w = svg_attrs.get("width", "24"); h = svg_attrs.get("height", "24")
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="{vb}" fill="currentColor" role="img">' + "".join(shapes) + "</svg>"
    snake = re.sub(r'(?<!^)(?=[A-Z])', '_', name.removesuffix("Icon")).lower()
    (out / f"{snake}.svg").write_text(svg, encoding="utf-8")
    print("ok", snake + ".svg", len(shapes), "shape(s)")
