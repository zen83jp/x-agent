/**
 * 投稿日の暦情報（曜日・祝日・月末/月初・連休明け）。greeting の一言を日付に合わせるために post_writer に渡す。
 *
 * 祝日は内閣府の「国民の祝日」に基づく。毎年2月の官報で翌年の春分・秋分が確定するので、年1回この表を更新すること。
 * 2027年の春分の日・秋分の日は予測値（官報公示前）。
 */
const HOLIDAYS: Record<string, string> = {
  "2026-01-01": "元日",
  "2026-01-12": "成人の日",
  "2026-02-11": "建国記念の日",
  "2026-02-23": "天皇誕生日",
  "2026-03-20": "春分の日",
  "2026-04-29": "昭和の日",
  "2026-05-03": "憲法記念日",
  "2026-05-04": "みどりの日",
  "2026-05-05": "こどもの日",
  "2026-05-06": "振替休日",
  "2026-07-20": "海の日",
  "2026-08-11": "山の日",
  "2026-09-21": "敬老の日",
  "2026-09-22": "国民の休日",
  "2026-09-23": "秋分の日",
  "2026-10-12": "スポーツの日",
  "2026-11-03": "文化の日",
  "2026-11-23": "勤労感謝の日",
  "2027-01-01": "元日",
  "2027-01-11": "成人の日",
  "2027-02-11": "建国記念の日",
  "2027-02-23": "天皇誕生日",
  "2027-03-21": "春分の日",
  "2027-03-22": "振替休日",
  "2027-04-29": "昭和の日",
  "2027-05-03": "憲法記念日",
  "2027-05-04": "みどりの日",
  "2027-05-05": "こどもの日",
  "2027-07-19": "海の日",
  "2027-08-11": "山の日",
  "2027-09-20": "敬老の日",
  "2027-09-23": "秋分の日",
  "2027-10-11": "スポーツの日",
  "2027-11-03": "文化の日",
  "2027-11-23": "勤労感謝の日",
};

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 年末年始（12/29〜1/3）は祝日表になくても休みとして扱う */
function isYearEndBreak(date: string): boolean {
  const md = date.slice(5);
  return md >= "12-29" || md <= "01-03";
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function holidayName(date: string): string | null {
  return HOLIDAYS[date] ?? (isYearEndBreak(date) ? "年末年始" : null);
}

export function isDayOff(date: string): boolean {
  const w = weekday(date);
  return w === 0 || w === 6 || holidayName(date) !== null;
}

export function hasHolidayData(date: string): boolean {
  return Object.keys(HOLIDAYS).some((d) => d.startsWith(date.slice(0, 4)));
}

/** JST の日付文字列（YYYY-MM-DD） */
export function jstDateOf(now: Date): string {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

export type DayContext = {
  date: string;
  weekday: string;
  holiday: string | null;
  dayOff: boolean;
  monthStart: boolean;
  monthEnd: boolean;
  /** 3日以上の休み（土日を含む）の翌営業日 */
  afterLongBreak: boolean;
  /** 休み明け（週明けを含む）の初日 */
  firstWorkdayAfterBreak: boolean;
  /** 翌日が休み（週末・祝日の前） */
  beforeBreak: boolean;
  /** 祝日表がない年（表の更新漏れ） */
  holidayDataMissing: boolean;
};

export function dayContext(date: string): DayContext {
  const dayOff = isDayOff(date);
  let breakDays = 0;
  for (let d = addDays(date, -1); isDayOff(d) && breakDays < 14; d = addDays(d, -1)) breakDays++;
  return {
    date,
    weekday: WEEKDAYS[weekday(date)]!,
    holiday: holidayName(date),
    dayOff,
    monthStart: date.endsWith("-01"),
    monthEnd: addDays(date, 1).endsWith("-01"),
    afterLongBreak: !dayOff && breakDays >= 3,
    firstWorkdayAfterBreak: !dayOff && breakDays >= 1,
    beforeBreak: !dayOff && isDayOff(addDays(date, 1)),
    holidayDataMissing: !hasHolidayData(date),
  };
}

/** post_writer に渡す1行の説明 */
export function describeDay(c: DayContext): string {
  const parts = [`${c.date.slice(5).replace("-", "/")}（${c.weekday}）`];
  if (c.holiday) parts.push(`祝日・休み: ${c.holiday}`);
  else if (c.dayOff) parts.push("休日");
  if (c.monthStart) parts.push("月初");
  if (c.monthEnd) parts.push("月末");
  if (c.afterLongBreak) parts.push("連休明け");
  else if (c.firstWorkdayAfterBreak) parts.push("週明け・休み明け");
  if (c.beforeBreak) parts.push("休み前の最終日");
  return parts.join(" / ");
}
