type ProgressFormat = {
  label: string;
  current: number;
  total: number;
  elapsedMs: number;
  detail?: string;
  done?: boolean;
  failed?: boolean;
  barWidth?: number;
  color?: boolean;
};

function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const value = Math.round(seconds);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainder = value % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function paint(value: string, code: number, enabled: boolean): string {
  return enabled ? `\u001b[${code}m${value}\u001b[0m` : value;
}

export function formatProgress(options: ProgressFormat): string {
  const total = Math.max(0, options.total);
  const current = Math.max(0, Math.min(options.current, total || options.current));
  const ratio = total > 0 ? Math.min(1, current / total) : 1;
  const width = Math.max(8, options.barWidth ?? 24);
  const filled = Math.min(width, Math.floor(ratio * width));
  const head = filled < width && current > 0 ? "╸" : "";
  const bar = "━".repeat(filled) + head + "─".repeat(Math.max(0, width - filled - head.length));
  const percent = `${Math.round(ratio * 100)}%`.padStart(4);
  const count = total > 0 ? `${Math.round(current)}/${Math.round(total)}` : `${Math.round(current)}`;
  const elapsed = duration(options.elapsedMs / 1000);
  const etaSeconds = current > 0 && current < total ? (options.elapsedMs / 1000) * (total - current) / current : 0;
  const eta = current > 0 && current < total ? ` 余 ${duration(etaSeconds)}` : "";
  const icon = options.failed ? paint("✗", 31, Boolean(options.color)) : options.done ? paint("✓", 32, Boolean(options.color)) : paint("●", 36, Boolean(options.color));
  const coloredBar = paint(bar, options.failed ? 31 : options.done ? 32 : 36, Boolean(options.color));
  const detail = options.detail ? `  ${options.detail}` : "";
  return `${icon} ${options.label.padEnd(4, "　")} ${coloredBar} ${percent}  ${count}  ${elapsed}${eta}${detail}`;
}

export class ProgressBar {
  private current: number;
  private readonly startedAt = Date.now();
  private lastRenderedAt = 0;
  private lastBucket = -1;

  constructor(
    private readonly label: string,
    private readonly total: number,
    initial = 0,
    private readonly stream: NodeJS.WriteStream = process.stdout,
  ) {
    this.current = initial;
    this.render(undefined, true);
  }

  update(current: number, detail?: string, force = false): void {
    this.current = current;
    this.render(detail, force);
  }

  finish(detail?: string): void {
    this.current = this.total;
    this.render(detail, true, true);
  }

  fail(detail?: string): void {
    this.render(detail, true, false, true);
  }

  private render(detail?: string, force = false, done = false, failed = false): void {
    const now = Date.now();
    const ratio = this.total > 0 ? Math.min(1, this.current / this.total) : 1;
    const bucket = Math.floor(ratio * 20);
    const interactive = Boolean(this.stream.isTTY);
    if (!force && interactive && now - this.lastRenderedAt < 80) return;
    if (!force && !interactive && bucket === this.lastBucket) return;
    this.lastRenderedAt = now;
    this.lastBucket = bucket;
    const terminalWidth = interactive ? this.stream.columns ?? 100 : 100;
    const barWidth = Math.max(10, Math.min(30, terminalWidth - 66));
    const line = formatProgress({
      label: this.label,
      current: this.current,
      total: this.total,
      elapsedMs: now - this.startedAt,
      detail,
      done,
      failed,
      barWidth,
      color: interactive && !process.env.NO_COLOR,
    });
    if (interactive) this.stream.write(`\r\u001b[2K${line}${done || failed ? "\n" : ""}`);
    else this.stream.write(`${line}\n`);
  }
}
