import * as hmUI from "@zos/ui";
import { px } from "@zos/utils";
import { HeartRate, BloodOxygen, Vibrator,
  VIBRATOR_SCENE_NOTIFICATION, VIBRATOR_SCENE_DURATION } from "@zos/sensor";
import { LocalStorage } from "@zos/storage";
import { onKey, offKey, KEY_HOME, KEY_SELECT, KEY_UP, KEY_EVENT_CLICK } from "@zos/interaction";
import { setPageBrightTime, resetPageBrightTime, pauseDropWristScreenOff,
  resetDropWristScreenOff, pausePalmScreenOff, resetPalmScreenOff } from "@zos/display";
import { COLORS } from "zosLoader:./index.page.[pf].layout.js";
import { Training, makePlan, formatTime, formatDate, PRESETS } from "../../../utils/training";

Page({
  onInit() {
    this.storage = new LocalStorage();
    this.presetId = "co2";
    this.savedPresets = this.storage.getItem("apnea.presets.v2", {});
    this.config = JSON.parse(JSON.stringify(this.savedPresets.co2 || PRESETS[0]));
    this.history = this.storage.getItem("apnea.history", []);
    this.history.forEach((entry) => { if (entry.status === "active") entry.status = "interrupted"; });
    this.best = this.storage.getItem("apnea.best", null);
    this.updateBest(this.history);
    this.widgets = [];
    this.screen = "home";
    this.field = 0;
    this.vibrator = new Vibrator();
    this.hrReading = null;
    this.oxygenReading = null;
    this.hrStatus = "等待数据";
    this.lastActionAt = 0;
    this.keyCallback = (key, event) => {
      if (["training", "preview"].includes(this.screen) && [KEY_HOME, KEY_SELECT, KEY_UP].includes(key) && event === KEY_EVENT_CLICK) {
        if (this.screen === "preview") this.start();
        else this.action();
        return true;
      }
      return false;
    };
    onKey({ callback: this.keyCallback });
  },

  build() {
    this.render();
    this.timer = setInterval(() => this.tick(), 250);
  },

  add(type, options) {
    const item = hmUI.createWidget(type, options);
    this.widgets.push(item);
    return item;
  },

  text(text, y, size = 24, color = COLORS.text, h = 40) {
    return this.add(hmUI.widget.TEXT, { x: px(60), y: px(y), w: px(360), h: px(h),
      text, text_size: px(size), color, align_h: hmUI.align.CENTER_H,
      align_v: hmUI.align.CENTER_V, text_style: hmUI.text_style.WRAP });
  },

  button(text, y, action, x = 110, w = 260, color = COLORS.button, small = false) {
    return this.add(hmUI.widget.BUTTON, { x: px(x), y: px(y), w: px(w), h: px(small ? 40 : 48),
      radius: px(small ? 14 : 20), text, text_size: px(small ? 20 : 23), color: COLORS.text,
      normal_color: color, press_color: 0x315663, click_func: action });
  },

  go(screen) { this.screen = screen; this.render(); },

  render() {
    this.widgets.forEach((item) => hmUI.deleteWidget(item));
    this.widgets = [];
    this.live = null;
    this.add(hmUI.widget.FILL_RECT, { x: 0, y: 0, w: px(480), h: px(480), color: COLORS.background });
    if (this.screen === "home") {
      this.text("breathe deeper", 42, 30, COLORS.accent);
      this.text(this.best ? "最佳 " + formatTime(this.best.durationMs) : "最佳 --:--", 87, 25);
      this.text(this.best ? formatDate(this.best.achievedAt) : "暂无记录", 123, 19, COLORS.muted, 28);
      PRESETS.forEach((preset, index) => {
        this.button(preset.name, 170 + index * 63, () => this.selectPreset(preset), 95, 290);
      });
      this.button("记录", 371, () => { this.historyIndex = 0; this.recordIndex = 0; this.go("history"); }, 185, 110, COLORS.background, true);
    } else if (this.screen === "settings") {
      const row = this.config.plan[this.field];
      this.text(`第 ${this.field + 1} / 8 轮`, 45, 28, COLORS.accent);
      this.text(this.config.mode === "FREE" ? "闭气 自由计时" : "闭气 " + formatTime(row.hold * 1000), 113, 28);
      if (this.config.mode !== "FREE") {
        this.button("−", 165, () => this.adjust("hold", -5), 120, 100);
        this.button("+", 165, () => this.adjust("hold", 5), 260, 100);
      }
      this.text("恢复 " + formatTime(row.recovery * 1000), 224, 28);
      this.button("−", 272, () => this.adjust("recovery", -5), 120, 100);
      this.button("+", 272, () => this.adjust("recovery", 5), 260, 100);
      this.button("上一轮", 331, () => { this.field = (this.field + 7) % 8; this.render(); }, 85, 145);
      this.button("下一轮", 331, () => { this.field = (this.field + 1) % 8; this.render(); }, 250, 145);
      this.button("保存", 390, () => this.preview(), 165, 150);
    } else if (this.screen === "preview") {
      this.text(this.config.name, 35, 29, COLORS.accent);
      this.text("准备开始 · 第 1 / 8 轮", 78, 21, COLORS.muted, 30);
      this.text("轮次     闭气       恢复", 111, 20, COLORS.muted, 28);
      this.plan.forEach((row, i) => {
        this.text(`${i + 1}       ${row.hold === null ? "自由" : formatTime(row.hold * 1000)}       ${formatTime(row.recovery * 1000)}`, 142 + i * 22, 21, COLORS.text, 24);
      });
      this.button("按下表冠开始", 328, () => this.start());
      this.button("返回", 389, () => this.go("home"), 120, 100, COLORS.background, true);
      this.button("修改", 389, () => { this.field = 0; this.go("settings"); }, 260, 100, COLORS.background, true);
    } else if (this.screen === "training") {
      const phase = this.session.phase;
      const labels = { preparing: "准备", recovery: "恢复", ready: "准备", hold: "闭气" };
      this.text(`${this.config.name || this.config.mode} · ${Math.min(this.session.round + 1, this.config.rounds)} / ${this.config.rounds}`, 35, 22, COLORS.accent);
      this.text(labels[phase], 70, 32);
      const timer = this.text("", 106, 100, COLORS.text, 116);
      const hint = this.text("", 226, 20, COLORS.warning, 28);
      const hr = this.text("", 260, 42, COLORS.text, 52);
      const oxygen = this.text("", 314, 42, COLORS.text, 52);
      const sensorStatus = this.text("", 372, 18, COLORS.muted, 27);
      this.button("结束训练", 405, () => this.stop(), 165, 150, COLORS.background, true);
      this.live = { timer, hint, hr, oxygen, sensorStatus };
      this.refresh();
    } else if (this.screen === "history") {
      this.renderHistory();
    } else if (this.screen === "result") {
      this.renderResult();
    } else if (this.screen === "historyDetails") {
      this.renderDetails();
    } else if (this.screen === "error") {
      this.text("请检查", 65, 30, COLORS.warning);
      this.text(this.message, 147, 25, COLORS.text, 140);
      this.button("返回", 329, () => this.go("settings"));
    }
  },

  adjust(key, amount) {
    const row = this.config.plan[this.field];
    row[key] = Math.max(5, Math.min(3600, row[key] + amount));
    this.render();
  },

  selectPreset(preset) {
    this.presetId = preset.id;
    this.config = JSON.parse(JSON.stringify(this.savedPresets[preset.id] || preset));
    this.preview();
  },

  preview() {
    try {
      this.plan = makePlan(this.config);
      this.storage.setItem("apnea.config", this.config);
      this.savedPresets[this.presetId] = JSON.parse(JSON.stringify(this.config));
      this.storage.setItem("apnea.presets.v2", this.savedPresets);
      this.previewIndex = 0;
      this.go("preview");
    } catch (error) { this.message = error.message; this.go("error"); }
  },

  start() {
    if (this.screen === "training") return;
    this.lastActionAt = Date.now();
    this.session = new Training(this.config, Date.now());
    this.save("active");
    setPageBrightTime({ brightTime: 2147483000 });
    pauseDropWristScreenOff({ duration: 0 });
    pausePalmScreenOff({ duration: 0 });
    this.startSensors();
    this.go("training");
  },

  action() {
    const now = Date.now();
    if (now - this.lastActionAt < 500) return;
    this.lastActionAt = now;
    if (this.session.phase === "ready") {
      this.session.startHold(now);
      this.save("active");
      this.render();
    } else if (this.session.phase === "hold") {
      this.session.finishHold(now);
      this.save("active");
      this.render();
    }
  },

  stop() {
    this.session.stop(Date.now());
    this.finishSession("stopped");
  },

  tick() {
    if (this.screen !== "training") return;
    const now = Date.now();
    const previousPhase = this.session.phase;
    const event = this.session.tick(now);
    if (event) {
      if (previousPhase === "preparing") {
        this.vibrator.start({ mode: VIBRATOR_SCENE_NOTIFICATION });
      }
      if (event === "done") {
        this.finishSession(this.session.endedEarly ? "stopped" : "completed");
        return;
      }
      this.save("active");
      this.render();
    }
    if (this.session.recoveryReminder(now)) {
      this.vibrator.stop();
      this.vibrator.start({ mode: VIBRATOR_SCENE_DURATION });
    }
    if (this.oxygenBusy && now - this.oxygenStarted > 60000) {
      this.finishOxygen();
    }
    if (!this.oxygenBusy && this.oxygenSensor && now >= this.nextOxygenAt) this.measureOxygen();
    this.refresh();
  },

  refresh() {
    if (!this.live) return;
    const now = Date.now();
    const phase = this.session.phase;
    const countUp = phase === "hold" && this.config.mode === "FREE";
    const value = countUp ? now - this.session.phaseAt : this.session.remaining(now);
    this.live.timer.setProperty(hmUI.prop.TEXT, phase === "ready" ? "00:00" : formatTime(countUp ? value : Math.ceil(value / 1000) * 1000));
    const hint = phase === "ready" ? "准备好后按下表冠" : phase === "hold" ? "按下表冠可结束闭气" : phase === "preparing" ? "倒计时后自动开始" : "自然呼吸";
    this.live.hint.setProperty(hmUI.prop.TEXT, hint);
    const hrAge = this.hrReading ? now - this.hrReading.at : null;
    const oxygenAge = this.oxygenReading ? now - this.oxygenReading.at : null;
    const hrValid = hrAge !== null && hrAge <= 10000;
    const oxygenValid = oxygenAge !== null && oxygenAge <= 60000;
    this.live.hr.setProperty(hmUI.prop.TEXT, `心率  ${hrValid ? this.hrReading.value : "--"}`);
    this.live.oxygen.setProperty(hmUI.prop.TEXT, `血氧  ${oxygenValid ? this.oxygenReading.value + "%" : "--"}`);
    this.live.sensorStatus.setProperty(hmUI.prop.TEXT, oxygenValid ? `血氧 ${formatTime(oxygenAge)} 前` : "");
  },

  startSensors() {
    this.hrReading = null;
    this.oxygenReading = null;
    this.hrStatus = "等待数据";
    this.sensorsActive = true;
    this.lastOxygenTime = null;
    try {
      this.heartSensor = new HeartRate();
      this.heartCallback = () => {
        if (!this.sensorsActive) return;
        const value = this.heartSensor.getCurrent();
        if (Number.isFinite(value) && value > 0) {
          this.hrReading = { value, at: Date.now() };
          this.session.sampleHeartRate(value);
        }
      };
      this.heartSensor.onCurrentChange(this.heartCallback);
    } catch (_) { this.hrStatus = "测量不可用"; }
    try {
      this.oxygenSensor = new BloodOxygen();
      this.oxygenCallback = () => {
        if (!this.sensorsActive || !this.oxygenBusy) return;
        const result = this.oxygenSensor.getCurrent();
        if (result.retCode === 2 && Number.isFinite(result.value) && result.value > 0 && result.value <= 100 && Number.isFinite(result.time)) {
          if (result.time !== this.lastOxygenTime) {
            this.lastOxygenTime = result.time;
            this.oxygenReading = { value: result.value, at: Date.now() };
            this.session.sampleOxygen(result.value, Date.now());
          }
        } else if (result.retCode !== 1) this.oxygenReading = null;
        if (result.retCode !== 1) this.finishOxygen();
      };
      const previous = this.oxygenSensor.getCurrent();
      if (previous.retCode === 2) this.lastOxygenTime = previous.time;
      this.oxygenSensor.onChange(this.oxygenCallback);
      this.measureOxygen();
    } catch (_) { this.oxygenBusy = false; }
  },

  measureOxygen() {
    this.oxygenBusy = false;
    try {
      this.oxygenSensor.stop();
      this.oxygenBusy = true;
      this.oxygenStarted = Date.now();
      this.oxygenSensor.start();
    } catch (_) {
      this.oxygenBusy = false;
      this.nextOxygenAt = Date.now() + 10000;
    }
  },

  finishOxygen() {
    this.oxygenBusy = false;
    this.nextOxygenAt = Date.now() + 10000;
    try { this.oxygenSensor.stop(); } catch (_) { /* Still allow manual timing. */ }
  },

  stopSensors() {
    this.sensorsActive = false;
    this.oxygenBusy = false;
    if (this.heartSensor && this.heartCallback) {
      try { this.heartSensor.offCurrentChange(this.heartCallback); } catch (_) { /* Unavailable sensor. */ }
    }
    if (this.oxygenSensor) {
      try { this.oxygenSensor.offChange(this.oxygenCallback); } catch (_) { /* Unavailable sensor. */ }
      try { this.oxygenSensor.stop(); } catch (_) { /* Unavailable sensor. */ }
    }
    this.heartSensor = null;
    this.oxygenSensor = null;
  },

  save(status) {
    const entry = this.session.snapshot(status);
    this.updateBest([entry]);
    this.history = [entry, ...this.history.filter((item) => item.startedAt !== entry.startedAt)].slice(0, 10);
    this.storage.setItem("apnea.history", this.history);
  },

  updateBest(entries) {
    let best = this.best;
    entries.forEach((entry) => entry.records.forEach((record) => {
      if (record.interrupted || !Number.isFinite(record.durationMs) || record.durationMs <= 0 || !Number.isFinite(record.startedAt)) return;
      const achievedAt = record.startedAt + record.durationMs;
      if (!best || record.durationMs > best.durationMs || (record.durationMs === best.durationMs && achievedAt < best.achievedAt)) {
        best = { durationMs: record.durationMs, achievedAt };
      }
    }));
    if (best !== this.best) {
      this.storage.setItem("apnea.best", best);
      this.best = best;
    }
  },

  finishSession(status) {
    this.save(status);
    this.stopSensors();
    this.resetDisplay();
    this.historyIndex = 0;
    this.recordIndex = 0;
    this.go("result");
  },

  renderResult() {
    const entry = this.history[this.historyIndex || 0];
    this.text(entry.status === "completed" ? "训练完成" : "训练结束", 43, 28, COLORS.accent);
    this.text(entry.scheme || entry.config.name || entry.config.mode, 90, 26);
    this.text(formatDate(entry.startedAt), 130, 20, COLORS.muted);
    this.text(`完成 ${entry.completedRounds === undefined ? entry.records.filter((r) => !r.interrupted).length : entry.completedRounds} / ${entry.config.rounds} 轮`, 173, 27);
    this.text(entry.longest ? "本次最长 " + formatTime(entry.longest.durationMs) : "暂无闭气记录", 228, 31);
    this.text(entry.longest ? formatDate(entry.longest.achievedAt) : "", 274, 20, COLORS.muted);
    this.button("每轮记录", 326, () => this.go("historyDetails"));
    this.button("上一条", 390, () => { this.historyIndex = ((this.historyIndex || 0) + 1) % this.history.length; this.recordIndex = 0; this.render(); }, 100, 120, COLORS.background, true);
    this.button("首页", 390, () => this.go("home"), 260, 120, COLORS.background, true);
  },

  renderHistory() {
    if (this.history.length) { this.renderResult(); return; }
    this.text("训练记录", 65, 28, COLORS.accent);
    this.text("暂无训练记录", 190, 28);
    this.button("返回", 380, () => this.go("home"), 165, 150);
  },

  renderDetails() {
    const entry = this.history[this.historyIndex];
    this.text("训练记录", 40, 28, COLORS.accent);
    if (!entry) {
      this.text("还没有训练记录", 180, 26);
    } else {
      const status = { completed: "完成", stopped: "提前结束", interrupted: "中断", active: "未完成" };
      const date = new Date(entry.startedAt);
      this.text(`${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")} · ${entry.config.mode} · ${status[entry.status]}`, 88, 21, COLORS.muted);
      const record = entry.records[this.recordIndex];
      if (record) {
        this.text(`第 ${record.round} 轮${record.completed === false ? " · 未完整完成" : record.interrupted ? " · 中断" : ""}`, 129, 25);
        this.text(`闭气 ${formatTime(record.durationMs)} / ${record.targetSeconds === null ? "自由" : formatTime(record.targetSeconds * 1000)}`, 172, 25);
        this.text(`${entry.schemaVersion === 2 ? "本轮恢复" : "此前恢复"} ${formatTime(record.recoveryMs)}`, 212, 22, COLORS.muted);
        this.text(`心率均值 ${record.heartRate.average === null ? "--" : record.heartRate.average} bpm`, 249, 23);
        const last = record.oxygen[record.oxygen.length - 1];
        this.text(last ? `血氧末次样本 ${last.value}% · 非连续` : "本轮无有效血氧样本", 286, 21, COLORS.muted);
      } else this.text("未记录闭气轮次", 185, 26);
      this.button("下一轮", 330, () => { this.recordIndex = (this.recordIndex + 1) % Math.max(1, entry.records.length); this.render(); }, 85, 145);
      this.button("下次训练", 330, () => { this.historyIndex = (this.historyIndex + 1) % this.history.length; this.recordIndex = 0; this.render(); }, 250, 145);
    }
    this.button("返回", 393, () => this.go("history"), 140, 200);
  },

  resetDisplay() {
    resetPageBrightTime();
    resetDropWristScreenOff();
    resetPalmScreenOff();
  },

  onDestroy() {
    clearInterval(this.timer);
    offKey();
    try {
      if (this.session && this.screen === "training") {
        this.session.stop(Date.now(), true);
        this.save("interrupted");
      }
    } finally {
      this.stopSensors();
      this.vibrator.stop();
      this.resetDisplay();
    }
  },
});
