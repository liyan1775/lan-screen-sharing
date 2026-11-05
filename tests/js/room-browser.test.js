import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomBrowser, formatDiscoveryDiagnostics } from '../../internal/web/assets/room-browser.js';
import { RoomClient } from '../../internal/web/assets/client.js';

class Element {
  children=[];listeners=new Map();textContent='';disabled=false;attrs={};dataset={};
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this.children=items;}
  addEventListener(type,fn){this.listeners.set(type,fn);}
  setAttribute(key,value){this.attrs[key]=value;}
  async click(){return this.listeners.get('click')?.();}
}
const room=(name,extra={})=>({id:name,name,members:1,capacity:3,hostIPv4:'192.168.1.20',hostPort:45678,roomCode:'ABCD2345',...extra});
function fixture(rooms){const list=new Element(),status=new Element(),refreshButton=new Element(),joined=[];let timer;const browser=createRoomBrowser({list,status,refreshButton,documentRef:{createElement:()=>new Element()},load:async()=>({available:true,rooms}),onJoin:async r=>joined.push(r),setIntervalImpl:fn=>{timer=fn;return 1;},clearIntervalImpl:()=>{timer=null;}});return {browser,list,status,refreshButton,joined,get timer(){return timer;}};}
test('a discovered room can be joined with one button and without exposing its room code in the card',async()=>{
 const f=fixture([room('<img src=x>')]);await f.browser.refresh();
 const card=f.list.children[0];assert.equal(card.children[0].textContent,'<img src=x>');
 const button=card.children.at(-1);await button.click();assert.equal(f.joined[0].roomCode,'ABCD2345');
 assert.ok(!card.children.some(el=>el.textContent.includes('ABCD2345')));
});
test('full rooms and my own rooms cannot be joined, and disappeared rooms are removed on refresh',async()=>{
 const rooms=[room('full',{members:3}),room('mine',{own:true})];const f=fixture(rooms);await f.browser.refresh();
 assert.ok(f.list.children.every(card=>card.children.at(-1).disabled));
 await f.list.children[0].children.at(-1).click();assert.equal(f.joined.length,0);
 rooms.splice(0);await f.browser.refresh();assert.equal(f.list.children.length,0);assert.match(f.status.textContent,/还没有/);
});
test('automatic refresh is bounded by one in-flight request and stop clears the timer',async()=>{
 const f=fixture([]);f.browser.start();await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof f.timer,'function');f.browser.stop();assert.equal(f.timer,null);
});

test('hidden room lists stop polling and resume immediately without duplicating timers', async () => {
  let loads = 0, nextId = 0;
  const timers = new Map();
  const browser = createRoomBrowser({
    list: new Element(), status: new Element(), refreshButton: new Element(),
    documentRef: { createElement: () => new Element() }, onJoin: async () => {},
    load: async () => { loads++; return { available: true, rooms: [] }; },
    setIntervalImpl: fn => { const id = nextId++; timers.set(id, fn); return id; }, clearIntervalImpl: id => timers.delete(id),
  });
  browser.setActive(false); browser.start(); await Promise.resolve();
  assert.equal(loads, 0); assert.equal(timers.size, 0);
  browser.setActive(true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(loads, 1); assert.equal(timers.size, 1);
  browser.setActive(true); browser.start(); assert.equal(timers.size, 1);
  browser.setActive(false); await browser.refresh();
  assert.equal(loads, 1); assert.equal(timers.size, 0);
  browser.setActive(true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(loads, 2); assert.equal(timers.size, 1);
  browser.stop(); browser.setActive(false); browser.setActive(true); browser.start();
  assert.equal(timers.size, 0);
});

test('unchanged rooms reuse seat and icon nodes while joining uses the latest invitation', async () => {
  const rooms = [room('friends')];
  const f = fixture(rooms);
  await f.browser.refresh();
  const card = f.list.children[0], seats = card.children[1].children[1], mark = card.children[2].children[0];
  rooms[0] = { ...rooms[0], roomCode: 'WXYZ6789' };
  await f.browser.refresh();
  assert.equal(f.list.children[0], card);
  assert.equal(card.children[1].children[1], seats);
  assert.equal(card.children[2].children[0], mark);
  await card.children.at(-1).click();
  assert.equal(f.joined[0].roomCode, 'WXYZ6789');
  assert.equal(card.children.at(-1).textContent, '加入房间');
  rooms[0].members = 3; rooms[0].screenSharing = true;
  await f.browser.refresh();
  assert.equal(card.children[1].children[0].textContent, '3 / 3 人');
  assert.equal(card.children[2].children[1].textContent, '正在共享画面');
  assert.ok(card.children.at(-1).disabled);
  assert.equal(card.children[1].children[1], seats);
});

test('room list uses the same-origin protected endpoint and keeps its nonce out of the URL',async(t)=>{
 const previous=globalThis.location;globalThis.location={href:'http://localhost:59818/'};t.after(()=>{if(previous===undefined)delete globalThis.location;else globalThis.location=previous;});
 let called;
 const client=new RoomClient({fetchImpl:async(url,options)=>{called={url:String(url),options};return{ok:true,json:async()=>({rooms:[]})};}});
 client.bootstrap={localControlToken:'test-local-nonce'};
 await client.loadRooms();
 assert.equal(called.url,'http://localhost:59818/api/v1/rooms');assert.equal(called.options.credentials,'same-origin');assert.equal(called.options.headers['X-Local-Control-Token'],'test-local-nonce');
});

test('discovery diagnostics show traffic and failures without copying invitations or control tokens',()=>{
  const text=formatDiscoveryDiagnostics({interfaceName:'WLAN',localIPv4:'192.168.1.20',transport:'multicast+broadcast',running:true,queriesSent:4,queriesReceived:0,repliesReceived:0,sendErrors:1,lastError:'NETWORK_PERMISSION_DENIED',roomCode:'secret-code',hostControlToken:'secret-token'});
  assert.match(text,/组播 \+ 广播/);assert.match(text,/系统拒绝网络权限/);assert.match(text,/不代表网络已放行/);assert.doesNotMatch(text,/secret/);
});


test('empty state is offered only for a successful available discovery with no rooms',async()=>{
 const states=[];let result={available:true,rooms:[]};const list=new Element(),status=new Element(),refreshButton=new Element();
 const browser=createRoomBrowser({list,status,refreshButton,documentRef:{createElement:()=>new Element()},load:async()=>result,onJoin:async()=>{},onRooms:state=>states.push(state)});
 await browser.refresh();result={available:true,rooms:[room('朋友')]};await browser.refresh();result={available:false,rooms:[]};await browser.refresh();
 assert.deepEqual(states,[{count:0,available:true},{count:1,available:true},{count:0,available:false}]);
});
