// Explicit user-provided schedules. Recovery follows the hold in the same row.
export const PRESETS = [
  { id: "co2", name: "CO₂ 间歇表", mode: "CO2", rounds: 8,
    plan: [150, 135, 120, 105, 90, 75, 75, 180].map((recovery) => ({ hold: 75, recovery })) },
  { id: "step", name: "阶梯时长表", mode: "STEP", rounds: 8,
    plan: [75, 75, 90, 90, 105, 105, 120, 120].map((hold) => ({ hold, recovery: 180 })) },
  { id: "free", name: "自由计时", mode: "FREE", rounds: 8,
    plan: Array.from({ length: 8 }, () => ({ hold: null, recovery: 180 })) },
];

export function makePlan(config) {
  if (!["CO2", "STEP", "FREE"].includes(config.mode)) throw new Error("请选择训练方案");
  if (!Array.isArray(config.plan) || config.plan.length !== 8) throw new Error("训练表须为 8 轮");
  const validTime = (n) => Number.isInteger(n) && n > 0 && n <= 3600;
  if (config.plan.some((r) => !validTime(r.recovery) || (config.mode === "FREE" ? r.hold !== null : !validTime(r.hold)))) {
    throw new Error("请检查闭气和恢复时间");
  }
  return config.plan.map((r) => ({ ...r }));
}

export function formatDate(time) {
  const date = new Date(time);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatTime(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

export class Training {
  constructor(config, now) {
    this.config = JSON.parse(JSON.stringify(config));
    this.plan = makePlan(config);
    this.startedAt = now;
    this.phase = config.mode === "FREE" ? "ready" : "preparing";
    this.phaseAt = now;
    this.round = 0;
    this.records = [];
    this.endedEarly = false;
  }

  tick(now) {
    if (this.phase === "preparing" && now - this.phaseAt >= 5000) {
      this.phase = "ready";
      this.startHold(now);
      return "hold";
    }
    if (this.phase === "hold" && this.config.mode !== "FREE" && now - this.phaseAt >= this.plan[this.round].hold * 1000) {
      this.finishHold(now, "timer");
      return "recovery";
    }
    if (this.phase === "recovery" && now - this.phaseAt >= this.plan[this.round].recovery * 1000) {
      const record = this.records[this.records.length - 1];
      record.recoveryMs = now - this.recoveryStartedAt;
      record.recoveryCompleted = true;
      record.completed = record.targetReached;
      if (this.round === this.plan.length - 1) {
        this.phase = "done";
        return "done";
      }
      this.round++;
      this.phase = "ready";
      if (this.config.mode !== "FREE") this.startHold(now);
      return this.phase;
    }
    return null;
  }

  startHold(now) {
    if (this.phase !== "ready") return false;
    if (this.records.length) this.records[this.records.length - 1].recoveryMs = now - this.recoveryStartedAt;
    this.phase = "hold";
    this.phaseAt = now;
    this.hr = { count: 0, sum: 0, min: null, max: null };
    this.oxygen = [];
    return true;
  }

  recoveryReminder(now) {
    if (this.phase !== "recovery") return false;
    const remaining = this.remaining(now);
    let remind = false;
    for (const seconds of [30, 10, 5]) {
      if (remaining <= seconds * 1000 && !this.recoveryReminders.includes(seconds)) {
        this.recoveryReminders.push(seconds);
        // Skip missed cues after a delayed callback; never play a catch-up burst.
        if (remaining > 0 && remaining > (seconds - 1) * 1000) remind = true;
      }
    }
    return remind;
  }

  sampleHeartRate(value) {
    if (this.phase !== "hold" || !Number.isFinite(value) || value <= 0) return;
    this.hr.count++;
    this.hr.sum += value;
    this.hr.min = this.hr.min === null ? value : Math.min(this.hr.min, value);
    this.hr.max = this.hr.max === null ? value : Math.max(this.hr.max, value);
  }

  sampleOxygen(value, now) {
    if (this.phase !== "hold" || !Number.isFinite(value) || value <= 0 || value > 100) return;
    this.oxygen.push({ value, receivedAt: now });
    if (this.oxygen.length > 60) this.oxygen.shift();
  }

  finishHold(now, reason = "manual") {
    if (this.phase !== "hold") return false;
    this.records.push({
      round: this.round + 1,
      targetSeconds: this.plan[this.round].hold,
      startedAt: this.phaseAt,
      durationMs: Math.max(0, now - this.phaseAt),
      endedAt: now,
      recoveryMs: 0,
      completed: false,
      recoveryCompleted: false,
      targetReached: this.config.mode === "FREE" || now - this.phaseAt >= this.plan[this.round].hold * 1000,
      endedBy: reason,
      interrupted: reason === "interrupted",
      heartRate: { count: this.hr.count, min: this.hr.min, max: this.hr.max,
        average: this.hr.count ? Math.round(this.hr.sum / this.hr.count) : null },
      oxygen: this.oxygen.slice(),
    });
    this.phaseAt = now;
    this.recoveryStartedAt = now;
    this.recoveryReminders = [];
    this.phase = "recovery";
    return true;
  }

  stop(now, interrupted = false) {
    if (["done", "stopped"].includes(this.phase)) return;
    this.endedEarly = true;
    if (this.phase === "hold") this.finishHold(now, interrupted ? "interrupted" : "stopped");
    if (this.phase === "recovery" && this.records.length) {
      this.records[this.records.length - 1].recoveryMs = Math.max(0, now - this.recoveryStartedAt);
    }
    this.phase = "stopped";
  }

  remaining(now) {
    const row = this.plan[this.round];
    const seconds = this.phase === "preparing" ? 5 : this.phase === "hold" ? row.hold : row.recovery;
    return Math.max(0, seconds * 1000 - (now - this.phaseAt));
  }

  snapshot(status) {
    const longest = this.records.reduce((best, record) => !best || record.durationMs > best.durationMs ? record : best, null);
    return { schemaVersion: 2, startedAt: this.startedAt, scheme: this.config.name,
      config: this.config, records: this.records.map((r) => ({ ...r })),
      completedRounds: this.records.filter((r) => r.completed).length,
      longest: longest ? { durationMs: longest.durationMs, achievedAt: longest.endedAt } : null,
      endedEarly: this.endedEarly, status };
  }
}
