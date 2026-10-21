#!/usr/bin/env python3
"""Render Lascoria's public product film. Requires Pillow and ffmpeg, never part of app runtime.

Uses the app's porcelain/ink/periwinkle tokens, folded-wing mark and public example labels.
No account, repository, session capture, credentials or measured performance data is read.
"""
from __future__ import annotations
import argparse
import math
from pathlib import Path
import subprocess
from functools import lru_cache
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
W, H, SCALE, FPS, DURATION = 1280, 720, 2, 30, 24
C = dict(bg='#f6f5f2', panel='#fffefb', raised='#eeedf3', ink='#23283d', muted='#646779',
         line='#dddde5', accent='#5950a8', soft='#eeecf8', wing='#8275d6', success='#34725b', attention='#8c5f17')


def find_font(mono=False):
    names = (['/System/Library/Fonts/SFNSMono.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
              'C:/Windows/Fonts/consola.ttf'] if mono else
             ['/System/Library/Fonts/SFNS.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
              'C:/Windows/Fonts/segoeui.ttf'])
    return next((p for p in names if Path(p).is_file()), None)


FONT, MONO = find_font(), find_font(True)


@lru_cache(maxsize=80)
def font(size, weight='Regular', mono=False):
    f = ImageFont.truetype(MONO if mono else FONT, round(size*SCALE))
    try:
        f.set_variation_by_name(weight)
    except (OSError, ValueError):
        pass
    return f


def point(v):
    return tuple(round(n*SCALE) for n in v)


def box(v):
    return tuple(round(n*SCALE) for n in v)


def text(draw, xy, value, size=16, color='ink', weight='Regular', mono=False):
    draw.text(point(xy), value, font=font(size, weight, mono), fill=C.get(color, color), anchor='lt')


def center(draw, x, y, value, size, color='ink', weight='Regular'):
    f = font(size, weight)
    width = draw.textlength(value, font=f)/SCALE
    text(draw, (x-width/2, y), value, size, color, weight)


def rr(draw, bounds, radius=14, fill='panel', outline='line', width=1):
    draw.rounded_rectangle(box(bounds), radius=round(radius*SCALE), fill=C.get(fill, fill),
                           outline=C.get(outline, outline) if outline else None, width=round(width*SCALE))


def line(draw, coords, fill='line', width=1):
    draw.line([point(v) for v in coords], fill=C.get(fill, fill), width=round(width*SCALE), joint='curve')


def cubic(a, b, c, d, t):
    u=1-t
    return (u*u*u*a[0]+3*u*u*t*b[0]+3*u*t*t*c[0]+t*t*t*d[0],
            u*u*u*a[1]+3*u*u*t*b[1]+3*u*t*t*c[1]+t*t*t*d[1])


def curve(draw, points, color='muted', width=1.5, fraction=1):
    count=max(2, round(70*fraction))
    pts=[cubic(*points, fraction*i/count) for i in range(count+1)]
    line(draw, pts, color, width)


def logo(draw, x, y, size=40):
    def tr(p): return (x+p[0]*size/64, y+p[1]*size/64)
    for mirror in (False, True):
        def m(p): return (64-p[0], p[1]) if mirror else p
        a,b,c,d=map(m, [(28,17),(21,11),(12,7),(4,7)])
        pts=[cubic(a,b,c,d,i/25) for i in range(26)]
        a,b,c,d=map(m, [(4,7),(4,22),(9,35),(23,44)])
        pts += [cubic(a,b,c,d,i/25) for i in range(26)]
        draw.polygon([point(tr(p)) for p in pts], fill=C['wing'])
    draw.polygon([point(tr(p)) for p in [(24,49),(32,32),(40,49),(32,57)]], fill=C['accent'])
    draw.ellipse(box((x+29*size/64,y+9*size/64,x+35*size/64,y+15*size/64)), fill=C['accent'])


def ease(t):
    t=max(0,min(1,t)); return 1-(1-t)**3


def fade_layer(base, layer, alpha=1, dy=0):
    if alpha<=0: return
    if alpha<1: layer.putalpha(layer.getchannel('A').point(lambda a: round(a*alpha)))
    base.alpha_composite(layer, (0, round(dy*SCALE)))


@lru_cache(maxsize=12)
def cached_panel(bounds, title, badge=None):
    layer=Image.new('RGBA',(W*SCALE,H*SCALE))
    shadow=Image.new('RGBA', layer.size)
    d=ImageDraw.Draw(shadow)
    x,y,r,b=bounds
    d.rounded_rectangle(box((x,y+7,r,b+7)), radius=16*SCALE, fill=(35,40,61,18))
    layer.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(12*SCALE)))
    d=ImageDraw.Draw(layer)
    rr(d,bounds,16)
    text(d,(x+18,y+18),title,16,weight='Semibold')
    text(d,(r-27,y+16),'−',18,'muted')
    if badge:
        rr(d,(x+108,y+14,x+133,y+39),8,'soft',None)
        center(d,x+120,y+19,str(badge),13,'accent','Semibold')
    line(d,[(x,y+54),(r,y+54)])
    return layer


def panel(bounds, title, badge=None):
    return cached_panel(bounds, title, badge).copy()


@lru_cache(maxsize=12)
def cached_node(x, y, title, kind, selected):
    layer=Image.new('RGBA',(W*SCALE,H*SCALE))
    shadow=Image.new('RGBA',layer.size);d=ImageDraw.Draw(shadow)
    d.rounded_rectangle(box((x,y+5,x+222,y+110)), radius=15*SCALE, fill=(35,40,61,14))
    layer.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(8*SCALE)))
    d=ImageDraw.Draw(layer)
    rr(d,(x,y,x+222,y+105),15,'soft' if selected else 'panel','accent' if selected else 'line',1.5 if selected else 1)
    # Same compact kind / title / status hierarchy as the product's canvas cards.
    d.polygon([point(p) for p in [(x+18,y+17),(x+23,y+22),(x+18,y+27),(x+13,y+22)]], fill=C['wing'])
    text(d,(x+32,y+17),kind.upper(),10,'muted','Medium')
    text(d,(x+15,y+43),title,16,weight='Semibold')
    line(d,[(x+15,y+73),(x+207,y+73)])
    return layer


def node(base, t, x, y, title, kind='Helper agent', status='Working', selected=False, alpha=1):
    layer=cached_node(x,y,title,kind,selected).copy()
    d=ImageDraw.Draw(layer)
    if status=='Working':
        d.arc(box((x+16,y+85,x+25,y+94)), t*210%360, t*210%360+265, fill=C['accent'],width=2*SCALE)
        shade='muted'
    else:
        shade='attention' if status=='Needs permission' else 'success'
        d.ellipse(box((x+17,y+87,x+24,y+94)),fill=C[shade])
    text(d,(x+34,y+84),status,12,shade)
    fade_layer(base,layer,alpha,dy=8*(1-alpha))


@lru_cache(maxsize=1)
def background():
    im=Image.new('RGBA',(W*SCALE,H*SCALE),C['bg'])
    d=ImageDraw.Draw(im)
    for y in range(20,H,25):
        for x in range(20,W,25):
            d.ellipse(box((x,y,x+1,y+1)),fill='#dddbe6')
    return im


def caption(im, title, description, number):
    d=ImageDraw.Draw(im)
    text(d,(46,25),title,26,weight='Semibold')
    text(d,(47,62),description,14,'muted')
    for i in range(5):
        rr(d,(1116+i*24,39,1132+i*24,42),2,'accent' if i==number else 'line',None)


def workspace(t):
    im=background().copy();d=ImageDraw.Draw(im)
    if t<7: heading=('Parallel work, in view.','Follow tasks and helper agents on one canvas.',0)
    elif t<11: heading=('Attention, on your terms.','Review a permission request. Keep control of the next step.',1)
    elif t<15: heading=('From conversation to code.','Read the transcript, then inspect the changes.',2)
    elif t<18: heading=('Evidence tied to the change.','Keep test results connected to the captured revision.',3)
    else: heading=('Detail, when you need it.','Open model, effort and usage details without crowding the canvas.',4)
    caption(im,*heading)
    # Product window, with its quiet light theme and floating panels.
    rr(d,(34,96,1246,670),22,'panel','line')
    rr(d,(35,147,1245,669),0,'bg',None)
    for x,color in [(56,'#e8aea5'),(72,'#e9d39d'),(88,'#b5cbb6')]:
        d.ellipse(box((x,115,x+8,123)),fill=color)
    logo(d,111,105,33);text(d,(151,111),'lascoria',24,weight='Semibold')
    line(d,[(265,110),(265,132)])
    text(d,(282,118),'SPATIAL CODING',10,'muted','Medium')
    text(d,(1040,117),'Muse account',11,'muted')
    text(d,(1197,109),'···',22,'ink','Semibold')
    line(d,[(34,147),(1246,147)])
    text(d,(59,169),'Release dashboard',19,weight='Semibold')
    rr(d,(923,164,1208,202),12,'panel','line')
    text(d,(940,177),'CANVAS  ·  78%',10,'muted','Medium');text(d,(1122,175),'Tools',12,'muted')
    # The small Sessions window is independent of the full-width map.
    sessions=panel((57,220,256,407),'Sessions')
    ds=ImageDraw.Draw(sessions)
    rr(ds,(68,286,245,345),10,'soft',None)
    text(ds,(81,297),'Release dashboard',13,'ink','Semibold')
    text(ds,(81,320),'Working' if t<17 else 'Ready for review',11,'accent')
    text(ds,(81,365),'Design review',13,weight='Medium')
    text(ds,(81,384),'Idle',11,'muted')
    im.alpha_composite(sessions)
    # The curved parent/child connections appear with the delegated tasks.
    root=(594,240); children=[(318,435),(582,465),(846,414)]
    for i,(x,y) in enumerate(children):
        q=ease((t-(3.7+i*.35))/.9)
        if q>0:
            points=((root[0]+111,root[1]+105),(root[0]+111,382),(x+111,360),(x+111,y))
            dc=ImageDraw.Draw(im);curve(dc,points,'#a7a2bd',1.5,q)
            if q>.98 and t<15:
                p=cubic(*points,((t*.22+i*.25)%1))
                dc.ellipse(box((p[0]-3,p[1]-3,p[0]+3,p[1]+3)),fill=C['wing'])
    node(im,t,*root,'Build a release dashboard','Task','Working' if t<17 else 'Completed')
    titles=['API implementation','Interface','Review & tests']
    for i,(x,y) in enumerate(children):
        a=ease((t-(3.6+i*.35))/.7)
        stat='Working'
        if i==2 and 7<=t<9.6: stat='Needs permission'
        if (i==0 and t>11) or (i==1 and t>12) or (i==2 and t>16): stat='Completed'
        node(im,t,x,y,titles[i],status=stat,selected=(i==0 and t>=11),alpha=a)
    # Attention is a floating, collapsible surface; permission is explicit.
    attention=panel((57,431,282,622 if 7<=t<10.5 else 485),'Attention',1 if 7<=t<9.6 else None)
    da=ImageDraw.Draw(attention)
    if 7<=t<10.5:
        text(da,(75,501),'Permission decision',13,weight='Semibold')
        text(da,(75,526),'Run project tests',13,'muted')
        rr(da,(73,551,266,578),7,'raised',None)
        text(da,(82,558),'npm test',12,'ink',mono=True)
        approved=t>=9.6
        rr(da,(74,590,266,612),7,'success' if approved else 'accent',None)
        center(da,170,594,'Allowed once' if approved else 'Allow once',12,'#ffffff','Semibold')
    im.alpha_composite(attention)
    # Inspector overlays the scene; the constellation remains a full canvas.
    if t>=11:
        a=ease((t-11)/.65)
        inspector=panel((887,224,1213,624),'API implementation')
        di=ImageDraw.Draw(inspector)
        active='Transcript' if t<13 else 'Diff' if t<15 else 'Evidence' if t<18 else 'Details'
        tabs=['Transcript','Diff','Evidence'] if t<18 else ['Model & effort','Token use']
        offsets=[906,1010,1081] if t<18 else [906,1076]
        for tab,x in zip(tabs,offsets):
            text(di,(x,296),tab,12,'accent' if tab==active or (t>=18 and tab=='Token use') else 'muted','Medium')
        underline=(offsets[tabs.index(active)],offsets[tabs.index(active)]+(72 if active=='Transcript' else 47)) if active in tabs else (1076,1145)
        line(di,[(902,322),(1198,322)])
        line(di,[(underline[0],321),(underline[1],321)],'accent',2)
        if active=='Transcript':
            text(di,(905,344),'Muse',13,weight='Semibold')
            for k,v in enumerate(['The API route is ready.','I kept the existing response','shape and added validation.']):
                text(di,(905,373+k*23),v,14)
            rr(di,(903,465,1196,549),9,'raised',None)
            text(di,(916,480),'Tool · run tests',11,'muted','Medium')
            text(di,(916,507),'npm test',14,mono=True)
            text(di,(916,529),'Completed',11,'success')
        elif active=='Diff':
            text(di,(905,344),'src/api/releases.ts',12,'muted',mono=True)
            rr(di,(901,376,1198,548),8,'raised',None)
            code=[('  export function releases()', 'ink'),('  {','ink'),('-   return fetchAll();','error'),('+   return fetchValidated();','success'),('  }','ink')]
            rr(di,(905,465,1194,493),0,'#e6f0e9',None)
            for k,(v,c) in enumerate(code):
                color=C.get(c,'#963e2e')
                text(di,(913,390+k*27),v,12,color,mono=True)
            text(di,(905,573),'Captured revision · current content',11,'success')
        elif active=='Evidence':
            rr(di,(903,345,1197,383),9,'#e6f0e9',None)
            text(di,(916,358),'Captured content is current',12,'success','Medium')
            text(di,(905,407),'Test result',14,weight='Semibold')
            text(di,(905,436),'npm test',13,mono=True)
            text(di,(905,465),'Exit code 0',12,'success')
            line(di,[(905,494),(1195,494)])
            text(di,(905,514),'Bound to this snapshot',12,'muted')
            text(di,(905,542),'Review remains your decision.',12,'ink')
        else:
            for y,label,value in [(348,'Model','Muse Wonder'),(404,'Reasoning effort','Medium'),(460,'Token use','Task · model · session'),(516,'Subscription usage','Separate from task tokens')]:
                text(di,(905,y),label,11,'muted','Medium')
                text(di,(905,y+21),value,14,weight='Medium')
        fade_layer(im,inspector,a,dy=8*(1-a))
    # A small pointer makes the attention action legible, without a distracting cursor trail.
    if 8.4<t<10:
        q=ease((t-8.4)/.8);x=850+(199-850)*q;y=630+(600-630)*q
        dc=ImageDraw.Draw(im)
        dc.polygon([point(p) for p in [(x,y),(x+1,y+20),(x+7,y+15),(x+13,y+25),(x+18,y+22),(x+12,y+13),(x+20,y+12)]],fill='#ffffff',outline=C['ink'],width=1*SCALE)
        if 9.45<t<9.7:
            r=18*(t-9.45)/.25;dc.ellipse(box((199-r,600-r,199+r,600+r)),outline=C['accent'],width=2*SCALE)
    text(ImageDraw.Draw(im),(59,640),'Local workspace  ·  Session context retained',11,'muted')
    return im


def opener(t, closing=False):
    im=background().copy();d=ImageDraw.Draw(im)
    if closing:
        logo(d,592,126,96)
        center(d,640,244,'lascoria',68,weight='Semibold')
        center(d,640,345,'Understand. Steer. Review.',42,weight='Semibold')
        center(d,640,411,'The spatial coding workspace',23,'muted')
        line(d,[(533,485),(747,485)],'line',1)
        center(d,640,514,'Give your agents room to work.',21,'accent','Medium')
    else:
        logo(d,77,105,72);text(d,(160,113),'lascoria',52,weight='Semibold')
        text(d,(81,259),'Give your agents',58,weight='Semibold')
        text(d,(81,329),'room to work.',58,weight='Semibold')
        text(d,(84,438),'The spatial coding workspace',25,'muted')
        # A small constellation motif establishes the spatial idea before the workspace.
        for y,dx in [(210,0),(420,-125),(440,125)]:
            if y!=210:
                curve(d,((977,310),(977,350),(977+dx,355),(977+dx,y)),'#b5b0c9',2)
            rr(d,(866+dx,y,1088+dx,y+100),16,'panel','line')
            text(d,(885+dx,y+20),'Task' if y==210 else 'Helper agent',13,'accent','Medium')
            text(d,(885+dx,y+48),'A clearer view of work' if y==210 else 'Connected context',15,weight='Semibold')
    return im


def frame(t):
    if t<2.7:
        im=opener(t)
        if t>2.3: im=Image.blend(im,workspace(3),ease((t-2.3)/.4))
    elif t>=21.2:
        im=opener(t,True)
        if t<21.8: im=Image.blend(workspace(t),im,ease((t-21.2)/.6))
    else:
        im=workspace(t)
    return im.convert('RGB').resize((W,H),Image.Resampling.LANCZOS)


def main():
    global FONT, MONO
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--font',default=FONT)
    parser.add_argument('--mono-font',default=MONO)
    parser.add_argument('--out',type=Path,default=ROOT/'docs/media')
    parser.add_argument('--frames-only',action='store_true')
    args=parser.parse_args();FONT,MONO=args.font,args.mono_font
    if not FONT or not MONO: parser.error('Supply --font and --mono-font for installed system fonts')
    args.out.mkdir(parents=True,exist_ok=True)
    for name,t in [('opening',1),('parallel',6.5),('attention',8.9),('diff',14),('evidence',16.7),('details',19.5),('closing',23)]:
        if args.frames_only: frame(t).save(args.out/f'{name}.png')
    if args.frames_only: return
    frame(6.5).save(args.out/'lascoria-workspace-poster.webp',format='WEBP',quality=90,method=6)
    output=args.out/'lascoria-workspace.mp4'
    command=['ffmpeg','-hide_banner','-loglevel','error','-y','-f','rawvideo','-pixel_format','rgb24',
             '-video_size',f'{W}x{H}','-framerate',str(FPS),'-i','pipe:0','-an','-c:v','libx264',
             '-preset','medium','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart','-threads','2',
             '-map_metadata','-1','-metadata','title=Lascoria: the spatial coding workspace',str(output)]
    process=subprocess.Popen(command,stdin=subprocess.PIPE)
    try:
        for i in range(FPS*DURATION):
            process.stdin.write(frame(i/FPS).tobytes())
            if i % (FPS*4)==0: print(f'Rendered {i/FPS:.0f}s / {DURATION}s', flush=True)
        process.stdin.close()
        if process.wait()!=0: raise RuntimeError('ffmpeg did not complete')
    except BaseException:
        process.kill();process.wait();raise
    print(f'{output}: {output.stat().st_size} bytes, {DURATION}s, {W}x{H}, {FPS}fps')


if __name__=='__main__': main()
