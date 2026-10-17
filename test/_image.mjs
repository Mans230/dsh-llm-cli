// A deterministic red PNG for transport/vision tests. No external image assets.
import { deflateSync } from 'node:zlib'
function crc32(data) {
  let crc=0xffffffff
  for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}
  return (crc^0xffffffff)>>>0
}
function chunk(type,data){const name=Buffer.from(type),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([size,name,data,crc])}
export function redPng(){
  const width=32,height=32,header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2
  const pixels=Buffer.alloc((width*3+1)*height)
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)pixels[y*(width*3+1)+1+x*3]=255
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))])
}
