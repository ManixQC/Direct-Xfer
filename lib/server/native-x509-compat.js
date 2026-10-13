'use strict';

// Minimal X.509 CA/leaf certificate generation backed by Node's crypto/OpenSSL.
// No ASN.1 signature verification is implemented here: verification is delegated
// to crypto.X509Certificate.verify() (OpenSSL), never to a hand-written parser.
const crypto = require('node:crypto');
const net = require('node:net');

const names = Object.freeze({
  commonName:'2.5.4.3', organizationName:'2.5.4.10', organizationalUnitName:'2.5.4.11',
});
const oids = Object.freeze({
  sha256WithRSAEncryption:'1.2.840.113549.1.1.11',
  sha384WithRSAEncryption:'1.2.840.113549.1.1.12',
  sha512WithRSAEncryption:'1.2.840.113549.1.1.13',
  basicConstraints:'2.5.29.19', keyUsage:'2.5.29.15', extKeyUsage:'2.5.29.37',
  subjectAltName:'2.5.29.17', subjectKeyIdentifier:'2.5.29.14', authorityKeyIdentifier:'2.5.29.35',
  serverAuth:'1.3.6.1.5.5.7.3.1',
});
function len(n) {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffff) throw new Error('Invalid DER length');
  if (n < 128) return Buffer.from([n]);
  const arr=[]; while(n) { arr.unshift(n&255); n=Math.floor(n/256); }
  return Buffer.from([0x80|arr.length,...arr]);
}
function tlv(tag, value) { const b=Buffer.isBuffer(value)?value:Buffer.from(value);return Buffer.concat([Buffer.from([tag]),len(b.length),b]); }
function seq(...args) { return tlv(0x30,Buffer.concat(args)); }
function set(...args) { return tlv(0x31,Buffer.concat(args)); }
function oid(s) {
  const a=String(s).split('.').map(Number);
  if(a.length<2 || a.some(v=>!Number.isSafeInteger(v)||v<0)||a[0]>2||a[1]>39&&a[0]<2)throw Error('Invalid OID');
  const nums=[a[0]*40+a[1],...a.slice(2)]; const bytes=[];
  for(let v of nums){const tmp=[v%128];v=Math.floor(v/128);while(v){tmp.unshift((v%128)|128);v=Math.floor(v/128);}bytes.push(...tmp);}
  return tlv(0x06,bytes);
}
function decodeOid(b) {
  const n=[];let v=0;
  for(const byte of b){v=v*128+(byte&127);if(v>Number.MAX_SAFE_INTEGER)throw Error('OID too large');if(!(byte&128)){n.push(v);v=0;}}
  if(v!==0||!n.length)throw Error('Invalid OID');
  const first=n.shift();const a=first<40?0:first<80?1:2;return [a,first-40*a,...n].join('.');
}
function integer(b) {let v=Buffer.isBuffer(b)?b:Buffer.from([b]);if(v[0]&128)v=Buffer.concat([Buffer.from([0]),v]);return tlv(0x02,v);}
function time(d) {
  if(!(d instanceof Date)||!Number.isFinite(d.getTime()))throw Error('Invalid certificate date');
  const y=d.getUTCFullYear();const fmt=(n)=>String(n).padStart(2,'0');
  const value=(y<2050&&y>=1950?fmt(y%100):String(y))+fmt(d.getUTCMonth()+1)+fmt(d.getUTCDate())+fmt(d.getUTCHours())+fmt(d.getUTCMinutes())+fmt(d.getUTCSeconds())+'Z';
  return tlv(y<2050&&y>=1950?0x17:0x18,Buffer.from(value,'ascii'));
}
function dn(attrs) {return seq(...attrs.map(a=>set(seq(oid(a.type||names[a.name]),tlv(0x0c,Buffer.from(String(a.value),'utf8'))))));}
function extension(id,body,critical=false){return seq(oid(oids[id]),...(critical?[tlv(0x01,[0xff])]:[]),tlv(0x04,body));}
function ipBytes(ip){
  if(net.isIP(ip)===4)return Buffer.from(ip.split('.').map(Number));
  if(net.isIP(ip)!==6)throw Error('Invalid certificate IP');
  let s=ip.toLowerCase().split('%')[0];
  if(s.includes('.')){const i=s.lastIndexOf(':');const b=ipBytes(s.slice(i+1));s=s.slice(0,i+1)+b.readUInt16BE(0).toString(16)+':'+b.readUInt16BE(2).toString(16);}
  const parts=s.split('::');if(parts.length>2)throw Error('Invalid IPv6');
  const left=parts[0]?parts[0].split(':'):[],right=parts[1]?parts[1].split(':'):[];
  const missing=8-left.length-right.length;if(missing<0||parts.length===1&&missing!==0||parts.length===2&&missing<1)throw Error('Invalid IPv6');
  const list=[...left,...Array(missing).fill('0'),...right]; const result=Buffer.alloc(16);
  list.forEach((v,i)=>result.writeUInt16BE(parseInt(v,16),i*2));return result;
}
function formatIp(b){
  if(b.length===4)return Array.from(b).join('.');
  if(b.length!==16)throw Error('Invalid SAN IP');
  const w=Array.from({length:8},(_,i)=>b.readUInt16BE(i*2));
  if(w.slice(0,5).every(v=>v===0)&&w[5]===0xffff)return `::ffff:${[...b.slice(12)].join('.')}`;
  // URL canonicalizes zero-compression, preserving a stable identity comparison.
  const v=w.map(x=>x.toString(16)).join(':');return new URL(`http://[${v}]/`).hostname.slice(1,-1);
}
function subKeyId(publicKey){const spki=(publicKey.type==='public'?publicKey:crypto.createPublicKey(publicKey)).export({type:'spki',format:'der'});const elements=derChildren(spki,read(spki,0));const bits=spki.subarray(elements[1].start+1,elements[1].end);return crypto.createHash('sha1').update(bits).digest();}
function extDer(item, publicKey) {
  const n=item.name;
  if(n==='basicConstraints')return extension(n,seq(...(item.cA?[tlv(0x01,[0xff])]:[]),...(item.pathLenConstraint!==undefined?[integer(item.pathLenConstraint)]:[])),item.critical);
  if(n==='keyUsage')return extension(n,tlv(0x03,[0,(item.digitalSignature?0x80:0) | (item.keyEncipherment?0x20:0) | (item.keyCertSign?0x04:0) | (item.cRLSign?0x02:0)]),item.critical);
  if(n==='extKeyUsage')return extension(n,seq(...(item.serverAuth?[oid(oids.serverAuth)]:[])),item.critical);
  if(n==='subjectAltName')return extension(n,seq(...(item.altNames||[]).map(a=>a.type===2?tlv(0x82,Buffer.from(String(a.value),'ascii')):a.type===7?tlv(0x87,ipBytes(a.ip||a.value)):(()=>{throw Error('Unsupported SAN kind');})())),item.critical);
  if(n==='subjectKeyIdentifier')return extension(n,tlv(0x04,subKeyId(publicKey)),item.critical);
  if(n==='authorityKeyIdentifier')return extension(n,seq(tlv(0x80,Buffer.from(item.keyIdentifier,'binary'))),item.critical);
  throw Error('Unsupported X.509 extension: '+n);
}
function read(buf,offset) {
  if(!Buffer.isBuffer(buf)||offset>=buf.length||offset<0)throw Error('Invalid DER offset');
  const tag=buf[offset];let pos=offset+1;if(pos>=buf.length)throw Error('Truncated DER');const first=buf[pos++];
  let size=first;if(first&128){const count=first&127;if(!count||count>3||pos+count>buf.length)throw Error('Invalid DER length');size=0;for(let i=0;i<count;i++)size=size*256+buf[pos++];if(size<128)throw Error('Non-canonical DER length');}
  if(pos+size>buf.length)throw Error('Truncated DER content');return {tag,start:pos,end:pos+size,next:pos+size};
}
function children(entry,buf) { // supplied as children(entry, data)
  if(!buf)throw Error('Missing DER input');
  const out=[];for(let at=entry.start;at<entry.end;){const t=read(buf,at);out.push(t);at=t.next;}return out;
}
function derChildren(buf,entry){return children(entry,buf);}
function decodeInt(b){return parseInt(b.toString('hex')||'0',16);}
function decodeDn(buf,entry){
  if(entry.tag!==0x30)throw Error('Invalid X.509 distinguished name');
  const attributes=[];
  for(const rdn of derChildren(buf,entry)){
    if(rdn.tag!==0x31)throw Error('Invalid X.509 RDN');
    // An RDN is a SET of one or more attributes. Old certificates and external
    // CAs may use multi-valued RDNs (CN+OU). Dropping all but its first element
    // silently changes the issuer of newly signed leaf certificates.
    for(const item of derChildren(buf,rdn)){
      if(item.tag!==0x30)throw Error('Invalid X.509 name attribute');
      const a=derChildren(buf,item);
      if(a.length!==2||a[0].tag!==0x06)throw Error('Invalid X.509 name attribute');
      const type=decodeOid(buf.subarray(a[0].start,a[0].end));
      const value=buf.subarray(a[1].start,a[1].end).toString(a[1].tag===0x0c?'utf8':'latin1');
      attributes.push({type,value});
    }
  }
  // Keep the DER encoding, not just a reconstructed text representation.
  // X.509 name matching also depends on RDN grouping and ASN.1 string tags,
  // which can differ between OpenSSL and older versions of node-forge.
  return {attributes,raw:tlv(0x30,buf.subarray(entry.start,entry.end))};
}
function rsaWrap(k){
  const p=k.type==='public'?k:crypto.createPublicKey(k);const pub=p.export({format:'jwk'});
  const bn=(raw)=>{const value=Buffer.from(raw,'base64url');return {bitLength:()=>{let i=0;while(i<value.length&&value[i]===0)i++;if(i===value.length)return 0;return (value.length-i-1)*8+(32-Math.clz32(value[i]));},compareTo:(other)=>Buffer.compare(value,other._bytes),_bytes:value};};
  return {key:k,n:bn(pub.n),e:bn(pub.e)};
}
function fromPem(input){return rsaWrap(crypto.createPrivateKey(input));}
function publicFromPem(input){return rsaWrap(crypto.createPublicKey(input));}
function certificateFromPem(pem){
  const x=new crypto.X509Certificate(pem);const b=x.raw;const top=read(b,0);const outer=derChildren(b,top);const tbs=derChildren(b,outer[0]);
  let i=tbs[0].tag===0xa0?1:0;const serial=tbs[i++];const sig=tbs[i++];const issuer=tbs[i++];const validity=tbs[i++];const subject=tbs[i++];const spki=tbs[i++];
  const sigOid=derChildren(b,sig)[0];const extensions={};
  for(const ext of tbs.slice(i))if(ext.tag===0xa3){for(const item of derChildren(b,derChildren(b,ext)[0])){
    const parts=derChildren(b,item);const id=decodeOid(b.subarray(parts[0].start,parts[0].end));const data=parts[parts.length-1];if(data.tag!==0x04)throw Error('Invalid X.509 extension');
    const value=b.subarray(data.start,data.end);extensions[id]=value;
  }}
  const getExtension=(name)=>{
    const v=extensions[oids[name]];if(!v)return undefined;
    const a=read(v,0), kids=a.tag===0x30?derChildren(v,a):[];
    if(name==='basicConstraints')return {cA:kids.some(k=>k.tag===0x01&&v[k.start]!==0),...Object.fromEntries(kids.filter(k=>k.tag===0x02).map(k=>['pathLenConstraint',decodeInt(v.subarray(k.start,k.end))]))};
    if(name==='keyUsage'){const mask=v[a.start+1]||0;return {digitalSignature:!!(mask&0x80),keyEncipherment:!!(mask&0x20),keyCertSign:!!(mask&0x04),cRLSign:!!(mask&0x02)};}
    if(name==='extKeyUsage')return {serverAuth:kids.some(k=>k.tag===0x06&&decodeOid(v.subarray(k.start,k.end))===oids.serverAuth)};
    if(name==='subjectAltName')return {altNames:kids.map(k=>k.tag===0x82?{type:2,value:v.subarray(k.start,k.end).toString('ascii')}:k.tag===0x87?{type:7,ip:formatIp(v.subarray(k.start,k.end))}:null).filter(Boolean)};
    return {name};
  };
  return { x509:x, pem:typeof pem==='string'?pem:Buffer.from(pem).toString('utf8'), signatureOid:decodeOid(b.subarray(sigOid.start,sigOid.end)),
    validity:{notBefore:new Date(x.validFrom),notAfter:new Date(x.validTo)},
    publicKey:rsaWrap(x.publicKey),subject:decodeDn(b,subject),issuer:decodeDn(b,issuer),
    serialNumber:b.subarray(serial.start,serial.end).toString('hex').replace(/^00/,''),
    getExtension,
    verify:(child)=>!!child?.x509?.verify(x.publicKey),
    generateSubjectKeyIdentifier:()=>({getBytes:()=>subKeyId(x.publicKey).toString('binary')}),
  };
}
function createCertificate(){
  const cert={validity:{notBefore:null,notAfter:null},publicKey:null,serialNumber:null,subject:null,issuer:null,extensions:[],
    setSubject(v){this.subject={attributes:v.map(x=>({type:x.type||names[x.name],value:x.value}))};},
    setIssuer(v){
      const attrs=Array.isArray(v)?v:v&&v.attributes;
      if(!Array.isArray(attrs))throw Error('Invalid X.509 issuer');
      this.issuer={attributes:attrs.map(x=>({type:x.type||names[x.name],value:x.value})),raw:!Array.isArray(v)&&Buffer.isBuffer(v.raw)?Buffer.from(v.raw):null};
    },
    setExtensions(v){this.extensions=v;},
    sign(key){
      if(!this.publicKey||!this.subject||!this.issuer||!this.serialNumber)throw Error('Incomplete certificate');
      const priv=key.key||key;const signAlg=seq(oid(oids.sha256WithRSAEncryption),tlv(0x05,[]));
      const pk=this.publicKey.key||this.publicKey;const spki=(pk.type==='public'?pk:crypto.createPublicKey(pk)).export({format:'der',type:'spki'});
      const serial=integer(Buffer.from(this.serialNumber,'hex'));
      const tbs=seq(tlv(0xa0,integer(2)),serial,signAlg,(this.issuer.raw||dn(this.issuer.attributes)),seq(time(this.validity.notBefore),time(this.validity.notAfter)),dn(this.subject.attributes),spki,tlv(0xa3,seq(...this.extensions.map(x=>extDer(x,this.publicKey.key||this.publicKey)))));
      const signature=crypto.sign('sha256',tbs,{key:priv,padding:crypto.constants.RSA_PKCS1_PADDING});
      const der=seq(tbs,signAlg,tlv(0x03,Buffer.concat([Buffer.from([0]),signature])));
      const base64=der.toString('base64');const pem='-----BEGIN CERTIFICATE-----\n'+base64.match(/.{1,64}/g).join('\n')+'\n-----END CERTIFICATE-----\n';
      Object.assign(this,certificateFromPem(pem));
    },
  };
  return cert;
}
module.exports=Object.freeze({
  pki:Object.freeze({oids,createCertificate,certificateFromPem,certificateToPem:(c)=>c.pem,privateKeyFromPem:fromPem,publicKeyFromPem:publicFromPem}),
  md:Object.freeze({sha256:Object.freeze({create:()=>({})})}),
});
