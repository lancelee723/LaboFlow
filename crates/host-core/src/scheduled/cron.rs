//! LaboFlow module 03 (R5-1): 5-field cron expressions for scheduled tasks.
//!
//! SPEC §3.2: parse/next-run are pure functions here; trigger ticks and
//! catch-up decisions stay in `automation` (main-process driven). Semantics
//! follow the frozen-repo croner behaviour: minute(0-59) hour(0-23)
//! day-of-month(1-31) month(1-12) day-of-week(0-7, 0 and 7 = Sunday);
//! `*`, `,`, `-`, `*/n`, `a-b/n`, `a/n`; when both day-of-month and
//! day-of-week are restricted the task runs on the UNION (standard cron OR).

use anyhow::{bail, Result};
use chrono::{Datelike, TimeZone, Timelike};

const MINUTES: u32 = 60;
const HOURS: u32 = 24;
const DAYS_IN_MONTH_MAX: u32 = 31;
const MONTHS: u32 = 12;
const WEEKDAYS: u32 = 7; // 0..=6, Sunday normalised to 0

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronSpec {
    pub minutes: Vec<u32>,
    pub hours: Vec<u32>,
    pub days_of_month: Vec<u32>,
    pub months: Vec<u32>,
    pub days_of_week: Vec<u32>,
    /// True when day-of-month is restricted (not `*`).
    pub dom_restricted: bool,
    /// True when day-of-week is restricted (not `*`).
    pub dow_restricted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronError {
    /// 0-based field position (0=minute .. 4=dow).
    pub field: usize,
    pub reason: String,
}

impl std::fmt::Display for CronError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "cron field {}: {}", self.field + 1, self.reason)
    }
}

impl std::error::Error for CronError {}

/// Parse a 5-field cron expression into a validated spec.
pub fn parse(expr: &str) -> Result<CronSpec> {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        bail!(CronError {
            field: fields.len().min(4),
            reason: format!("expected 5 fields, got {}", fields.len()),
        });
    }
    let minutes = parse_field(fields[0], MINUTES - 1, 0)?;
    let hours = parse_field(fields[1], HOURS - 1, 0)?;
    let (days_of_month, dom_star) = parse_day_field(fields[2], DAYS_IN_MONTH_MAX, 1)?;
    let months = parse_field(fields[3], MONTHS, 1)?;
    let (days_of_week_raw, dow_star) = parse_day_field(fields[4], 7, 0)?;
    // Normalise Sunday: 7 -> 0.
    let mut days_of_week: Vec<u32> = days_of_week_raw.iter().map(|d| d % 7).collect();
    days_of_week.sort_unstable();
    days_of_week.dedup();
    Ok(CronSpec {
        minutes,
        hours,
        days_of_month,
        months,
        days_of_week,
        dom_restricted: !dom_star,
        dow_restricted: !dow_star,
    })
}

fn parse_field(field: &str, max: u32, min: u32) -> Result<Vec<u32>> {
    let (values, is_star) = parse_values(field, max, min)?;
    if is_star && values.len() == max as usize {
        return Ok(Vec::new()); // `*` and explicit full ranges collapse to "any"
    }
    Ok(values)
}

/// Day fields: `*` (or `*/n`) means unrestricted; the caller needs to know.
fn parse_day_field(field: &str, max: u32, min: u32) -> Result<(Vec<u32>, bool)> {
    let trimmed = field.trim();
    if trimmed == "*" || trimmed.starts_with("*/") {
        return Ok((Vec::new(), true));
    }
    let (values, _) = parse_values(trimmed, max, min)?;
    Ok((values, false))
}

/// Test helper: parse then next_after in the local zone.
#[cfg(test)]
pub(crate) fn next_after_str(expr: &str, after_ms: i64) -> Option<i64> {
    parse(expr).ok()?.next_after(after_ms, &chrono::Local)
}

fn parse_values(field: &str, max: u32, min: u32) -> Result<(Vec<u32>, bool)> {
    let mut out = Vec::new();
    let mut saw_star = false;
    for part in field.split(',') {
        if part.is_empty() {
            bail!(CronError { field: 0, reason: "empty list item".into() });
        }
        let (range, step) = match part.split_once('/') {
            Some((range, step_text)) => {
                let step: u32 = step_text.parse().map_err(|_| CronError {
                    field: 0,
                    reason: format!("invalid step '{step_text}'"),
                })?;
                if step == 0 {
                    return Err(CronError { field: 0, reason: "step must be >= 1".into() }.into());
                }
                (range, step)
            }
            None => (part, 1u32),
        };
        let (start, end) = if range == "*" {
            saw_star = saw_star || step == 1;
            (min, max)
        } else if let Some((a, b)) = range.split_once('-') {
            let start: u32 = a.trim().parse().map_err(|_| CronError {
                field: 0,
                reason: format!("invalid range start '{a}'"),
            })?;
            let end: u32 = b.trim().parse().map_err(|_| CronError {
                field: 0,
                reason: format!("invalid range end '{b}'"),
            })?;
            if start < min || end < min || start > max || end > max {
                bail!(CronError { field: 0, reason: format!("value out of range {min}-{max}") });
            }
            if start > end {
                bail!(CronError { field: 0, reason: format!("reversed range {a}-{b}") });
            }
            (start, end)
        } else {
            let value: u32 = range.parse().map_err(|_| CronError {
                field: 0,
                reason: format!("invalid value '{range}'"),
            })?;
            if value < min || value > max {
                bail!(CronError { field: 0, reason: format!("value out of range {min}-{max}") });
            }
            if step == 1 {
                out.push(value);
                continue;
            }
            (value, max)
        };
        let mut value = start;
        while value <= end {
            out.push(value);
            value += step;
        }
    }
    out.sort_unstable();
    out.dedup();
    if out.is_empty() {
        bail!(CronError { field: 0, reason: "no values matched".into() });
    }
    Ok((out, saw_star))
}

impl CronSpec {
    /// Whether the spec matches the given local date. An empty field list
    /// means "any" (`*` collapses to empty in `parse_field`).
    fn matches_date(&self, date: chrono::NaiveDate) -> bool {
        if !self.months.is_empty() && !self.months.contains(&(date.month())) {
            return false;
        }
        let dom_match = self.days_of_month.contains(&date.day());
        // chrono: Sunday=6 .. Saturday=5 onnumap; cron: 0=Sunday.
        let cron_dow = date.weekday().num_days_from_sunday();
        let dow_match = self.days_of_week.contains(&cron_dow);
        if self.dom_restricted && self.dow_restricted {
            dom_match || dow_match // union per standard cron
        } else {
            (self.days_of_month.is_empty() || dom_match)
                && (self.days_of_week.is_empty() || dow_match)
        }
    }

    fn matches_time(&self, time: chrono::NaiveTime) -> bool {
        (self.hours.is_empty() || self.hours.contains(&time.hour()))
            && (self.minutes.is_empty() || self.minutes.contains(&time.minute()))
    }

    /// Next matching local timestamp strictly after `after_ms` (epoch ms).
    /// Scans day by day (bounded at ~3 years) then picks the first matching
    /// minute within the day — efficient and exhaustive for real schedules.
    pub fn next_after<T: TimeZone>(&self, after_ms: i64, zone: &T) -> Option<i64> {
        let from = zone.timestamp_millis_opt(after_ms).single()?;
        let mut day = from.date_naive();
        // First candidate day: today (later minutes still possible).
        for _ in 0..(366 * 3) {
            if self.matches_date(day) {
                if let Some(midnight) = day
                    .and_hms_opt(0, 0, 0)
                    .and_then(|t| zone.from_local_datetime(&t).single())
                {
                    let _ = midnight;
                    let from_minute = if day == from.date_naive() {
                        from.hour() * 60 + from.minute()
                    } else {
                        0
                    };
                    let mut minute: i64 = from_minute as i64 + 1;
                    while minute < MINUTES as i64 * HOURS as i64 {
                        let hour = (minute / 60) as u32;
                        let minute_of_hour = (minute % 60) as u32;
                        if self.hours.contains(&hour) && self.minutes.contains(&minute_of_hour) {
                            let candidate = day
                                .and_hms_opt(hour, minute_of_hour, 0)
                                .and_then(|t| zone.from_local_datetime(&t).single())?;
                            if candidate.timestamp_millis() > after_ms {
                                return Some(candidate.timestamp_millis());
                            }
                        }
                        minute += 1;
                    }
                }
            }
            day += chrono::Duration::days(1);
        }
        None
    }

    /// The most recent matching timestamp at or before `before_ms` (exclusive),
    /// bounded by `lookback_ms` of minute scanning. Used by catch-up decisions.
    pub fn last_before<T: TimeZone>(&self, before_ms: i64, lookback_ms: i64, zone: &T) -> Option<i64> {
        let before = zone.timestamp_millis_opt(before_ms).single()?;
        let mut day = before.date_naive();
        let floor = before_ms.saturating_sub(lookback_ms);
        for _ in 0..(lookback_ms / 86_400_000 + 2) {
            if self.matches_date(day) {
                if let Some(midnight) = zone
                    .from_local_datetime(&day.and_hms_opt(0, 0, 0)?)
                    .single()
                {
                    let last_minute_of_day: i64 = if day == before.date_naive() {
                        i64::from(before.hour()) * 60 + i64::from(before.minute())
                    } else {
                        i64::from(MINUTES) * i64::from(HOURS) - 1
                    };
                    let mut minute: i64 = last_minute_of_day;
                    while minute >= 0 {
                        let hour = (minute / 60) as u32;
                        let minute_of_hour = (minute % 60) as u32;
                        if self.hours.contains(&hour) && self.minutes.contains(&minute_of_hour) {
                            let candidate = day
                                .and_hms_opt(hour, minute_of_hour, 0)
                                .and_then(|t| zone.from_local_datetime(&t).single())?;
                            let ms = candidate.timestamp_millis();
                            if ms < before_ms && ms >= floor {
                                return Some(ms);
                            }
                            if ms < floor {
                                return None;
                            }
                        }
                        minute -= 1;
                    }
                }
            }
            day -= chrono::Duration::days(1);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Local;

    fn next(expr: &str, after_ms: i64) -> Option<i64> {
        parse(expr).ok()?.next_after(after_ms, &Local)
    }

    #[test]
    fn parses_lists_ranges_steps_and_normalises_sunday() {
        let spec = parse("0 9 * * 1-5").unwrap();
        assert_eq!(spec.hours, vec![9]);
        assert_eq!(spec.days_of_week, vec![1, 2, 3, 4, 5]);
        let spec = parse("*/15 0 * * 0").unwrap();
        assert_eq!(spec.minutes, vec![0, 15, 30, 45]);
        assert!(spec.days_of_week.contains(&0));
        // 7 normalises to Sunday (0) alongside an explicit 0.
        let spec = parse("0 0 * * 0,7").unwrap();
        assert_eq!(spec.days_of_week, vec![0]);
    }

    #[test]
    fn rejects_out_of_range_reversed_and_malformed() {
        for expr in ["70 * * * *", "* 25 * * *", "* * 0 * *", "* * 32 * *", "* * * 13 *", "0 0 * * 8", "5-1 * * * *", "*/0 * * * *", "0 0 * *", "* * * * * *"] {
            assert!(parse(expr).is_err(), "should reject: {expr}");
        }
        let err = parse("70 * * * *").unwrap_err().downcast::<CronError>().unwrap();
        assert!(err.reason.contains("out of range"));
        let err = parse("5-1 * * * *").unwrap_err().downcast::<CronError>().unwrap();
        assert!(err.reason.contains("reversed"));
    }

    #[test]
    fn next_after_honours_the_next_matching_minute() {
        // 2026-09-30 is a Wednesday (local). Pick the next 9:00 after midnight.
        let after = Local
            .with_ymd_and_hms(2026, 9, 30, 0, 0, 0)
            .unwrap()
            .timestamp_millis();
        let next = super::next_after_str("0 9 * * *", after).unwrap();
        let at = Local.timestamp_millis_opt(next).single().unwrap();
        assert_eq!((at.year(), at.month(), at.day(), at.hour(), at.minute()), (2026, 9, 30, 9, 0));
        // 9:00 again is strictly later.
        assert!(super::next_after_str("0 9 * * *", next).unwrap() > next);
    }

    #[test]
    fn dom_and_dow_restricted_run_on_the_union() {
        // 2026-09-30 (Wed) .. 2026-10-01 (Thu): dom=1 fires on the 1st even
        // though dow=Wednesday (2) does not match the 1st.
        let after = Local
            .with_ymd_and_hms(2026, 9, 30, 12, 0, 0)
            .unwrap()
            .timestamp_millis();
        let next = super::next_after_str("0 12 1 * 2", after).unwrap();
        let at = Local.timestamp_millis_opt(next).single().unwrap();
        assert_eq!((at.day(), at.hour()), (1, 12));
    }

    #[test]
    fn last_before_finds_the_most_recent_occurrence() {
        let before = Local
            .with_ymd_and_hms(2026, 9, 30, 10, 0, 0)
            .unwrap()
            .timestamp_millis();
        let spec = parse("0 9 * * *").unwrap();
        let last = spec.last_before(before, 7 * 86_400_000, &Local).unwrap();
        let at = Local.timestamp_millis_opt(last).single().unwrap();
        assert_eq!((at.day(), at.hour()), (30, 9));
    }
}
