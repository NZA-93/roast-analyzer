import fs from 'fs'; import jpeg from 'jpeg-js'; import {PNG} from 'pngjs';
import { linToLab } from '/workspace/roast-analyzer/docs/js/analyzer.js';
const raw = jpeg.decode(fs.readFileSync(process.argv[2]),{useTArray:true});
const w=raw.width,h=raw.height; const png=new PNG({width:500,height:400});
const s2l=c=>{c/=255;return c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4};
const g=[1.19,1.268,1.401];
for(let y=0;y<400;y++)for(let x=0;x<500;x++){const i=(y+300)*w+x+500;const lab=linToLab(s2l(raw.data[4*i])*g[0],s2l(raw.data[4*i+1])*g[1],s2l(raw.data[4*i+2])*g[2]);
const o=4*(y*500+x);const v=Math.max(0,Math.min(255,lab[0]*2.55));png.data[o]=v;png.data[o+1]=Math.min(255,Math.hypot(lab[1],lab[2])*6);png.data[o+2]=0;png.data[o+3]=255;}
fs.writeFileSync('/workspace/ovl/lab.png',PNG.sync.write(png));
