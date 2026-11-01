import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadExtensions } from '/home/sbtzk/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';
import { UserMessageComponent } from '/home/sbtzk/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/dist/index.js';

const { initTheme } = await import('/home/sbtzk/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js');
initTheme('dark', false);
const path = fileURLToPath(new URL('./index.ts', import.meta.url));
const loaded = await loadExtensions([path], '/home/sbtzk');
assert.deepEqual(loaded.errors, []);
const extension = loaded.extensions[0];
const command = extension.commands.get('message-edit');
let branch = [];
let idle = true;
let pending = false;
let draft = '';
let answers = [];
let confirms = [];
let forks = [];
let dispatched = [];
let notices = [];
const entry = (id, text, image = false) => ({type:'message', id, timestamp:id, message:{role:'user', content:[{type:'text',text}, ...(image ? [{type:'image',data:'',mimeType:'image/png'}] : [])]}});
const ctx = {
  mode:'tui', hasUI:true,
  isIdle:()=>idle, hasPendingMessages:()=>pending,
  sessionManager:{getBranch:()=>branch},
  ui:{
    notify:(...args)=>notices.push(args),
    getEditorText:()=>draft,
    select:async (_title,options)=>{const value=answers.shift(); return typeof value==='number' ? options[value] : value;},
    confirm:async ()=>confirms.shift() ?? false,
  },
  fork:async (id,options)=>{forks.push([id,options]); return {cancelled:false};},
};
loaded.runtime.sendUserMessage = (text,options)=>dispatched.push([text,options]);
const start = async () => {for (const handler of extension.handlers.get('session_start')) await handler({},ctx);};
const stop = async () => {for (const handler of extension.handlers.get('session_shutdown')) await handler({},ctx);};
const reset = () => {branch=[entry('a','中文 message')]; idle=true; pending=false; draft=''; answers=[]; confirms=[]; forks=[]; dispatched=[]; notices=[];};
const prototype = UserMessageComponent.prototype;
const before = prototype.handleMouse;
await start();
const component = new UserMessageComponent('中文 message');
const click = {type:'press',button:'right',x:1,y:1,screenX:1,screenY:1,width:80,height:3,shift:false,alt:false,ctrl:false};
reset();
component.render(40);
assert.equal(component.handleMouse(click).handled,true);
assert.deepEqual(dispatched,[['/message-edit clicked',{expandPromptTemplates:true}]]);
answers=[0];
await command.handler('clicked',ctx);
assert.deepEqual(forks,[['a',{position:'before'}]]);

reset(); component.handleMouse(click); answers=[1];
await command.handler('clicked',ctx); assert.equal(forks.length,0);
reset(); draft='unsent'; component.handleMouse(click); answers=[0];
await command.handler('clicked',ctx); assert.equal(forks.length,0); assert.equal(draft,'unsent');
reset(); draft='unsent'; component.handleMouse(click); answers=[0]; confirms=[true];
await command.handler('clicked',ctx); assert.equal(forks.length,1);
reset(); idle=false; component.handleMouse(click); assert.equal(dispatched.length,0);
reset(); pending=true; component.handleMouse(click); assert.equal(dispatched.length,0);
reset(); branch.push(entry('b','中文 message')); component.handleMouse(click); answers=[1,0];
await command.handler('clicked',ctx); assert.equal(forks[0][0],'b');
reset(); branch=[entry('img','中文 message',true)]; component.handleMouse(click); answers=[0];
await command.handler('clicked',ctx); assert.equal(forks.length,0);
reset(); branch=[entry('img','中文 message',true)]; component.handleMouse(click); answers=[0]; confirms=[true];
await command.handler('clicked',ctx); assert.equal(forks.length,1);
reset(); const unknown = new UserMessageComponent('unmapped'); unknown.handleMouse(click);
assert.equal(dispatched.length,0); assert.match(notices[0][0],/无法可靠定位/);
reset(); answers=[0,0]; await command.handler('',ctx); assert.equal(forks[0][0],'a');
reset(); await command.handler('clicked',ctx); assert.equal(forks.length,0);
reset(); assert.equal(component.handleMouse({...click,button:'left'}),undefined); assert.equal(dispatched.length,0);
await stop(); assert.equal(prototype.handleMouse,before);
await start(); await stop(); assert.equal(prototype.handleMouse,before);
process.stdout.write('PASS: real Pi extension loader + message component; right click, native-fork API args, cancel, draft, busy/pending, duplicate text, images, fallback, keyboard command, cleanup/reload (15 cases).\n');
