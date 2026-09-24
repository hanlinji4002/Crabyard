// Pure formatting helpers for the sidebar's 对话 and Usage views.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "刚刚" / "5 分钟前" / "昨天" style label; falls back to a short date after a week. */
export function formatRelativeTime(ts: number, now: number, locale: string): string {
  const diff = now - ts;
  if (diff < MINUTE) return locale.startsWith('zh') ? '刚刚' : 'just now';
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  if (diff < HOUR) return rtf.format(-Math.floor(diff / MINUTE), 'minute');
  if (diff < DAY) return rtf.format(-Math.floor(diff / HOUR), 'hour');
  if (diff < 7 * DAY) return rtf.format(-Math.floor(diff / DAY), 'day');
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(locale, sameYear
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * When a plan usage window resets: "2小时52分后重置" / "Resets in 2h 52m"
 * inside a day, else "周三 08:00 重置" / "Resets Wed 8:00 AM".
 */
export function formatResetTime(resetsAt: number, now: number, locale: string): string {
  const zh = locale.startsWith('zh');
  const diff = resetsAt - now;
  if (diff <= 0) return zh ? '已重置' : 'Reset';
  if (diff < DAY) {
    const minutes = Math.max(1, Math.floor(diff / MINUTE));
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    // No spaces in the Chinese forms: they have to fit a narrow ring column.
    if (zh) return h === 0 ? `${m}分钟后重置` : m === 0 ? `${h}小时后重置` : `${h}小时${m}分后重置`;
    return h === 0 ? `Resets in ${m}m` : m === 0 ? `Resets in ${h}h` : `Resets in ${h}h ${m}m`;
  }
  const date = new Date(resetsAt);
  if (zh) {
    const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(date);
    const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
    return `${weekday} ${time} 重置`;
  }
  return `Resets ${new Intl.DateTimeFormat(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(date)}`;
}

/** 950 → "950", 12_300 → "12.3K", 4_500_000 → "4.5M", 3.4e9 → "3.4B". */
export function formatTokens(n: number): string {
  const abs = Math.abs(n);
  const fmt = (v: number, suffix: string) => `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')}${suffix}`;
  if (abs >= 1e9) return fmt(n / 1e9, 'B');
  if (abs >= 1e6) return fmt(n / 1e6, 'M');
  if (abs >= 1e3) return fmt(n / 1e3, 'K');
  return String(Math.round(n));
}

/** "$0.42", "$12.30", "$1,234" (no cents once the total reaches four digits). */
export function formatUsd(n: number): string {
  if (n > 0 && n < 0.01) return '<$0.01';
  const digits = Math.abs(n) >= 1000 ? 0 : 2;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Local YYYY-MM-DD for `ts`, matching the main process's usage buckets. */
export function localDateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The `count` local date keys ending today, oldest first. */
export function lastNDays(count: number, now: number): string[] {
  const out: string[] = [];
  const base = new Date(now);
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i);
    out.push(localDateKey(d.getTime()));
  }
  return out;
}

/** Compare filesystem paths ignoring a trailing separator. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p);
  return norm(a) === norm(b);
}

/** Shorten the home-directory prefix to `~`, the way a shell prompt shows it. */
export function tildePath(p: string): string {
  return p.replace(/^(?:\/(?:Users|home)\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[\\/]|$)/, '~');
}
