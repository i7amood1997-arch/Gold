"""Draws the app icon: a pyramid of three gold bars, built in 3D and projected.

Each bar is a truncated prism (wide base, narrower top). We project with a
simple oblique camera (depth rises on screen) so the top face and the sloped
side faces show, light comes from the upper left, and every face gets its
own gradient. Output: an SVG string on a 1024 canvas.

Usage: python icon_art.py [dark|light|mask] > icon.svg
"""
import sys

K = 0.62          # how far depth rises on screen (camera tilt)
W, D, H = 330, 156, 112   # bar base width, depth, height
IX, IZ = 38, 20   # how much the top face is inset on each side (x, depth)

def proj(x, y, z, ox, oy):
    """3D (x right, y up, z away) -> screen (y down)."""
    return (ox + x, oy - y - K * z)

def bar_faces(ox, oy, oz=0):
    """Visible faces of one bar whose base-front-centre sits at 3D (ox, oy, oz)."""
    b = [(-W/2, 0, 0), (W/2, 0, 0), (W/2, 0, D), (-W/2, 0, D)]            # base
    t = [(-W/2+IX, H, IZ), (W/2-IX, H, IZ), (W/2-IX, H, D-IZ), (-W/2+IX, H, D-IZ)]  # top
    P = lambda p: proj(p[0] + ox, p[1] + oy, p[2] + oz, 0, 0)
    return [
        ('left',  [P(b[0]), P(t[0]), P(t[3]), P(b[3])]),
        ('right', [P(b[1]), P(b[2]), P(t[2]), P(t[1])]),
        ('top',   [P(t[0]), P(t[1]), P(t[2]), P(t[3])]),
        ('front', [P(b[0]), P(b[1]), P(t[1]), P(t[0])]),
    ]

def poly(pts):
    return 'M' + ' L'.join(f'{x:.1f} {y:.1f}' for x, y in pts) + ' Z'

def art(theme='dark'):
    gap = 22
    # 3D base-front-centre of each bar. The top bar rests on the two top faces,
    # pulled slightly back from their front edge so it reads as stacked.
    pos = [(-(W/2 + gap/2), 0, 0), ((W/2 + gap/2), 0, 0), (0, H, IZ + 8)]
    # Global bounds to centre the whole stack in the canvas.
    allpts = []
    for p in pos:
        for _, pts in bar_faces(*p):
            allpts += pts
    minx = min(p[0] for p in allpts); maxx = max(p[0] for p in allpts)
    miny = min(p[1] for p in allpts); maxy = max(p[1] for p in allpts)
    target_w = 640
    s = target_w / (maxx - minx)
    cx, cy = (minx + maxx) / 2, (miny + maxy) / 2
    oy_shift = 18  # optical: the shadow sits under the stack, so nudge it up a little
    tf = f'translate({512:.1f} {512 - oy_shift:.1f}) scale({s:.4f}) translate({-cx:.1f} {-cy:.1f})'

    defs = '''
    <linearGradient id="gTop" x1="0" y1="1" x2=".3" y2="0"><stop offset="0" stop-color="#F7D374"/><stop offset="1" stop-color="#FCE9B2"/></linearGradient>
    <linearGradient id="gFront" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F6C850"/><stop offset=".55" stop-color="#E7AC2C"/><stop offset="1" stop-color="#C98A17"/></linearGradient>
    <linearGradient id="gLeft" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#F9D77A"/><stop offset="1" stop-color="#EDBB45"/></linearGradient>
    <linearGradient id="gRight" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#B9800F"/><stop offset="1" stop-color="#94640A"/></linearGradient>
    <linearGradient id="gSheen" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#FFF6D6" stop-opacity=".35"/><stop offset=".45" stop-color="#FFF6D6" stop-opacity="0"/><stop offset="1" stop-color="#7A4F00" stop-opacity=".12"/></linearGradient>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="22"/></filter>
    '''
    if theme == 'dark':
        bg = '<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2E2E31"/><stop offset="1" stop-color="#0F0F11"/></linearGradient>'
        shadow_op = 0.55
    else:
        bg = '<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#E9EAEE"/></linearGradient>'
        shadow_op = 0.28
    fill = {'top': 'url(#gTop)', 'front': 'url(#gFront)', 'left': 'url(#gLeft)', 'right': 'url(#gRight)'}

    body = []
    for p in pos:
        faces = bar_faces(*p)
        for name, pts in faces:
            body.append(f'<path d="{poly(pts)}" fill="{fill[name]}" stroke="{fill[name]}" stroke-width="3" stroke-linejoin="round"/>')
        body.append(f'<path d="{poly(dict(faces)["front"])}" fill="url(#gSheen)"/>')
        # Fine darker edge so the silhouette stays crisp at home-screen size.
        outline = [dict(faces)['left'][0], dict(faces)['left'][1], dict(faces)['top'][3], dict(faces)['top'][2], dict(faces)['right'][2], dict(faces)['right'][0]]
        body.append(f'<path d="{poly(outline)}" fill="none" stroke="#8A5B06" stroke-opacity=".35" stroke-width="2.5" stroke-linejoin="round"/>')
        top = dict(faces)['top']
        tcx = sum(q[0] for q in top) / 4; tcy = sum(q[1] for q in top) / 4
        inner = [(tcx + (q[0] - tcx) * 0.86, tcy + (q[1] - tcy) * 0.72) for q in top]
        body.append(f'<path d="{poly(inner)}" fill="none" stroke="#D9A23A" stroke-opacity=".6" stroke-width="3" stroke-linejoin="round"/>')
        # Crisp highlight along the front-top edge, where the light catches.
        front = dict(faces)['front']
        a, b2 = front[3], front[2]
        body.append(f'<path d="M{a[0]+4:.1f} {a[1]+2:.1f} L{b2[0]-4:.1f} {b2[1]+2:.1f}" stroke="#FFF6D8" stroke-opacity=".9" stroke-width="5" stroke-linecap="round"/>')
    # Soft contact shadow under the bottom row.
    sh_y = maxy + 6
    shadow = f'<ellipse cx="{cx:.1f}" cy="{sh_y:.1f}" rx="{(maxx-minx)*0.46:.1f}" ry="{28/s:.1f}" fill="#000" opacity="{shadow_op}" filter="url(#soft)"/>'

    if theme == 'mask':
        return f'<g transform="{tf}">' + ''.join(body) + '</g>'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs>{bg}{defs}</defs>'
            f'<rect width="1024" height="1024" fill="url(#bg)"/>'
            f'<g transform="{tf}">{shadow}{"".join(body)}</g></svg>')

if __name__ == '__main__':
    print(art(sys.argv[1] if len(sys.argv) > 1 else 'dark'))
