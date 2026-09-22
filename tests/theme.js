const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const bootstrap = html.match(/<script id="theme-bootstrap">([\s\S]*?)<\/script>/)[1];
const themeCode = app.slice(app.indexOf('// T-05: preferencia'));
let passed = 0;
function check(condition, label) { assert(condition, label); passed++; console.log('PASS: ' + label); }
function harness(saved, matches, blocked = false) {
  let dark = false;
  const selected = {};
  const callbacks = {};
  const storage = {value: saved};
  const media = {matches, addEventListener: (event, callback) => { callbacks.system = callback; }};
  const context = {localStorage: {getItem: () => {if(blocked)throw Error('blocked');return storage.value;}, setItem: (key,value) => {if(blocked)throw Error('blocked');storage.value=value;}},window:{matchMedia:()=>media},document:{documentElement:{classList:{toggle:(name,on)=>{dark=on;}}},getElementById:id=>({setAttribute:(name,value)=>{selected[id]=value;}}),addEventListener:(name,fn)=>{callbacks.ready=fn;}}};
  vm.createContext(context);vm.runInContext(bootstrap,context);
  return {context, storage, media, selected, callbacks, isDark:()=>dark};
}
for (const [saved,system,expected] of [['dark',false,true],['light',true,false],['system',true,true],['system',false,false],['invalid',true,true],[null,true,true]]) {
  const h=harness(saved,system);check(h.isDark()===expected,'tema inicial '+saved+' / sistema '+system);
}
const h=harness('system',false);vm.runInContext(themeCode,h.context);h.callbacks.ready();
h.media.matches=true;h.callbacks.system();check(h.isDark(),'Sistema acompanha mudanca do SO');
h.context.setTheme('light');h.callbacks.system();check(!h.isDark()&&h.storage.value==='light','Claro ignora mudanca do SO e persiste');
h.context.setTheme('dark');check(h.isDark()&&h.selected['theme-btn-dark']==='true'&&h.selected['theme-btn-light']==='false','Escuro selecionado com aria-pressed');
h.context.setTheme('invalid');check(h.storage.value==='dark','valor invalido ignorado');
const blocked=harness(null,true,true);vm.runInContext(themeCode,blocked.context);blocked.context.setTheme('light');check(!blocked.isDark(),'alternador tolera storage bloqueado');
check(html.indexOf('id="theme-bootstrap"')<html.indexOf('src="https://cdn.tailwindcss.com"'),'tema definido antes dos scripts externos');
const luminance = rgb => rgb.map(c=>{c/=255;return c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;}).reduce((sum,c,i)=>sum+c*[0.2126,0.7152,0.0722][i],0);
const contrast = (a,b) => {const x=luminance(a),y=luminance(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);};
for(const [name,pattern] of [['claro',/:root \{([\s\S]*?)\}/],['escuro',/:root\.dark \{([\s\S]*?)\}/]]) {
  const block=html.match(pattern)[1];const tokens=Object.fromEntries([...block.matchAll(/--([a-z-]+): ([\d ]+);/g)].map(m=>[m[1],m[2].split(' ').map(Number)]));
  for(const [text,bg] of [['ink','surface'],['copy','raised'],['muted','canvas'],['accent','surface']]) {const ratio=contrast(tokens[text],tokens[bg]);check(ratio>=4.5,name+' '+text+'/'+bg+' contraste '+ratio.toFixed(2)+':1');}
}
console.log(passed+'/'+passed+' PASS');
