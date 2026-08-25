'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const skip = new Set(['node_modules','.git','dist','build']);
const patterns = {
  crypto:/\b(?:createCipheriv|createDecipheriv|createHmac|createHash|scrypt|randomBytes|generateKeyPair|createPrivateKey|createPublicKey)\b/,
  process:/\b(?:spawn|execFile|fork)\s*\(/,
  outbound:/\b(?:fetch|https?\.request|https?\.get|nodemailer|webpush)\b/,
  filesystem:/\b(?:writeFile|appendFile|unlink|rm|rename|copyFile|createWriteStream)\b/,
};
const files=[];
function walk(dir){
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    if(skip.has(entry.name)) continue;
    const abs=path.join(dir,entry.name);
    if(entry.isDirectory()) walk(abs);
    else if(/\.(?:js|mjs|cjs)$/.test(entry.name)) files.push(abs);
  }
}
walk(root);
const out={generatedAt:new Date().toISOString(), version:require('../package.json').version, categories:{}};
for(const [name,re] of Object.entries(patterns)){
  out.categories[name]=[];
  for(const abs of files){
    const lines=fs.readFileSync(abs,'utf8').split(/\r?\n/);
    lines.forEach((line,i)=>{if(re.test(line)) out.categories[name].push({file:path.relative(root,abs).replace(/\\/g,'/'),line:i+1,text:line.trim().slice(0,240)});});
  }
}
const target=path.join(root,'security','security-inventory.json');
fs.writeFileSync(target,JSON.stringify(out,null,2)+'\n');
console.log(`Wrote ${path.relative(root,target)} (${Object.values(out.categories).reduce((n,a)=>n+a.length,0)} findings)`);
