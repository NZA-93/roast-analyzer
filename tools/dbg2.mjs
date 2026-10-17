import fs from 'fs'; import jpeg from 'jpeg-js'; import {PNG} from 'pngjs';
import { analyzeImage } from '../docs/js/analyzer.js';
const raw = jpeg.decode(fs.readFileSync(process.argv[2]),{useTArray:true});
const r=analyzeImage(raw,{debug:true, ...(process.argv[3]?JSON.parse(process.argv[3]):{})});
const {mask,markers,lab}=r.debug; const w=r.width;
const ar=r.beans.map(b=>b.area).sort((a,b)=>a-b);console.log(ar[0],ar[ar.length>>2],ar[ar.length>>1],ar[ar.length*3>>2],ar[ar.length-1]);console.log(r.params, r.beans.length, r.rejected.reduce((m,q)=>(m[q.reason]=(m[q.reason]||0)+1,m),{}));
const [X0,Y0,W,H]=(process.env.CROP||"500,300,500,400").split(",").map(Number);const png=new PNG({width:W,height:H});
for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=(y+Y0)*w+x+X0,o=4*(y*W+x);const l=lab[i];
 const e=l&&(lab[i-1]!==l||lab[i+1]!==l||lab[i-w]!==l||lab[i+w]!==l);
 png.data[o]=e?255:raw.data[4*i]*(mask[i]?1:0.4);png.data[o+1]=e?0:raw.data[4*i+1]*(mask[i]?1:0.4);png.data[o+2]=e?0:raw.data[4*i+2]*(mask[i]?1:0.4);png.data[o+3]=255;}
const pts=[...r.beans.map(b=>[b.x,b.y,0,255,255]),...r.rejected.map(q=>[q.x,q.y,255,0,255])];
for(const [x,y,R_,G_,B_] of pts.map(p=>[Math.round(p[0]),Math.round(p[1]),p[2],p[3],p[4]])){const xx=x-X0,yy=y-Y0;for(let a=-2;a<=2;a++)for(let b=-2;b<=2;b++){const X=xx+a,Y=yy+b;if(X>=0&&Y>=0&&X<W&&Y<H){const o=4*(Y*W+X);png.data[o]=R_;png.data[o+1]=G_;png.data[o+2]=B_;}}}
fs.writeFileSync(process.argv[4]||'/workspace/ovl/d.png',PNG.sync.write(png));
