import fs from 'fs'; import jpeg from 'jpeg-js'; import {PNG} from 'pngjs';
import { analyzeImage, edt } from '../docs/js/analyzer.js';
const raw = jpeg.decode(fs.readFileSync(process.argv[2]),{useTArray:true});
const r=analyzeImage(raw,{debug:true});const {mask}=r.debug;const w=r.width,h=r.height;const d=edt(mask,w,h);
const X0=500,Y0=300,W=500,H=400;const png=new PNG({width:W,height:H});
for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=(y+Y0)*w+x+X0,o=4*(y*W+x);png.data[o]=mask[i]*120;png.data[o+1]=Math.min(255,d[i]*12);png.data[o+2]=0;png.data[o+3]=255;}
fs.writeFileSync('/workspace/ovl/m.png',PNG.sync.write(png));
