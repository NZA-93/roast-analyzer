import fs from 'fs'; import jpeg from 'jpeg-js'; import { analyzeImage } from '../docs/js/analyzer.js';
const raw = jpeg.decode(fs.readFileSync(process.argv[2]),{useTArray:true});
const r=analyzeImage(raw,JSON.parse(process.argv[3]||'{}'));const [x0,y0,x1,y1]=process.argv[4].split(',').map(Number);
const inb=r.beans.filter(b=>b.x>=x0&&b.x<x1&&b.y>=y0&&b.y<y1);const bands=[0,0,0,0];inb.forEach(b=>bands[Math.min(3,Math.floor((b.y-y0)/((y1-y0)/4)))]++);
console.log('total',r.beans.length,'inbox',inb.length,bands);
