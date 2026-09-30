# dopp README header: the wordmark and its double. A ghost "dopp" drifts in, locks onto the real one and turns green;
# the dictionary entry sits beside it. Light and dark variants; CSS animation inside the SVG (plays as an <img> on GitHub).
T={'dark':dict(bg='#0d1117',ink='#f2f4f8',muted='#8b95a5',line='#262d39',go='#4ade80',ghost='#8b95a5'),
   'light':dict(bg='#ffffff',ink='#0d1117',muted='#57606a',line='#d0d7de',go='#16a34a',ghost='#8c959f')}
def svg(t):
    c=T[t]
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 860 240" width="860" height="240" role="img" aria-label="dopp, /dɒp/, noun: short for doppelgänger. A small model of your own that answers your app's questions, on your hardware.">
<style>
.w{{font:800 104px -apple-system,BlinkMacSystemFont,'SF Pro Display','Inter','Segoe UI',Helvetica,Arial,sans-serif;letter-spacing:-2px}}
.real{{fill:{c['ink']}}}
.ghost{{fill:none;stroke:{c['ghost']};stroke-width:1.6;animation:drift 6s cubic-bezier(.6,0,.2,1) infinite}}
.twin{{fill:{c['go']};opacity:0;animation:lock 6s cubic-bezier(.6,0,.2,1) infinite}}
@keyframes drift{{0%,12%{{transform:translate(16px,-10px);opacity:.85}}46%{{transform:translate(0,0);opacity:.9}}52%,100%{{transform:translate(0,0);opacity:0}}}}
@keyframes lock{{0%,46%{{opacity:0}}54%,82%{{opacity:1}}94%,100%{{opacity:0}}}}
.hw{{font:700 30px Georgia,'Times New Roman',serif;fill:{c['ink']}}}
.ipa{{font:400 20px Georgia,serif;fill:{c['muted']}}}
.pos{{font:italic 20px Georgia,serif;fill:{c['go']}}}
.def{{font:18px Georgia,serif;fill:{c['ink']}}}
.ety{{font:17px Georgia,serif;fill:{c['muted']}}}
.n{{font:18px Georgia,serif;fill:{c['go']}}}
@media (prefers-reduced-motion:reduce){{.ghost{{animation:none;opacity:0}}.twin{{animation:none;opacity:0}}}}
</style>
<rect x="1" y="1" width="858" height="238" rx="16" fill="{c['bg']}" stroke="{c['line']}"/>
<g transform="translate(44,160)">
  <text class="w ghost">dopp</text>
  <text class="w real">dopp</text>
  <text class="w twin">dopp</text>
</g>
<line x1="330" y1="52" x2="330" y2="188" stroke="{c['line']}" stroke-width="1.5"/>
<g transform="translate(362,0)">
  <text y="84"><tspan class="hw">dopp</tspan><tspan class="ipa" dx="12">/dɒp/</tspan><tspan class="pos" dx="10">noun</tspan></text>
  <text class="ety" y="114">short for <tspan font-style="italic" fill="{c['ink']}">doppelgänger</tspan>, a double</text>
  <text y="150"><tspan class="n">1.</tspan><tspan class="def" dx="8">a small model of your own that answers</tspan></text>
  <text class="def" y="174" x="22">your app's questions, on your hardware.</text>
</g>
</svg>'''
import os
for t in T: open(os.path.join(os.path.dirname(os.path.abspath(__file__)), f'header-{t}.svg'),'w').write(svg(t))
