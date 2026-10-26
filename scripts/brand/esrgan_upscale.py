# env SRC/DST: input/output folders under WORK (default g/crops -> up).
# Real-ESRGAN x4plus (RRDBNet) in plain PyTorch, CPU, tiled. Upscales every PNG in $WORK/g/crops to $WORK/up.
# Needs torch + numpy + Pillow and the RealESRGAN_x4plus.pth weights in $WORK/w (xinntao/Real-ESRGAN v0.1.0 release).
import os, sys, torch, torch.nn as nn, torch.nn.functional as F, numpy as np
from PIL import Image
torch.set_num_threads(12)

class RDB(nn.Module):
    def __init__(s, nf=64, gc=32):
        super().__init__()
        s.conv1=nn.Conv2d(nf,gc,3,1,1); s.conv2=nn.Conv2d(nf+gc,gc,3,1,1); s.conv3=nn.Conv2d(nf+2*gc,gc,3,1,1)
        s.conv4=nn.Conv2d(nf+3*gc,gc,3,1,1); s.conv5=nn.Conv2d(nf+4*gc,nf,3,1,1); s.a=nn.LeakyReLU(0.2,True)
    def forward(s,x):
        x1=s.a(s.conv1(x)); x2=s.a(s.conv2(torch.cat((x,x1),1))); x3=s.a(s.conv3(torch.cat((x,x1,x2),1)))
        x4=s.a(s.conv4(torch.cat((x,x1,x2,x3),1))); x5=s.conv5(torch.cat((x,x1,x2,x3,x4),1)); return x5*0.2+x
class RRDB(nn.Module):
    def __init__(s,nf=64,gc=32):
        super().__init__(); s.rdb1=RDB(nf,gc); s.rdb2=RDB(nf,gc); s.rdb3=RDB(nf,gc)
    def forward(s,x): return s.rdb3(s.rdb2(s.rdb1(x)))*0.2+x
class RRDBNet(nn.Module):
    def __init__(s,nf=64,nb=23,gc=32):
        super().__init__()
        s.conv_first=nn.Conv2d(3,nf,3,1,1); s.body=nn.Sequential(*[RRDB(nf,gc) for _ in range(nb)])
        s.conv_body=nn.Conv2d(nf,nf,3,1,1); s.conv_up1=nn.Conv2d(nf,nf,3,1,1); s.conv_up2=nn.Conv2d(nf,nf,3,1,1)
        s.conv_hr=nn.Conv2d(nf,nf,3,1,1); s.conv_last=nn.Conv2d(nf,3,3,1,1); s.a=nn.LeakyReLU(0.2,True)
    def forward(s,x):
        f=s.conv_first(x); f=f+s.conv_body(s.body(f))
        f=s.a(s.conv_up1(F.interpolate(f,scale_factor=2,mode='nearest')))
        f=s.a(s.conv_up2(F.interpolate(f,scale_factor=2,mode='nearest')))
        return s.conv_last(s.a(s.conv_hr(f)))

def load():
    m=RRDBNet(); sd=torch.load(os.path.join(os.environ['WORK'],'w','RealESRGAN_x4plus.pth'),map_location='cpu',weights_only=True)
    m.load_state_dict(sd.get('params_ema',sd.get('params',sd)),strict=True); return m.eval()

@torch.no_grad()
def up4(m,img,tile=96,pad=10):
    a=torch.from_numpy(np.asarray(img.convert('RGB'),dtype=np.float32)/255).permute(2,0,1)[None]
    a=F.pad(a,(pad,pad,pad,pad),mode='reflect'); _,_,H,W=a.shape; out=torch.zeros(1,3,H*4,W*4)
    for y in range(0,H-2*pad,tile):
        for x in range(0,W-2*pad,tile):
            y1,x1=min(y+tile+2*pad,H),min(x+tile+2*pad,W); t=m(a[:,:,y:y1,x:x1])
            h,w=min(tile,H-2*pad-y),min(tile,W-2*pad-x)
            out[:,:,(y+pad)*4:(y+pad+h)*4,(x+pad)*4:(x+pad+w)*4]=t[:,:,pad*4:(pad+h)*4,pad*4:(pad+w)*4]
    o=out[:,:,pad*4:-pad*4,pad*4:-pad*4].clamp(0,1)[0].permute(1,2,0).numpy()
    return Image.fromarray((o*255).round().astype(np.uint8))

if __name__=='__main__':
    import glob, os, time
    m=load()
    for f in sorted(glob.glob(os.path.join(os.environ['WORK'],os.environ.get('SRC','g/crops'),'*.png'))):
        o=os.path.join(os.environ['WORK'],os.environ.get('DST','up'),os.path.basename(f))
        if os.path.exists(o): continue
        t=time.time(); r=up4(m,Image.open(f)); r.save(o); print(o,r.size,round(time.time()-t,1),flush=True)
