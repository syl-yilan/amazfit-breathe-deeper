import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../utils/training.js", import.meta.url), "utf8");
const { makePlan, Training, PRESETS, formatTime } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

test("exact user schedules, post-hold recovery and free timing", () => {
  assert.deepEqual(makePlan(PRESETS[0]).map(r=>r.hold), Array(8).fill(75));
  assert.deepEqual(makePlan(PRESETS[0]).map(r=>r.recovery), [150,135,120,105,90,75,75,180]);
  assert.deepEqual(makePlan(PRESETS[1]).map(r=>r.hold), [75,75,90,90,105,105,120,120]);
  assert.deepEqual(makePlan(PRESETS[1]).map(r=>r.recovery), Array(8).fill(180));
  assert.ok(makePlan(PRESETS[2]).every(r=>r.hold===null && r.recovery===180));
  assert.equal(formatTime(75000), "01:15");
});
for (const preset of PRESETS.slice(0,2)) test(preset.name + " runs eight rounds without user input", () => {
  const s = new Training(preset, 0);
  assert.equal(s.phase,"preparing");
  assert.equal(s.tick(4999),null);
  assert.equal(s.tick(5000),"hold");
  let now=5000;
  for (let i=0;i<8;i++) {
    assert.equal(s.round,i);
    now+=s.plan[i].hold*1000;
    assert.equal(s.tick(now),"recovery");
    assert.equal(s.records[i].durationMs,s.plan[i].hold*1000);
    assert.equal(s.startHold(now+1),false);
    now+=s.plan[i].recovery*1000;
    assert.equal(s.tick(now),i===7 ? "done" : "hold");
  }
  const result=s.snapshot("completed");
  assert.equal(result.completedRounds,8);
  assert.equal(result.records.length,8);
  assert.equal(s.tick(now+10000),null);
});
test("free timing waits for crown, records actual time, never skips recovery", () => {
  const s=new Training(PRESETS[2],0);
  assert.equal(s.tick(900000),null);
  let now=900000;
  for(let i=0;i<8;i++) {
    assert.equal(s.phase,"ready"); s.startHold(now);
    now+=65000+i*1000;
    assert.equal(s.tick(now),null);
    s.finishHold(now);
    assert.equal(s.startHold(now+1),false);
    assert.equal(s.tick(now+179999),null);
    now+=180000;
    assert.equal(s.tick(now),i===7 ? "done":"ready");
    if(i<7) { now+=30000; assert.equal(s.tick(now),null); }
  }
  assert.equal(s.snapshot("completed").completedRounds,8);
  assert.equal(s.snapshot("completed").longest.durationMs,72000);
});
test("early end saves real time but is not a fully completed timed round", () => {
  const s=new Training(PRESETS[0],0);s.tick(5000);s.finishHold(15000);
  assert.equal(s.records[0].durationMs,10000);
  s.tick(165000);
  assert.equal(s.records[0].completed,false);
  assert.equal(s.records[0].recoveryCompleted,true);
  assert.equal(s.phase,"hold");
});
test("stop during hold or recovery preserves partial record without counting it complete", () => {
  for(const inRecovery of [false,true]) {
    const s=new Training(PRESETS[2],0);s.startHold(0);
    if(inRecovery)s.finishHold(10000);
    s.stop(15000);
    assert.equal(s.records.length,1);
    assert.equal(s.records[0].durationMs,inRecovery?10000:15000);
    assert.equal(s.snapshot("stopped").completedRounds,0);
    assert.equal(s.phase,"stopped");
    assert.equal(s.tick(999999),null);
  }
});
test("late timer does not invent missed rounds or shorten actual recovery", () => {
  const s=new Training(PRESETS[0],0);s.tick(5000);
  assert.equal(s.tick(600000),"recovery");
  assert.equal(s.records[0].durationMs,595000);
  assert.equal(s.records.length,1);
  assert.equal(s.remaining(600000),150000);
});
test("invalid schedules rejected; sensor values summarized only during hold", () => {
  assert.throws(()=>makePlan({...PRESETS[0],plan:[]}));
  assert.throws(()=>makePlan({...PRESETS[2],plan:Array(8).fill({hold:5,recovery:180})}));
  const s=new Training(PRESETS[2],0);s.sampleHeartRate(999);s.startHold(0);
  [0,NaN,60,80].forEach(n=>s.sampleHeartRate(n));s.sampleOxygen(98,3000);s.finishHold(5000);
  assert.equal(s.records[0].heartRate.average,70);
  assert.equal(s.records[0].oxygen.length,1);
});

test("recovery cues reset every round, skip delayed cues and stop with session", () => {
  const s=new Training(PRESETS[2],0);
  let now=0;
  for(let i=0;i<8;i++) {
    s.startHold(now);now+=10000;s.finishHold(now);
    assert.equal(s.recoveryReminder(now+150250),true);
    assert.equal(s.recoveryReminder(now+150500),false);
    assert.equal(s.recoveryReminder(now+170000),true);
    assert.equal(s.recoveryReminder(now+175000),true);
    assert.equal(s.recoveryReminder(now+175250),false);
    now+=180000;s.tick(now);
    assert.equal(s.recoveryReminder(now),false);
  }
  const late=new Training(PRESETS[2],0);late.startHold(0);late.finishHold(1000);
  assert.equal(late.recoveryReminder(177000),false); // 4 seconds left: do not replay 30/10/5.
  late.stop(178000);assert.equal(late.recoveryReminder(179000),false);
});
