export type StepElement = Record<string, unknown> & { type?: string; animation?: Record<string, unknown> };

export type SimulationCanvasStepLike = {
  step?: number;
  concept?: string;
  subtitle?: string;
  canvas_instructions?: { elements?: StepElement[] };
  elements?: StepElement[];
};

type AnimState = {
  alpha: number;
  scale: number;
  rotation: number;
  dx: number;
  dy: number;
  drawProgress: number;
  textProgress: number;
  highlight: number;
};

export class SimulationCanvasRenderer {
  private readonly host: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private step: SimulationCanvasStepLike | null = null;
  private stepStartedAt = 0;
  private pauseStartedAt = 0;
  private pausedMs = 0;
  private paused = false;
  private labelBoxes: Array<{ x: number; y: number; w: number; h: number }> = [];

  constructor(host: HTMLDivElement) {
    this.host = host;
    this.host.innerHTML = "";
    this.canvas = document.createElement("canvas");
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.display = "block";
    const ctx = this.canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Canvas 2D context unavailable.");
    }
    this.ctx = ctx;
    this.host.appendChild(this.canvas);
    this.resize();
  }

  dispose(): void {
    this.host.innerHTML = "";
  }

  resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = Math.max(1, this.host.clientWidth);
    this.height = Math.max(1, this.host.clientHeight);
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setStep(step: SimulationCanvasStepLike): void {
    this.step = step;
    this.stepStartedAt = performance.now();
    this.pauseStartedAt = 0;
    this.pausedMs = 0;
    this.paused = false;
  }

  setPaused(paused: boolean, now = performance.now()): void {
    if (this.paused === paused) return;
    if (paused) {
      this.pauseStartedAt = now;
      this.paused = true;
      return;
    }
    this.pausedMs += Math.max(0, now - this.pauseStartedAt);
    this.pauseStartedAt = 0;
    this.paused = false;
  }

  getElementTypes(): string[] {
    return this.getElements().map((e) => this.type(e));
  }

  getSuggestedDurationMs(): number {
    const maxDuration = this.getElements().reduce((max, el) => {
      const d = this.num(this.anim(el), ["duration", "durationMs"], 900);
      return Math.max(max, d);
    }, 900);
    return Math.max(2600, maxDuration + 800);
  }

  getCurrentStep(): SimulationCanvasStepLike | null {
    return this.step;
  }

  moveElementByLabel(label: string, targetX: number, targetY: number, durationMs = 800): boolean {
    const normalized = label.trim().toLowerCase();
    if (!normalized) return false;
    const elements = this.getElements();
    const found = elements.find((el) => this.str(el.label).trim().toLowerCase() === normalized);
    if (!found) return false;
    const currentX = this.num(found, ["x", "x1"], 50);
    const currentY = this.num(found, ["y", "y1"], 50);
    (found as Record<string, unknown>).x = currentX;
    (found as Record<string, unknown>).y = currentY;
    (found as Record<string, unknown>).animation = {
      ...(this.obj(found.animation)),
      type: "move",
      target_x: targetX,
      target_y: targetY,
      duration: Math.max(120, durationMs)
    };
    this.stepStartedAt = performance.now();
    this.pausedMs = 0;
    return true;
  }

  modifyElementByLabel(
    label: string,
    property: "color" | "size" | "label",
    newValue: string | number,
    durationMs = 800
  ): boolean {
    const normalized = label.trim().toLowerCase();
    if (!normalized) return false;
    const elements = this.getElements();
    const found = elements.find((el) => this.str(el.label).trim().toLowerCase() === normalized);
    if (!found) return false;
    if (property === "color" && typeof newValue === "string") {
      (found as Record<string, unknown>).color = newValue;
    } else if (property === "label" && typeof newValue === "string") {
      (found as Record<string, unknown>).label = newValue;
    } else if (property === "size" && typeof newValue === "number" && Number.isFinite(newValue)) {
      const next = Math.max(2, newValue);
      (found as Record<string, unknown>).width = next;
      (found as Record<string, unknown>).height = next;
    } else {
      return false;
    }
    (found as Record<string, unknown>).animation = {
      ...(this.obj(found.animation)),
      type: "highlight",
      duration: Math.max(120, durationMs)
    };
    this.stepStartedAt = performance.now();
    this.pausedMs = 0;
    return true;
  }

  render(now = performance.now()): void {
    this.ctx.clearRect(0, 0, this.width, this.height);
    if (!this.step) return;
    this.labelBoxes = [];
    const elapsed = this.elapsed(now);
    for (const el of this.getElements()) {
      this.draw(el, elapsed);
    }
  }

  private elapsed(now: number): number {
    const pausedSlice = this.paused ? now - this.pauseStartedAt : 0;
    return Math.max(0, now - this.stepStartedAt - this.pausedMs - pausedSlice);
  }

  private getElements(): StepElement[] {
    if (!this.step) return [];
    const fromCanvas = Array.isArray(this.step.canvas_instructions?.elements) ? this.step.canvas_instructions.elements : [];
    const fromFlat = Array.isArray(this.step.elements) ? this.step.elements : [];
    return [...fromCanvas, ...fromFlat].filter(Boolean) as StepElement[];
  }

  private obj(v: unknown): Record<string, unknown> {
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  }

  private arr(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
  }

  private str(v: unknown, fallback = ""): string {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return fallback;
  }

  private num(source: unknown, keys: string[], fallback = 0): number {
    const o = this.obj(source);
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string") {
        const n = Number.parseFloat(v.replace("%", "").trim());
        if (Number.isFinite(n)) return n;
      }
    }
    return fallback;
  }

  private type(el: StepElement): string {
    return this.str(el.type, "rectangle").toLowerCase().replace(/\s+/g, "_");
  }

  private anim(el: StepElement): Record<string, unknown> {
    return this.obj(el.animation);
  }

  private x(v: number): number {
    return v >= 0 && v <= 100 ? (v / 100) * this.width : v;
  }

  private y(v: number): number {
    return v >= 0 && v <= 100 ? (v / 100) * this.height : v;
  }

  private w(v: number): number {
    return Math.max(1, v >= 0 && v <= 100 ? (v / 100) * this.width : v);
  }

  private h(v: number): number {
    return Math.max(1, v >= 0 && v <= 100 ? (v / 100) * this.height : v);
  }

  private px(v: number): number {
    return Math.max(1, v >= 0 && v <= 100 ? (v / 100) * Math.min(this.width, this.height) : v);
  }

  private color(el: StepElement, fallback = "#00d4ff"): string {
    const c = this.str(el.color, fallback);
    if (/^#[0-9a-f]{3}$/i.test(c)) {
      return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
    }
    return /^#[0-9a-f]{6}$/i.test(c) ? c : fallback;
  }

  private alphaColor(hex: string, alpha: number): string {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
    const r = Number.parseInt(hex.slice(1, 3), 16);
    const g = Number.parseInt(hex.slice(3, 5), 16);
    const b = Number.parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
  }

  private brighten(hex: string, t: number): string {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
    const boost = Math.max(0, Math.min(1, t));
    const p = (v: number) => Math.min(255, Math.round(v + (255 - v) * boost));
    const r = p(Number.parseInt(hex.slice(1, 3), 16));
    const g = p(Number.parseInt(hex.slice(3, 5), 16));
    const b = p(Number.parseInt(hex.slice(5, 7), 16));
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  }

  private state(el: StepElement, elapsed: number): AnimState {
    const a = this.anim(el);
    const type = this.str(a.type, "none").toLowerCase().replace(/\s+/g, "_");
    const delay = Math.max(0, this.num(a, ["delay", "delayMs"], 0));
    const duration = Math.max(100, this.num(a, ["duration", "durationMs"], 900));
    const localElapsed = Math.max(0, elapsed - delay);
    const loopPulse = ["pulse"].includes(type);
    const p = loopPulse
      ? ((localElapsed % duration) + duration) % duration / duration
      : Math.min(1, localElapsed / duration);
    const s: AnimState = { alpha: 1, scale: 1, rotation: 0, dx: 0, dy: 0, drawProgress: 1, textProgress: 1, highlight: 0 };
    const hasAnimation = Object.keys(a).length > 0 && type !== "none";
    const idleScale = 1 + 0.03 * Math.sin((elapsed / 2000) * Math.PI * 2);

    if (!hasAnimation) {
      s.scale = idleScale;
      return s;
    }

    if (elapsed < delay) {
      s.drawProgress = 0;
      s.textProgress = 0;
      s.alpha = type === "fade_in" ? 0 : 1;
      return s;
    }

    if (type === "fade_in") s.alpha = p;
    else if (type === "fade_out") s.alpha = 1 - p;
    else if (type === "scale_up") s.scale = p;
    else if (type === "scale_down") s.scale = 1 - p;
    else if (type === "pulse") s.scale = 1 + 0.08 * Math.sin(p * Math.PI * 2);
    else if (type === "rotate") s.rotation = (this.num(a, ["angle", "degrees"], 360) * p * Math.PI) / 180;
    else if (type === "highlight") s.highlight = Math.sin(p * Math.PI);
    else if (type === "draw") s.drawProgress = p;
    else if (type === "typewriter") s.textProgress = p;
    else if (type === "move" || type === "bounce" || type === "follow_path") {
      const sx = this.x(this.num(el, ["x", "x1"], 0));
      const sy = this.y(this.num(el, ["y", "y1"], 0));
      const tx = this.x(this.num(a, ["target_x", "to_x", "x2"], sx));
      const ty = this.y(this.num(a, ["target_y", "to_y", "y2"], sy));
      const t = type === "bounce" ? this.easeOutBack(p) : p;
      if (type === "follow_path") {
        const cx = this.x(this.num(a, ["cx", "control_x"], (sx + tx) / 2));
        const cy = this.y(this.num(a, ["cy", "control_y"], Math.min(sy, ty) - 60));
        const q = this.quad(t, sx, sy, cx, cy, tx, ty);
        s.dx = q.x - sx;
        s.dy = q.y - sy;
      } else {
        s.dx = (tx - sx) * t;
        s.dy = (ty - sy) * t;
      }
    }

    if (!loopPulse && localElapsed >= duration) {
      s.scale *= idleScale;
    }

    return s;
  }

  private withTransform(anchorX: number, anchorY: number, s: AnimState, draw: () => void): void {
    this.ctx.save();
    this.ctx.globalAlpha = Math.max(0, Math.min(1, s.alpha));
    this.ctx.translate(anchorX + s.dx, anchorY + s.dy);
    this.ctx.rotate(s.rotation);
    this.ctx.scale(s.scale, s.scale);
    this.ctx.translate(-anchorX, -anchorY);
    draw();
    this.ctx.restore();
  }

  private isDarkColor(color: string): boolean {
    if (!/^#[0-9a-f]{6}$/i.test(color)) return false;
    const r = Number.parseInt(color.slice(1, 3), 16);
    const g = Number.parseInt(color.slice(3, 5), 16);
    const b = Number.parseInt(color.slice(5, 7), 16);
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return luminance < 0.45;
  }

  private overlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  private drawTextPill(
    text: string,
    x: number,
    y: number,
    align: CanvasTextAlign,
    textColor = "#FFFFFF",
    font = "600 12px Inter, Segoe UI, sans-serif"
  ): { x: number; y: number; w: number; h: number } {
    const box = this.textPillBox(text, x, y, align, font);
    this.ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    this.ctx.fillRect(box.x, box.y, box.w, box.h);
    this.ctx.fillStyle = this.isDarkColor(textColor) ? "#FFFFFF" : textColor;
    this.ctx.font = font;
    this.ctx.textAlign = align;
    this.ctx.textBaseline = "middle";
    this.ctx.fillText(text, x, y);
    return box;
  }

  private textPillBox(
    text: string,
    x: number,
    y: number,
    align: CanvasTextAlign,
    font = "600 12px Inter, Segoe UI, sans-serif"
  ): { x: number; y: number; w: number; h: number } {
    this.ctx.font = font;
    const metrics = this.ctx.measureText(text);
    const tw = Math.max(8, metrics.width);
    const th = 16;
    const padX = 8;
    const padY = 4;
    const boxW = tw + padX * 2;
    const boxH = th + padY * 2;
    let boxX = x - boxW / 2;
    if (align === "left") boxX = x - 2;
    if (align === "right") boxX = x - boxW + 2;
    const boxY = y - boxH / 2;
    return { x: boxX, y: boxY, w: boxW, h: boxH };
  }

  private label(
    el: StepElement,
    text: string,
    x: number,
    y: number,
    defaultPos: "above" | "below" | "left" | "right",
    parentBox?: { x: number; y: number; w: number; h: number }
  ): void {
    if (!text) return;
    const safeText = text.slice(0, 80);
    const pos = this.str(el.label_position, defaultPos).toLowerCase();
    const font = "600 12px Inter, Segoe UI, sans-serif";
    let lx = x;
    let ly = y;
    let align: CanvasTextAlign = "center";
    let dx = 0;
    let dy = 0;
    if (pos === "above") {
      ly -= 12;
      dy = -20;
    } else if (pos === "below") {
      ly += 14;
      dy = 20;
    } else if (pos === "left") {
      lx -= 10;
      align = "right";
      dx = -20;
    } else if (pos === "right") {
      lx += 10;
      align = "left";
      dx = 20;
    }

    let attempts = 0;
    let box = this.textPillBox(safeText, lx, ly, align, font);
    while (
      attempts < 20 &&
      (this.labelBoxes.some((existing) => this.overlap(existing, box)) || (parentBox ? this.overlap(parentBox, box) : false))
    ) {
      lx += dx;
      ly += dy;
      box = this.textPillBox(safeText, lx, ly, align, font);
      attempts += 1;
    }
    this.drawTextPill(safeText, lx, ly, align, "#FFFFFF", font);
    this.labelBoxes.push(box);
  }

  private draw(el: StepElement, elapsed: number): void {
    const t = this.type(el);
    const s = this.state(el, elapsed);
    const c = this.brighten(this.color(el), s.highlight * 0.35);
    const label = this.str(el.label);
    const x = this.x(this.num(el, ["x"], 50));
    const y = this.y(this.num(el, ["y"], 50));
    const w = this.w(this.num(el, ["width"], 16));
    const h = this.h(this.num(el, ["height"], 12));
    const r = this.px(this.num(el, ["radius", "r"], Math.min(w, h) / 4));
    const lineWidth = Math.max(1, this.num(el, ["thickness", "line_width", "stroke_width"], 2));
    const centerX = t === "circle" || t === "ellipse" || t === "plot_point" || t === "pulse" || t === "tree_node" ? x : x + w / 2;
    const centerY = t === "circle" || t === "ellipse" || t === "plot_point" || t === "pulse" || t === "tree_node" ? y : y + h / 2;

    this.withTransform(centerX, centerY, s, () => {
      this.ctx.strokeStyle = c;
      this.ctx.fillStyle = c;
      this.ctx.lineWidth = lineWidth;
      if (t === "rectangle" || t === "highlight_box") {
        this.roundRect(x, y, w, h, 6);
        if (t === "highlight_box") {
          this.ctx.fillStyle = this.alphaColor(c, 0.25);
          this.ctx.fill();
          this.ctx.strokeStyle = this.alphaColor(c, 0.85);
          this.ctx.stroke();
        } else {
          this.ctx.fill();
        }
        this.label(el, label, x + w / 2, y, "above", { x, y, w, h });
      } else if (t === "bar") {
        const orientation = this.str(el.orientation, "vertical").toLowerCase();
        this.roundRect(x, y, w, h, 6);
        this.ctx.fill();
        const valueLabel = this.str(el.value_label, label);
        if (orientation === "horizontal") {
          this.label(el, valueLabel, x + w, y + h / 2, "right", { x, y, w, h });
        } else {
          this.label(el, valueLabel, x + w / 2, y, "above", { x, y, w, h });
        }
      } else if (t === "circle" || t === "plot_point") {
        this.ctx.beginPath();
        this.ctx.arc(x, y, Math.max(2, r), 0, Math.PI * 2);
        this.ctx.fill();
        this.label(el, label, x, y + r, t === "plot_point" ? "right" : "below", {
          x: x - Math.max(2, r),
          y: y - Math.max(2, r),
          w: Math.max(2, r) * 2,
          h: Math.max(2, r) * 2
        });
      } else if (t === "ellipse") {
        this.ctx.beginPath();
        this.ctx.ellipse(x, y, Math.max(2, w / 2), Math.max(2, h / 2), 0, 0, Math.PI * 2);
        this.ctx.fill();
        this.label(el, label, x + w / 2, y, "right", {
          x: x - Math.max(2, w / 2),
          y: y - Math.max(2, h / 2),
          w: Math.max(2, w / 2) * 2,
          h: Math.max(2, h / 2) * 2
        });
      } else if (t === "triangle" || t === "flowchart_diamond") {
        this.ctx.beginPath();
        if (t === "flowchart_diamond") {
          this.ctx.moveTo(x + w / 2, y);
          this.ctx.lineTo(x + w, y + h / 2);
          this.ctx.lineTo(x + w / 2, y + h);
          this.ctx.lineTo(x, y + h / 2);
        } else {
          this.ctx.moveTo(x + w / 2, y);
          this.ctx.lineTo(x + w, y + h);
          this.ctx.lineTo(x, y + h);
        }
        this.ctx.closePath();
        this.ctx.fill();
        this.label(el, label, x + w / 2, y, "above", { x, y, w, h });
      } else if (t === "line" || t === "dashed_line" || t === "arrow") {
        const x1 = this.x(this.num(el, ["x1"], x));
        const y1 = this.y(this.num(el, ["y1"], y));
        const x2 = this.x(this.num(el, ["x2"], x + w));
        const y2 = this.y(this.num(el, ["y2"], y + h));
        const end = this.pointAt(x1, y1, x2, y2, s.drawProgress);
        this.ctx.save();
        if (t === "dashed_line") this.ctx.setLineDash([8, 4]);
        this.ctx.beginPath();
        this.ctx.moveTo(x1, y1);
        this.ctx.lineTo(end.x, end.y);
        this.ctx.stroke();
        this.ctx.restore();
        if (t === "arrow") this.arrowHead(x1, y1, end.x, end.y, c, lineWidth + 2);
        this.label(el, label, (x1 + x2) / 2, (y1 + y2) / 2, "above", {
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          w: Math.abs(x2 - x1) || 1,
          h: Math.abs(y2 - y1) || 1
        });
      } else if (t === "curved_arrow") {
        const x1 = this.x(this.num(el, ["x1"], x));
        const y1 = this.y(this.num(el, ["y1"], y));
        const x2 = this.x(this.num(el, ["x2"], x + w));
        const y2 = this.y(this.num(el, ["y2"], y + h));
        const cx = this.x(this.num(el, ["cx"], (x1 + x2) / 2));
        const cy = this.y(this.num(el, ["cy"], Math.min(y1, y2) - 40));
        this.ctx.beginPath();
        this.ctx.moveTo(x1, y1);
        this.partialQuad(x1, y1, cx, cy, x2, y2, s.drawProgress);
        this.ctx.stroke();
        const p = this.quad(Math.max(0.98, s.drawProgress), x1, y1, cx, cy, x2, y2);
        const p2 = this.quad(Math.max(0.9, s.drawProgress - 0.02), x1, y1, cx, cy, x2, y2);
        this.arrowHead(p2.x, p2.y, p.x, p.y, c, lineWidth + 2);
      } else if (t === "text") {
        const text = this.str(el.text, label);
        const fontSize = Math.max(10, this.num(el, ["font_size", "fontSize"], 16));
        const textAlign = this.str(el.text_align, "center") as CanvasTextAlign;
        const visible = text.slice(0, Math.max(0, Math.ceil(text.length * s.textProgress)));
        this.drawTextPill(
          visible,
          x,
          y,
          textAlign,
          this.isDarkColor(c) ? "#FFFFFF" : c,
          `600 ${fontSize}px Inter, Segoe UI, sans-serif`
        );
      } else if (t === "polygon") {
        const points = this.arr(el.points).map((p) => this.obj(p)).map((p) => ({ x: this.x(this.num(p, ["x"], 0)), y: this.y(this.num(p, ["y"], 0)) }));
        if (points.length >= 3) {
          this.ctx.beginPath();
          this.ctx.moveTo(points[0].x, points[0].y);
          for (let i = 1; i < points.length; i += 1) this.ctx.lineTo(points[i].x, points[i].y);
          this.ctx.closePath();
          this.ctx.fill();
        }
      } else if (t === "path") {
        const points = this.arr(el.points).map((p) => this.obj(p)).map((p) => ({ x: this.x(this.num(p, ["x"], 0)), y: this.y(this.num(p, ["y"], 0)) }));
        if (points.length >= 2) {
          this.ctx.beginPath();
          this.ctx.moveTo(points[0].x, points[0].y);
          for (let i = 1; i < Math.ceil(points.length * Math.max(0.04, s.drawProgress)); i += 1) {
            this.ctx.lineTo(points[i].x, points[i].y);
          }
          this.ctx.stroke();
        }
      } else if (t === "grid") {
        const spacing = this.px(this.num(el, ["spacing"], 6));
        for (let gx = x; gx <= x + w; gx += spacing) { this.ctx.beginPath(); this.ctx.moveTo(gx, y); this.ctx.lineTo(gx, y + h); this.ctx.stroke(); }
        for (let gy = y; gy <= y + h; gy += spacing) { this.ctx.beginPath(); this.ctx.moveTo(x, gy); this.ctx.lineTo(x + w, gy); this.ctx.stroke(); }
      } else if (t === "axis") {
        this.axis(el, x, y, w, h, c);
      } else if (t === "wave") {
        this.wave(el, x, y, w, h, c, s.drawProgress, lineWidth);
      } else if (t === "pulse") {
        const loop = ((elapsed % 1200) + 1200) % 1200 / 1200;
        this.ctx.globalAlpha = Math.max(0.1, 1 - loop);
        this.ctx.beginPath();
        this.ctx.arc(x, y, r * (0.4 + loop), 0, Math.PI * 2);
        this.ctx.stroke();
      } else if (t === "matrix") {
        this.matrix(el, x, y, w, h, c);
      } else if (t === "number_line") {
        this.numberLine(el, x, y, w, c);
      } else if (t === "table") {
        this.table(el, x, y, w, h, c);
      } else if (t === "stack") {
        this.stack(el, x, y, w, h, c);
      } else if (t === "queue") {
        this.queue(el, x, y, w, h, c);
      } else if (t === "neural_layer") {
        this.neuralLayer(el, x, y, w, h, c);
      } else if (t === "neural_network") {
        this.neuralNetwork(el, x, y, w, h, c, s.highlight > 0 || s.scale !== 1);
      } else if (t === "tree_node") {
        this.treeNodeRecursive(el, x, y, w, h, r, c);
      }
    });
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    this.ctx.beginPath();
    this.ctx.moveTo(x + r, y);
    this.ctx.lineTo(x + w - r, y);
    this.ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    this.ctx.lineTo(x + w, y + h - r);
    this.ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    this.ctx.lineTo(x + r, y + h);
    this.ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    this.ctx.lineTo(x, y + r);
    this.ctx.quadraticCurveTo(x, y, x + r, y);
    this.ctx.closePath();
  }

  private arrowHead(x1: number, y1: number, x2: number, y2: number, c: string, size: number): void {
    const a = Math.atan2(y2 - y1, x2 - x1);
    this.ctx.fillStyle = c;
    this.ctx.beginPath();
    this.ctx.moveTo(x2, y2);
    this.ctx.lineTo(x2 - size * Math.cos(a - Math.PI / 6), y2 - size * Math.sin(a - Math.PI / 6));
    this.ctx.lineTo(x2 - size * Math.cos(a + Math.PI / 6), y2 - size * Math.sin(a + Math.PI / 6));
    this.ctx.closePath();
    this.ctx.fill();
  }

  private pointAt(x1: number, y1: number, x2: number, y2: number, p: number): { x: number; y: number } {
    return { x: x1 + (x2 - x1) * p, y: y1 + (y2 - y1) * p };
  }

  private quad(t: number, x1: number, y1: number, cx: number, cy: number, x2: number, y2: number): { x: number; y: number } {
    const nt = 1 - t;
    return { x: nt * nt * x1 + 2 * nt * t * cx + t * t * x2, y: nt * nt * y1 + 2 * nt * t * cy + t * t * y2 };
  }

  private partialQuad(x1: number, y1: number, cx: number, cy: number, x2: number, y2: number, progress: number): void {
    const steps = Math.max(8, Math.round(52 * Math.max(0.02, progress)));
    for (let i = 1; i <= steps; i += 1) {
      const p = this.quad((i / steps) * Math.max(0.02, progress), x1, y1, cx, cy, x2, y2);
      this.ctx.lineTo(p.x, p.y);
    }
  }

  private axis(el: StepElement, x: number, y: number, w: number, h: number, c: string): void {
    const ticks = Math.max(2, Math.round(this.num(el, ["tick_count", "ticks"], 5)));
    const xTitle = this.str(el.x_label, "X");
    const yTitle = this.str(el.y_label, "Y");
    this.ctx.strokeStyle = c;
    this.ctx.beginPath();
    this.ctx.moveTo(x, y + h);
    this.ctx.lineTo(x + w, y + h);
    this.ctx.moveTo(x, y + h);
    this.ctx.lineTo(x, y);
    this.ctx.stroke();
    this.ctx.fillStyle = "#dce8ff";
    this.ctx.font = "500 11px Inter, Segoe UI, sans-serif";
    for (let i = 0; i <= ticks; i += 1) {
      const tx = x + (w * i) / ticks;
      const ty = y + h - (h * i) / ticks;
      this.ctx.beginPath();
      this.ctx.moveTo(tx, y + h);
      this.ctx.lineTo(tx, y + h + 5);
      this.ctx.moveTo(x - 5, ty);
      this.ctx.lineTo(x, ty);
      this.ctx.stroke();
      this.ctx.textAlign = "center";
      this.ctx.fillText(String(i), tx, y + h + 16);
      this.ctx.textAlign = "right";
      this.ctx.fillText(String(i), x - 8, ty + 3);
    }
    this.ctx.textAlign = "center";
    this.ctx.fillText(xTitle, x + w / 2, y + h + 30);
    this.ctx.save();
    this.ctx.translate(x - 28, y + h / 2);
    this.ctx.rotate(-Math.PI / 2);
    this.ctx.textAlign = "center";
    this.ctx.fillText(yTitle, 0, 0);
    this.ctx.restore();
  }

  private wave(el: StepElement, x: number, y: number, w: number, h: number, c: string, progress: number, lineWidth: number): void {
    const x1 = this.x(this.num(el, ["x1"], x));
    const x2 = this.x(this.num(el, ["x2"], x + w));
    const baseY = this.y(this.num(el, ["baseline_y"], y + h / 2));
    const amp = this.px(this.num(el, ["amplitude"], h / 3));
    const freq = Math.max(1, this.num(el, ["frequency"], 2));
    const endX = x1 + (x2 - x1) * Math.max(0.02, progress);
    const seg = (x2 - x1) / (freq * 2);
    this.ctx.strokeStyle = c;
    this.ctx.lineWidth = lineWidth;
    this.ctx.beginPath();
    this.ctx.moveTo(x1, baseY);
    let cur = x1;
    while (cur < endX) {
      const mid = Math.min(cur + seg, endX);
      const next = Math.min(mid + seg, endX);
      this.ctx.quadraticCurveTo(cur + seg / 2, baseY - amp, mid, baseY);
      this.ctx.quadraticCurveTo(mid + seg / 2, baseY + amp, next, baseY);
      cur = next;
    }
    this.ctx.stroke();
  }

  private matrix(el: StepElement, x: number, y: number, w: number, h: number, c: string): void {
    const data = this.arr(el.values).map((r) => this.arr(r));
    const rows = Math.max(2, data.length || Math.round(this.num(el, ["rows"], 3)));
    const cols = Math.max(2, (data[0]?.length ?? 0) || Math.round(this.num(el, ["cols"], 3)));
    const cw = w / cols;
    const ch = h / rows;
    this.ctx.strokeStyle = c;
    this.ctx.fillStyle = "#e9f2ff";
    this.ctx.font = "500 11px Inter, Segoe UI, sans-serif";
    for (let r = 0; r < rows; r += 1) {
      for (let cl = 0; cl < cols; cl += 1) {
        const cx = x + cl * cw;
        const cy = y + r * ch;
        this.ctx.strokeRect(cx, cy, cw, ch);
        const value = data[r]?.[cl];
        if (value !== undefined) {
          this.ctx.textAlign = "center";
          this.ctx.textBaseline = "middle";
          this.ctx.fillText(String(value), cx + cw / 2, cy + ch / 2);
        }
      }
    }
  }

  private numberLine(el: StepElement, x: number, y: number, w: number, c: string): void {
    const ticks = Math.max(2, Math.round(this.num(el, ["tick_count", "ticks"], 8)));
    const start = this.num(el, ["start"], 0);
    const end = this.num(el, ["end"], ticks);
    this.ctx.strokeStyle = c;
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.moveTo(x, y);
    this.ctx.lineTo(x + w, y);
    this.ctx.stroke();
    this.ctx.fillStyle = "#dce8ff";
    this.ctx.font = "500 11px Inter, Segoe UI, sans-serif";
    for (let i = 0; i <= ticks; i += 1) {
      const tx = x + (w * i) / ticks;
      this.ctx.beginPath();
      this.ctx.moveTo(tx, y - 5);
      this.ctx.lineTo(tx, y + 5);
      this.ctx.stroke();
      const value = start + ((end - start) * i) / ticks;
      this.ctx.textAlign = "center";
      this.ctx.fillText(String(Number(value.toFixed(2))), tx, y + 16);
    }
  }

  private table(el: StepElement, x: number, y: number, w: number, h: number, c: string): void {
    const headers = this.arr(el.headers).map((v) => String(v));
    const rows = this.arr(el.rows).map((r) => this.arr(r).map((v) => String(v)));
    const rowCount = Math.max(2, rows.length + 1);
    const colCount = Math.max(2, headers.length || Math.round(this.num(el, ["cols"], 3)));
    const cw = w / colCount;
    const ch = h / rowCount;
    this.ctx.strokeStyle = c;
    this.ctx.font = "500 10px Inter, Segoe UI, sans-serif";
    for (let r = 0; r < rowCount; r += 1) {
      for (let cl = 0; cl < colCount; cl += 1) {
        const cx = x + cl * cw;
        const cy = y + r * ch;
        if (r === 0) {
          this.ctx.fillStyle = this.alphaColor(c, 0.22);
          this.ctx.fillRect(cx, cy, cw, ch);
        }
        this.ctx.strokeRect(cx, cy, cw, ch);
        this.ctx.fillStyle = "#eaf2ff";
        const text = r === 0 ? headers[cl] ?? `H${cl + 1}` : rows[r - 1]?.[cl] ?? "";
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "middle";
        this.ctx.fillText(text.slice(0, 16), cx + cw / 2, cy + ch / 2);
      }
    }
  }

  private stack(el: StepElement, x: number, y: number, w: number, h: number, c: string): void {
    const values = this.arr(el.values).map((v) => String(v));
    const count = Math.max(3, values.length || Math.round(this.num(el, ["count"], 4)));
    const ch = h / count;
    for (let i = 0; i < count; i += 1) {
      const cy = y + h - (i + 1) * ch;
      const top = i === count - 1;
      this.ctx.fillStyle = top ? this.brighten(c, 0.2) : this.alphaColor(c, 0.72);
      this.roundRect(x, cy, w, ch - 2, 6);
      this.ctx.fill();
      this.ctx.strokeStyle = "#d9e9ff";
      this.ctx.strokeRect(x, cy, w, ch - 2);
      this.ctx.fillStyle = "#f4f8ff";
      this.ctx.textAlign = "center";
      this.ctx.textBaseline = "middle";
      this.ctx.fillText((values[i] ?? `Item ${i + 1}`).slice(0, 16), x + w / 2, cy + ch / 2);
      if (top) this.ctx.fillText("TOP", x + w + 24, cy + ch / 2);
    }
  }

  private queue(el: StepElement, x: number, y: number, w: number, h: number, c: string): void {
    const values = this.arr(el.values).map((v) => String(v));
    const count = Math.max(3, values.length || Math.round(this.num(el, ["count"], 5)));
    const cw = w / count;
    for (let i = 0; i < count; i += 1) {
      const cx = x + i * cw;
      this.ctx.fillStyle = this.alphaColor(c, 0.72);
      this.roundRect(cx, y, cw - 2, h, 6);
      this.ctx.fill();
      this.ctx.strokeStyle = "#d9e9ff";
      this.ctx.strokeRect(cx, y, cw - 2, h);
      this.ctx.fillStyle = "#f4f8ff";
      this.ctx.textAlign = "center";
      this.ctx.textBaseline = "middle";
      this.ctx.fillText((values[i] ?? `Q${i + 1}`).slice(0, 12), cx + cw / 2, y + h / 2);
    }
    this.ctx.fillStyle = "#ffd166";
    this.ctx.textAlign = "left";
    this.ctx.fillText("FRONT", x, y - 10);
    this.ctx.textAlign = "right";
    this.ctx.fillText("REAR", x + w, y - 10);
  }

  private neuralLayer(el: StepElement, x: number, y: number, w: number, h: number, c: string): void {
    const count = Math.max(2, Math.round(this.num(el, ["count", "neurons"], 4)));
    const spacing = h / Math.max(1, count - 1);
    const radius = Math.max(6, Math.min(14, w / 3));
    for (let i = 0; i < count; i += 1) {
      const cy = y + i * spacing;
      this.ctx.beginPath();
      this.ctx.fillStyle = this.alphaColor(c, 0.8);
      this.ctx.arc(x + w / 2, cy, radius, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.strokeStyle = "#d8e8ff";
      this.ctx.stroke();
    }
  }

  private neuralNetwork(el: StepElement, x: number, y: number, w: number, h: number, c: string, active: boolean): void {
    const layersRaw = this.arr(el.layers).map((item) => Number(item)).filter((n) => Number.isFinite(n) && n > 0);
    const layers = layersRaw.length >= 2 ? layersRaw : [3, 4, 4, 2];
    const layerGap = layers.length > 1 ? w / (layers.length - 1) : 0;
    const radius = Math.max(5, Math.min(14, Math.min(w, h) / 30));
    const nodePositions: Array<Array<{ x: number; y: number }>> = [];
    const activeLayers = new Set(this.arr(el.active_layers).map((v) => Number(v)).filter((n) => Number.isFinite(n)));

    for (let layerIdx = 0; layerIdx < layers.length; layerIdx += 1) {
      const count = Math.max(1, Math.round(layers[layerIdx]));
      const xPos = x + layerIdx * layerGap;
      const layerTop = y + 14;
      const layerBottom = y + h - 18;
      const span = Math.max(1, layerBottom - layerTop);
      const spacing = count === 1 ? 0 : span / (count - 1);
      const nodes: Array<{ x: number; y: number }> = [];
      for (let nodeIdx = 0; nodeIdx < count; nodeIdx += 1) {
        const yPos = count === 1 ? y + h / 2 : layerTop + nodeIdx * spacing;
        nodes.push({ x: xPos, y: yPos });
      }
      nodePositions.push(nodes);
    }

    this.ctx.strokeStyle = this.alphaColor(c, active ? 0.9 : 0.35);
    this.ctx.lineWidth = active ? 1.8 : 1.2;
    for (let i = 0; i < nodePositions.length - 1; i += 1) {
      for (const from of nodePositions[i]) {
        for (const to of nodePositions[i + 1]) {
          this.ctx.beginPath();
          this.ctx.moveTo(from.x, from.y);
          this.ctx.lineTo(to.x, to.y);
          this.ctx.stroke();
        }
      }
    }

    for (let i = 0; i < nodePositions.length; i += 1) {
      for (const node of nodePositions[i]) {
        const layerActive = active || activeLayers.has(i);
        this.ctx.beginPath();
        this.ctx.fillStyle = layerActive ? this.brighten(c, 0.22) : this.alphaColor(c, 0.82);
        this.ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.strokeStyle = "#d8e8ff";
        this.ctx.stroke();
      }
      const layerName =
        i === 0 ? "Input Layer" : i === nodePositions.length - 1 ? "Output Layer" : "Hidden Layer";
      this.drawTextPill(layerName, x + i * layerGap, y - 12, "center", "#FFFFFF", "600 11px Inter, Segoe UI, sans-serif");
    }
  }

  private treeNodeRecursive(el: StepElement, x: number, y: number, w: number, h: number, r: number, c: string): void {
    const buildNode = (nodeLike: unknown): { value: string; children: Array<any>; x: number; depth: number } => {
      const o = this.obj(nodeLike);
      return {
        value: this.str(o.value, this.str(o.label, "N")),
        children: this.arr(o.children).map((child) => buildNode(child)),
        x: 0,
        depth: 0
      };
    };

    const root = buildNode(el);
    let leaf = 0;
    const assign = (node: { children: Array<any>; x: number; depth: number }, depth: number): void => {
      node.depth = depth;
      if (!node.children.length) {
        node.x = leaf;
        leaf += 1;
        return;
      }
      for (const child of node.children) assign(child, depth + 1);
      node.x = node.children.reduce((sum, child) => sum + child.x, 0) / node.children.length;
    };
    assign(root, 0);

    const maxDepth = (node: { children: Array<any>; depth: number }): number =>
      node.children.length ? Math.max(node.depth, ...node.children.map((child) => maxDepth(child))) : node.depth;
    const depthMax = Math.max(1, maxDepth(root));
    const leaves = Math.max(1, leaf - 1);
    const nodeRadius = Math.max(8, r);
    const levelHeight = h / depthMax;

    const toScreen = (node: { x: number; depth: number }): { x: number; y: number } => ({
      x: x + (leaves === 0 ? w / 2 : (node.x / leaves) * w),
      y: y + (node.depth / depthMax) * h
    });

    const drawEdges = (node: { children: Array<any>; x: number; depth: number }) => {
      const parent = toScreen(node);
      for (const child of node.children) {
        const childPos = toScreen(child);
        const midY = parent.y + levelHeight / 2;
        this.ctx.strokeStyle = "#99b7e8";
        this.ctx.beginPath();
        this.ctx.moveTo(parent.x, parent.y + nodeRadius);
        this.ctx.lineTo(parent.x, midY);
        this.ctx.lineTo(childPos.x, midY);
        this.ctx.lineTo(childPos.x, childPos.y - nodeRadius);
        this.ctx.stroke();
        drawEdges(child);
      }
    };

    const drawNodes = (node: { value: string; children: Array<any>; x: number; depth: number }) => {
      const p = toScreen(node);
      this.ctx.beginPath();
      this.ctx.fillStyle = c;
      this.ctx.arc(p.x, p.y, nodeRadius, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.fillStyle = "#f4f8ff";
      this.ctx.textAlign = "center";
      this.ctx.textBaseline = "middle";
      this.ctx.font = "600 11px Inter, Segoe UI, sans-serif";
      this.ctx.fillText(node.value.slice(0, 8), p.x, p.y);
      for (const child of node.children) drawNodes(child);
    };

    drawEdges(root);
    drawNodes(root);
  }

  private easeOutBack(t: number): number {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }
}
