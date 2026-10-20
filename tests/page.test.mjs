import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

export async function setup(data = new Map()) {
  let page;
  let now = 100000;
  let keyHandler;
  const calls = { vibrations: [], resets: 0, heartOff: 0, oxygenOff: 0, oxygenStops: 0, timerCleared: false };
  const widgets = new Set();
  const sensors = {};
  class TestDate extends Date { static now() { return now; } }
  const context = createContext({ Date: TestDate, console, Page: (p) => { page = p; },
    setInterval: () => 1, clearInterval: () => { calls.timerCleared = true; } });
  const noOp = () => 0;
  const modules = {
    "@zos/utils": { px: (n) => n },
    "@zos/ui": { widget: { TEXT: "text", BUTTON: "button", FILL_RECT: "rect" },
      prop: { TEXT: "text" }, align: { CENTER_H: 0, CENTER_V: 0 }, text_style: { WRAP: 0 },
      createWidget: (type, options) => {
        const w = { type, ...options, setProperty(key, value) { this[key] = value; } };
        widgets.add(w); return w;
      }, deleteWidget: (w) => widgets.delete(w) },
    "@zos/interaction": { KEY_HOME: 3, KEY_SELECT: 4, KEY_UP: 5, KEY_EVENT_CLICK: 2,
      onKey: ({ callback }) => { keyHandler = callback; }, offKey: () => { keyHandler = null; } },
    "@zos/storage": { LocalStorage: class {
      getItem(key, fallback) { return data.has(key) ? JSON.parse(data.get(key)) : fallback; }
      setItem(key, value) { data.set(key, JSON.stringify(value)); }
    } },
    "@zos/display": { setPageBrightTime: noOp, pauseDropWristScreenOff: noOp, pausePalmScreenOff: noOp,
      resetDropWristScreenOff: noOp, resetPalmScreenOff: noOp, resetPageBrightTime: () => { calls.resets++; } },
    "@zos/sensor": {
      VIBRATOR_SCENE_STRONG_REMINDER: 100, VIBRATOR_SCENE_NOTIFICATION: 200, VIBRATOR_SCENE_DURATION: 300,
      Vibrator: class { start(options) { calls.vibrations.push(options.mode); } stop() {} },
      HeartRate: class {
        constructor() { sensors.heart = this; }
        getCurrent() { return this.value; }
        onCurrentChange(cb) { this.callback = cb; }
        offCurrentChange() { calls.heartOff++; }
      },
      BloodOxygen: class {
        constructor() { sensors.oxygen = this; this.result = { retCode: 2, value: 99, time: 1 }; }
        getCurrent() { return this.result; }
        onChange(cb) { this.callback = cb; }
        offChange() { calls.oxygenOff++; }
        start() {}
        stop() { calls.oxygenStops++; }
      },
    },
  };
  const cache = new Map();
  async function load(id) {
    if (cache.has(id)) return cache.get(id);
    let module;
    if (modules[id]) {
      module = new SyntheticModule(Object.keys(modules[id]), function () {
        for (const [key, value] of Object.entries(modules[id])) this.setExport(key, value);
      }, { context, identifier: id });
    } else module = new SourceTextModule(readFileSync(id, "utf8"), { context, identifier: id });
    cache.set(id, module);
    await module.link((specifier, ref) => {
      if (specifier.startsWith("@zos/")) return load(specifier);
      let file = resolve(dirname(ref.identifier), specifier.replace("zosLoader:", "").replace("[pf]", "r"));
      if (!file.endsWith(".js")) file += ".js";
      return load(file);
    });
    return module;
  }
  const entry = fileURLToPath(new URL("../page/gt/home/index.page.js", import.meta.url));
  await (await load(entry)).evaluate();
  page.onInit(); page.build();
  return { page, calls, sensors, data, widgets, key: (...args) => keyHandler(...args),
    advance(ms) { now += ms; page.tick(); }, getNow: () => now };
}

const choose = (env, name) => [...env.widgets].find(w=>w.type==="button" && w.text===name).click_func();

test("automatic page flow, large metrics and persistence", async () => {
  const e=await setup();choose(e,"CO₂ 间歇表");e.key(3,2);
  assert.equal(e.page.session.phase,"preparing");
  assert.equal(e.page.live.timer.text,"00:05");
  e.advance(5000);assert.equal(e.page.session.phase,"hold");
  assert.equal(e.page.live.timer.text,"01:15");
  assert.equal(e.page.live.timer.text_size,100);
  assert.equal(e.page.live.hr.text_size,42);
  assert.equal(e.page.live.oxygen.text_size,42);
  assert.equal(e.key(1,2),false,"lower shortcut is not crown");
  assert.equal(e.key(3,99),false,"non-click does not change phase");
  e.sensors.heart.value=70;e.sensors.heart.callback();
  e.sensors.oxygen.result={retCode:2,value:98,time:2};e.sensors.oxygen.callback();
  for(let i=0;i<8;i++) {
    e.advance(e.page.session.plan[i].hold*1000);
    assert.equal(e.page.session.phase,"recovery");
    e.key(3,2);assert.equal(e.page.session.phase,"recovery");
    e.advance(e.page.session.plan[i].recovery*1000);
  }
  assert.equal(e.page.screen,"result");
  assert.equal(e.calls.vibrations.length,1); // Preparation only; skipped recovery cues are not replayed.
  const saved=JSON.parse(e.data.get("apnea.history"))[0];
  assert.equal(saved.completedRounds,8);assert.equal(saved.longest.durationMs,75000);
  assert.equal(saved.records[0].heartRate.average,70);
  assert.equal(e.calls.heartOff,1);assert.equal(e.calls.oxygenOff,1);
  e.page.go("home");assert.ok([...e.widgets].some(w=>w.text==="最佳 01:15"));
  e.page.onDestroy();
});
test("free crown click, debounce, no recovery skipping, result at eighth recovery",async()=>{
  const e=await setup();choose(e,"自由计时");e.key(4,2);
  assert.equal(e.page.session.phase,"ready");e.advance(1000);
  for(let i=0;i<8;i++) {
    e.key(4,2);assert.equal(e.page.session.phase,"hold");
    e.key(4,2);assert.equal(e.page.session.phase,"hold");
    e.advance(10000);assert.equal(e.page.live.timer.text,"00:10");
    e.key(4,2);assert.equal(e.page.session.phase,"recovery");
    e.advance(1000);e.key(4,2);assert.equal(e.page.session.phase,"recovery");
    e.advance(179000);
    if(i<7) {assert.equal(e.page.session.phase,"ready");e.advance(5000);}
  }
  assert.equal(e.page.screen,"result");
  assert.equal(e.page.history[0].completedRounds,8);e.page.onDestroy();
});
test("new tables ignore old custom defaults; individual edits persist",async()=>{
  const data=new Map([["apnea.presets",JSON.stringify({co2:{hold:5}})]]);
  const e=await setup(data);choose(e,"CO₂ 间歇表");assert.equal(e.page.plan[0].hold,75);
  e.page.field=0;e.page.adjust("hold",5);e.page.preview();
  e.page.go("home");choose(e,"阶梯时长表");assert.equal(e.page.plan[0].hold,75);
  e.page.onDestroy();const r=await setup(data);choose(r,"CO₂ 间歇表");
  assert.equal(r.page.plan[0].hold,80);r.page.onDestroy();
});
test("cached and failed oxygen never shown as fresh; stale metrics hidden",async()=>{
  const e=await setup();choose(e,"自由计时");e.page.start();
  e.sensors.oxygen.callback();assert.equal(e.page.oxygenReading,null);
  e.advance(10000);e.sensors.oxygen.result={retCode:2,value:98,time:2};e.sensors.oxygen.callback();
  const at=e.page.oxygenReading.at;e.advance(10000);e.sensors.oxygen.callback();
  assert.equal(e.page.oxygenReading.at,at);
  e.advance(10000);e.sensors.oxygen.result={retCode:7,value:0,time:3};e.sensors.oxygen.callback();
  e.sensors.heart.value=72;e.sensors.heart.callback();e.advance(11000);
  assert.equal(e.page.live.hr.text,"心率  --");assert.equal(e.page.live.oxygen.text,"血氧  --");e.page.onDestroy();
});
test("oxygen UI only displays validated readings and hides error status",async()=>{
  const e=await setup();choose(e,"自由计时");e.page.start();
  const hidden=()=>{
    assert.equal(e.page.live.oxygen.text,"血氧  --");
    assert.equal(e.page.live.sensorStatus.text,"");
  };
  hidden();
  for(const result of [
    ...[0,1,3,4,5,6,7,8,9,10,99].map(retCode=>({retCode,value:98,time:2})),
    ...[0,-1,101,NaN,Infinity].map(value=>({retCode:2,value,time:2})),
    {retCode:2,value:98,time:NaN}
  ]) {
    e.sensors.oxygen.result=result;e.sensors.oxygen.callback();e.page.refresh();hidden();
    e.advance(10000);
  }
  e.sensors.oxygen.result={retCode:2,value:98,time:2};e.sensors.oxygen.callback();e.page.refresh();
  assert.equal(e.page.live.oxygen.text,"血氧  98%");
  assert.equal(e.page.live.sensorStatus.text,"血氧 00:00 前");
  e.advance(10000);
  e.sensors.oxygen.result={retCode:9,value:99,time:3};e.sensors.oxygen.callback();e.page.refresh();hidden();
  e.advance(10000);
  e.sensors.oxygen.result={retCode:2,value:97,time:4};e.sensors.oxygen.callback();e.page.refresh();
  assert.equal(e.page.live.oxygen.text,"血氧  97%");
  e.advance(61000);hidden();e.page.onDestroy();
});

test("user termination preserves partial duration; app interruption excluded from historic best",async()=>{
  for(const interrupted of [false,true]) {
    const e=await setup();choose(e,"自由计时");e.page.start();e.advance(1000);e.key(3,2);e.advance(7000);
    if(interrupted)e.page.onDestroy();else e.page.stop();
    const entry=JSON.parse(e.data.get("apnea.history"))[0];
    assert.equal(entry.records[0].durationMs,7000);assert.equal(entry.completedRounds,0);
    assert.equal(entry.status,interrupted?"interrupted":"stopped");
    assert.equal(e.page.best===null,interrupted);
    assert.equal(e.calls.heartOff,1);
    if(!interrupted)e.page.onDestroy();
  }
});
test("best survives history eviction and ties keep earliest date",async()=>{
  const data=new Map([["apnea.history",JSON.stringify([{records:[
    {durationMs:60000,startedAt:200000},{durationMs:60000,startedAt:400000},
    {durationMs:90000,startedAt:500000,interrupted:true}]}])]]);
  const e=await setup(data);assert.equal(e.page.best.achievedAt,260000);
  data.set("apnea.history","[]");e.page.onDestroy();
  const r=await setup(data);assert.equal(r.page.best.durationMs,60000);r.page.onDestroy();
});

test("recovery vibrates once at 30, 10, 5 seconds, not on zero or during ready", async () => {
  for (const name of ["CO₂ 间歇表", "自由计时"]) {
    const e=await setup(); choose(e,name);e.page.start();
    if(name==="自由计时") {e.advance(1000);e.key(3,2);e.advance(1000);e.key(3,2);}
    else {e.advance(5000);e.advance(75000);}
    assert.deepEqual(e.calls.vibrations,name==="自由计时"?[]:[200],"entering recovery adds no vibration");
    const start=e.getNow();
    const duration=e.page.session.plan[0].recovery*1000;
    const cues=[];
    for(let elapsed=250;elapsed<=duration;elapsed+=250) {
      const count=e.calls.vibrations.length;
      e.advance(250);
      if(e.calls.vibrations.length>count) {
        cues.push((duration-(e.getNow()-start))/1000);
        assert.equal(e.calls.vibrations.at(-1),300);
      }
    }
    assert.deepEqual(cues,[30,10,5]);
    const count=e.calls.vibrations.length;e.advance(1000);
    assert.equal(e.calls.vibrations.length,count);
    e.page.onDestroy();
  }
});
