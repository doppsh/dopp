# Generates the README's animated hero (vector, looping, light and dark): docs/hero-light.svg, docs/hero-dark.svg
#   1. Your app's requests go through Dopp to Jev, and every one is kept.
#   2. Tiny trains on those requests, on your own CPU.
#   3. Your model answers; Jev only when the model is unsure.
# Run: python3 docs/make-hero.py
# The model's numbers are from the repo's Home Assistant example, run on a laptop CPU (npm run example:home-assistant, 30 Sep 2026):
# Tiny v1 trained on 205 template commands, 100% agreement on 68 held-out answers, 1.8 ms a request on CPU, 34 MB.
from html import escape

W, H, LOOP = 860, 330, 16
MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace"
SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif"
THEMES = {
    'light': dict(ink='#1c2544', muted='#626d85', line='#d0d7e6', chip='#f6f8fc', panel='#ffffff', go='#0b7a53', go_bg='#def5ea', jev='#244bd8', jev_bg='#e6ecff', warn='#a1490a'),
    'dark':  dict(ink='#e6edf3', muted='#8b949e', line='#30363d', chip='#161b22', panel='#0d1117', go='#56d364', go_bg='#12301f', jev='#7c9cff', jev_bg='#1b2547', warn='#f0a35e'),
}
EASE = (0.5, 0, 0.15, 1)


def bezier_y(x, c=EASE):
    x1, y1, x2, y2 = c; lo, hi = 0.0, 1.0
    for _ in range(40):
        u = (lo + hi) / 2; bx = 3 * (1 - u) ** 2 * u * x1 + 3 * (1 - u) * u ** 2 * x2 + u ** 3
        lo, hi = (u, hi) if bx < x else (lo, u)
    u = (lo + hi) / 2
    return 3 * (1 - u) ** 2 * u * y1 + 3 * (1 - u) * u ** 2 * y2 + u ** 3


def text(x, y, s, size=14, fill='#000', font=SANS, weight=400, anchor='start', extra=''):
    return f'<text x="{x:.1f}" y="{y:.1f}" font-family="{font}" font-size="{size}" font-weight="{weight}" fill="{fill}" text-anchor="{anchor}"{extra}>{escape(s)}</text>'


def visible(name, spans, fade=0.6):
    """Opacity keyframes: shown during each (start%, end%) span, with short fades."""
    stops = [(0, 0)]
    for a, b in spans:
        stops += [(max(a - fade, 0), 0), (a, 1), (b, 1), (min(b + fade, 100), 0)]
    stops.append((100, 0))
    body, seen = '', set()
    for p, v in stops:
        k = round(p, 2)
        if k in seen: continue
        seen.add(k); body += f'{k}%{{opacity:{v}}}'
    return f'@keyframes {name}{{{body}}}.{name}{{opacity:0;animation:{name} {LOOP}s linear infinite}}'


def trip(name, legs):
    """A dot moving through points: legs = [(start%, end%, (x0, y0), (x1, y1))], eased, hidden outside them."""
    frames = [(0, None)]
    for a, b, p0, p1 in legs:
        for i in range(11):
            f = i / 10; e = bezier_y(f)
            frames.append((a + (b - a) * f, (p0[0] + (p1[0] - p0[0]) * e, p0[1] + (p1[1] - p0[1]) * e)))
    first, last = legs[0][0], legs[-1][1]
    body = f'0%,{max(first - 0.01, 0):.2f}%{{opacity:0;transform:translate({legs[0][2][0]}px,{legs[0][2][1]}px)}}'
    for p, xy in frames[1:]:
        body += f'{p:.2f}%{{opacity:1;transform:translate({xy[0]:.1f}px,{xy[1]:.1f}px)}}'
    body += f'{min(last + 0.01, 100):.2f}%,100%{{opacity:0;transform:translate({legs[-1][3][0]}px,{legs[-1][3][1]}px)}}'
    return f'@keyframes {name}{{{body}}}.{name}{{opacity:0;animation:{name} {LOOP}s linear infinite}}'


def hero(t):
    o, css = [], []
    APP = (24, 110, 150, 70); DOPP = (320, 96, 190, 98); JEV = (676, 40, 160, 70); MOD = (676, 196, 160, 84)
    def box(x, y, w, h, stroke, fill, r=12, extra=''):
        return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" stroke="{stroke}" stroke-width="1.5"{extra}/>'
    ax, ay = APP[0] + APP[2], APP[1] + APP[3] / 2           # app's right edge
    dl, dr, dy = DOPP[0], DOPP[0] + DOPP[2], DOPP[1] + DOPP[3] / 2
    jx, jy = JEV[0], JEV[1] + JEV[3] / 2; mx, my = MOD[0], MOD[1] + MOD[3] / 2

    # wires
    o.append(f'<path d="M{ax} {ay} L{dl} {dy}" stroke="{t["line"]}" stroke-width="2" fill="none"/>')
    o.append(f'<path d="M{dr} {dy} L{jx} {jy}" stroke="{t["line"]}" stroke-width="2" fill="none"/>')
    o.append(f'<path d="M{dr} {dy} L{mx} {my}" stroke="{t["line"]}" stroke-width="2" fill="none" stroke-dasharray="5 5"/>')

    # boxes
    o.append(box(*APP, t['line'], t['chip']) + text(APP[0] + APP[2] / 2, APP[1] + 30, 'your app', 15, t['ink'], SANS, 650, 'middle')
             + text(APP[0] + APP[2] / 2, APP[1] + 51, 'POST /v1/systemone', 11, t['muted'], MONO, 400, 'middle'))
    o.append(box(*DOPP, t['go'], t['panel']) + text(dl + DOPP[2] / 2, DOPP[1] + 30, 'Dopp', 17, t['ink'], SANS, 700, 'middle')
             + text(dl + DOPP[2] / 2, DOPP[1] + 50, 'one URL, your server', 12, t['muted'], SANS, 400, 'middle'))
    o.append(box(*JEV, t['jev'], t['jev_bg']) + text(jx + JEV[2] / 2, JEV[1] + 30, 'Jev', 16, t['jev'], SANS, 700, 'middle')
             + text(jx + JEV[2] / 2, JEV[1] + 50, "TypeSafe's API", 12, t['muted'], SANS, 400, 'middle'))
    # the model: empty until trained, then solid
    o.append(box(*MOD, t['line'], t['chip'], extra=' stroke-dasharray="5 5"') + text(mx + MOD[2] / 2, MOD[1] + 34, 'your model', 15, t['muted'], SANS, 650, 'middle')
             + text(mx + MOD[2] / 2, MOD[1] + 54, 'not trained yet', 12, t['muted'], SANS, 400, 'middle'))
    css.append(visible('tr', [(38, 56)]))
    o.append(f'<g class="tr">{box(*MOD, t["warn"], t["chip"])}' + text(mx + MOD[2] / 2, MOD[1] + 30, 'training Tiny', 14, t['warn'], SANS, 650, 'middle')
             + text(mx + MOD[2] / 2, MOD[1] + 48, 'on your CPU', 12, t['muted'], SANS, 400, 'middle')
             + f'<rect x="{mx + 20}" y="{MOD[1] + 60}" width="{MOD[2] - 40}" height="6" rx="3" fill="{t["line"]}"/>'
             + f'<rect class="bar" x="{mx + 20}" y="{MOD[1] + 60}" width="{MOD[2] - 40}" height="6" rx="3" fill="{t["warn"]}"/></g>')
    css.append(f'@keyframes bar{{0%,38%{{transform:scaleX(0)}}54%,100%{{transform:scaleX(1)}}}}.bar{{transform-box:fill-box;transform-origin:left;animation:bar {LOOP}s cubic-bezier(.5,0,.15,1) infinite}}')
    css.append(visible('md', [(56, 97)], 0.8))
    o.append(f'<g class="md">{box(*MOD, t["go"], t["go_bg"])}' + text(mx + MOD[2] / 2, MOD[1] + 26, 'your model', 15, t['go'], SANS, 700, 'middle')
             + text(mx + MOD[2] / 2, MOD[1] + 46, '34 MB · 1.8 ms on CPU', 12, t['ink'], SANS, 400, 'middle')
             + text(mx + MOD[2] / 2, MOD[1] + 64, '100% on 68 held-out answers', 12, t['ink'], SANS, 400, 'middle') + '</g>')

    # request counter under Dopp (hard cuts between numbers)
    counts = [(4, 13, '1'), (13, 22, '2'), (22, 30, '3'), (30, 56, '205'), (56, 97, '205 and counting')]
    o.append(text(dl + DOPP[2] / 2, DOPP[1] + 74, 'requests kept', 11, t['muted'], SANS, 400, 'middle'))
    for i, (a, b, s) in enumerate(counts):
        css.append(visible(f'c{i}', [(a, b)], 0.2))
        o.append(f'<g class="c{i}">' + text(dl + DOPP[2] / 2, DOPP[1] + 90, s, 13, t['go'], MONO, 600, 'middle') + '</g>')

    # requests: three to Jev, then three to the model (one unsure, asked of Jev too)
    A, D, J, M = (ax, ay), (dr, dy), (jx, jy), (mx, my)
    def go_and_back(n, s, far, fill, dur=8):
        q = dur / 4
        css.append(trip(f'd{n}', [(s, s + q, A, D), (s + q, s + 2 * q, D, far), (s + 2 * q + 0.3, s + 3 * q, far, D), (s + 3 * q, s + 4 * q - 0.3, D, A)]))
        o.append(f'<circle class="d{n}" cx="0" cy="0" r="6" fill="{fill}"/>')
    go_and_back(0, 2, J, t['jev']); go_and_back(1, 11, J, t['jev']); go_and_back(2, 20, J, t['jev'])
    go_and_back(3, 60, M, t['go'], 6); go_and_back(4, 68, M, t['go'], 6)
    q = 2   # the unsure one: model, then Jev
    css.append(trip('d5', [(77, 77 + q, A, D), (77 + q, 79 + q, D, M), (79.3 + q, 81 + q, M, D), (81 + q, 83 + q, D, J), (83.3 + q, 85 + q, J, D), (85 + q, 87 + q, D, A)]))
    o.append(f'<circle class="d5" cx="0" cy="0" r="6" fill="{t["warn"]}"/>')
    css.append(visible('un', [(80, 88)], 0.4))
    o.append(f'<g class="un">' + text(jx + JEV[2] / 2, JEV[1] + JEV[3] + 20, 'model unsure: Jev answers', 12, t['warn'], SANS, 600, 'middle') + '</g>')

    # the step being shown, bottom
    steps = [(0, 37, '1  Point your app at Dopp. Jev still answers, and every request is kept.'),
             (38, 56, '2  Train a small open model on those requests, on your own CPU.'),
             (56, 97, '3  Your model answers, offline if you like. Jev only when it is unsure.')]
    for i, (a, b, s) in enumerate(steps):
        css.append(visible(f's{i}', [(a + 0.5, b)], 0.8))
        o.append(f'<g class="s{i}">' + text(W / 2, H - 22, s, 15, t['ink'], SANS, 500, 'middle') + '</g>')

    css.append('@media (prefers-reduced-motion: reduce){circle{display:none}}')
    label = ('Animation: requests from your app go through Dopp to Jev, and every one is kept. A small model trains on them on your '
             'own CPU. Then your model answers, in 1.8 milliseconds, with 100% agreement on 68 held-out answers from the Home Assistant example, and Jev answers only when the model is unsure.')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="{escape(label)}">'
            f'<style>{"".join(css)}</style><rect x="0.5" y="0.5" width="{W - 1}" height="{H - 1}" rx="16" fill="{t["panel"]}" stroke="{t["line"]}"/>{"".join(o)}</svg>')


if __name__ == '__main__':
    import os
    here = os.path.dirname(os.path.abspath(__file__))
    for name, t in THEMES.items():
        open(os.path.join(here, f'hero-{name}.svg'), 'w').write(hero(t))
    print('wrote docs/hero-light.svg and docs/hero-dark.svg')
