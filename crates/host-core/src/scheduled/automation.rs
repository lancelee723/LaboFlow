use anyhow::{bail, Result};
use rusqlite::params;
use serde_json::{json, Value};

use super::{get_task, timing::Schedule};
use crate::db::{ts_to_ms, now_ms, Database};

const TASK_PERMISSION_MODES: [&str; 3] = ["ask", "accept-edits", "auto"];

pub fn validate_execution_input(input: &Value) -> Result<()> {
    if let Some(value) = input.get("thinkingLevel") {
        if !value.is_null()
            && !value
                .as_str()
                .is_some_and(crate::sessions::is_valid_thinking_level)
        {
            bail!("thinkingLevel must be a supported session thinking level or null");
        }
    }
    if let Some(value) = input.get("permissionMode") {
        if !value.is_null()
            && !value
                .as_str()
                .is_some_and(|mode| TASK_PERMISSION_MODES.contains(&mode))
        {
            bail!("permissionMode must be ask, accept-edits, auto, or null");
        }
    }
    let provider = input.get("providerId");
    let model = input.get("modelId");
    if provider.is_some() || model.is_some() {
        let paired_null = provider.is_some_and(Value::is_null) && model.is_some_and(Value::is_null);
        let paired_text = provider
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty() && value.chars().count() <= 256)
            && model
                .and_then(Value::as_str)
                .is_some_and(|value| !value.trim().is_empty() && value.chars().count() <= 256);
        if !paired_null && !paired_text {
            bail!("providerId and modelId must be nonempty strings together, or both null");
        }
    }
    Ok(())
}

pub(crate) fn configure_execution(config: &mut Value, input: &Value) {
    let object = config
        .as_object_mut()
        .expect("scheduled task config is an object");
    if let Some(level) = input.get("thinkingLevel") {
        if level.is_null() {
            object.remove("thinkingLevel");
        } else {
            object.insert("thinkingLevel".into(), level.clone());
        }
    }
    if let Some(value) = input.get("permissionMode") {
        if value.is_null() {
            object.remove("permissionMode");
        } else if let Some(mode) = value.as_str() {
            object.insert("permissionMode".into(), json!(mode));
        }
    }
    if input.get("providerId").is_some() || input.get("modelId").is_some() {
        if input.get("providerId").is_some_and(Value::is_null) {
            object.remove("providerId");
            object.remove("modelId");
        } else {
            object.insert("providerId".into(), input["providerId"].clone());
            object.insert("modelId".into(), input["modelId"].clone());
        }
    }
}

pub fn configure(config: &mut Value, input: &Value, cadence: &str, now: i64) -> Result<()> {
    validate_execution_input(input)?;
    configure_execution(config, input);
    if let Some(schedule) = input.get("schedule") {
        let previous = config.get("schedule").cloned();
        if schedule.is_null() {
            config["schedule"] = Value::Null;
            config["calendarConfigured"] = json!(false);
        } else {
            let schedule: Schedule = serde_json::from_value(schedule.clone())?;
            schedule.validate()?;
            config["schedule"] = serde_json::to_value(schedule)?;
            if matches!(cadence, "daily" | "weekly") {
                config["calendarConfigured"] = json!(true);
            } else if previous.as_ref() != config.get("schedule") {
                config["calendarConfigured"] = json!(false);
            }
        }
    }
    // LaboFlow module 03 (R5-1): 5-field cron expression. A non-null cronExpr
    // switches the task to cron scheduling (schedule is cleared); the parsed
    // spec determines nextRunAt directly.
    if let Some(cron_value) = input.get("cronExpr") {
        let expr = cron_value.as_str().map(str::trim).unwrap_or("");
        if expr.is_empty() {
            if let Some(object) = config.as_object_mut() {
                object.remove("cronExpr");
            }
        } else {
            let spec = super::cron::parse(expr)
                .map_err(|e| anyhow::anyhow!("invalid cronExpr: {e}"))?;
            config["cronExpr"] = json!(expr);
            if let Some(object) = config.as_object_mut() {
                object.remove("schedule");
            }
            config["calendarConfigured"] = json!(false);
            config["nextRunAt"] = match spec.next_after(now, &chrono::Local) {
                Some(next) => json!(next),
                None => Value::Null,
            };
        }
    } else if let Some(schedule) = input.get("schedule") {
        // An explicit schedule edit must not leave a stale cronExpr behind.
        if !schedule.is_null() {
            if let Some(object) = config.as_object_mut() {
                object.remove("cronExpr");
            }
        }
    }
    if let Some(workspace) = input.get("workspacePath") {
        if !workspace.is_null() && !workspace.is_string() {
            bail!("workspacePath must be a string or null");
        }
        config["workspacePath"] = json!(workspace
            .as_str()
            .and_then(crate::db::canonical_project_path));
    }
    if input.get("schedule").is_some()
        || input.get("cronExpr").is_some()
        || input.get("cadence").is_some()
        || input.get("enabled").is_some()
    {
        let next = match config.get("cronExpr").and_then(Value::as_str) {
            Some(expr) => super::cron::parse(expr)
                .ok()
                .and_then(|spec| spec.next_after(now, &chrono::Local)),
            None => config
                .get("schedule")
                .and_then(|value| serde_json::from_value::<Schedule>(value.clone()).ok())
                .and_then(|schedule| schedule.next(cadence, now)),
        };
        config["nextRunAt"] = json!(next);
    }
    Ok(())
}

pub fn reschedule(db: &Database, id: &str, now: i64) -> Result<()> {
    let Some(task) = get_task(db, id)? else {
        return Ok(());
    };
    let raw: String = db.conn().query_row(
        "SELECT config_json FROM scheduled_tasks WHERE id = ?1",
        [id],
        |row| row.get(0),
    )?;
    let mut config: Value = serde_json::from_str(&raw)?;
    let next = config
        .get("cronExpr")
        .and_then(Value::as_str)
        .and_then(|expr| super::cron::parse(expr).ok())
        .and_then(|spec| spec.next_after(now, &chrono::Local))
        .or_else(|| {
            task.schedule
                .and_then(|schedule| schedule.next(&task.cadence, now))
        });
    config["nextRunAt"] = json!(next);
    db.conn().execute(
        "UPDATE scheduled_tasks SET config_json = ?1 WHERE id = ?2",
        params![config.to_string(), id],
    )?;
    Ok(())
}

pub fn running(db: &Database, id: &str) -> Result<bool> {
    Ok(db.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM task_runs WHERE task_id = ?1 AND status = 'running')",
        [id],
        |row| row.get(0),
    )?)
}

/// Polling never replays missed occurrences or overlaps an unfinished run.
pub fn due(db: &Database, now: i64) -> Result<Vec<String>> {
    let mut result = Vec::new();
    for task in super::list_tasks(db)? {
        let Some(next) = task.next_run_at.as_deref().map(crate::db::ts_to_ms) else {
            continue;
        };
        let is_cron = task.cadence == "cron";
        if !task.enabled
            || (task.schedule.is_none() && !is_cron)
            || task.cadence == "manual"
            || next > now
        {
            continue;
        }
        if now - next > 90_000 || running(db, &task.id)? {
            reschedule(db, &task.id, now)?;
        } else {
            result.push(task.id);
        }
    }
    Ok(result)
}

pub fn recover(db: &Database) -> Result<()> {
    // Database boot maintenance owns interruption of orphaned task_runs.
    // Restart starts from future occurrences; downtime never creates a burst.
    for task in super::list_tasks(db)? {
        if task.cadence == "cron" {
            // LaboFlow R5-1 catch-up: at most the most recent missed
            // occurrence, capped at 24h of downtime, never for a task created
            // less than 5 minutes ago with no runs (first-launch guard).
            catch_up_cron_task(db, &task)?;
            continue;
        }
        if task.schedule.is_some() {
            reschedule(db, &task.id, now_ms())?;
        }
    }
    Ok(())
}

const CATCHUP_LOOKBACK_MS: i64 = 24 * 3_600_000;
const CATCHUP_DELAY_MS: i64 = 60_000;
const FIRST_LAUNCH_GUARD_MS: i64 = 5 * 60_000;

fn catch_up_cron_task(db: &Database, task: &super::ScheduledTask) -> Result<()> {
    let Some(expr) = task
        .cron_expr
        .as_deref()
        .map(str::trim)
        .filter(|expr| !expr.is_empty())
    else {
        // Legacy cron-tagged row without an expression: just reschedule.
        return reschedule(db, &task.id, now_ms());
    };
    let spec = match super::cron::parse(expr) {
        Ok(spec) => spec,
        Err(_) => return reschedule(db, &task.id, now_ms()),
    };
    let now = now_ms();
    let created_ms = ts_to_ms(&task.created_at);
    let last_run_ms = task
        .last_run_at
        .as_deref()
        .map(ts_to_ms)
        .unwrap_or(created_ms);
    let runs = db.conn().query_row(
        "SELECT COUNT(*) FROM task_runs WHERE task_id = ?1",
        [task.id.as_str()],
        |row| row.get::<_, i64>(0),
    )?;
    let first_launch = now - created_ms < FIRST_LAUNCH_GUARD_MS && runs == 0;
    let raw: String = db.conn().query_row(
        "SELECT config_json FROM scheduled_tasks WHERE id = ?1",
        [task.id.as_str()],
        |row| row.get(0),
    )?;
    let mut config: Value = serde_json::from_str(&raw)?;
    let next = spec.next_after(now, &chrono::Local);
    if !first_launch && task.enabled {
        if let Some(missed) = spec.last_before(now, CATCHUP_LOOKBACK_MS, &chrono::Local) {
            if missed > last_run_ms {
                // Most recent missed occurrence is fresh enough: run once,
                // shortly after boot, no matter how many ticks were skipped.
                config["nextRunAt"] = json!(now + CATCHUP_DELAY_MS);
                db.conn().execute(
                    "UPDATE scheduled_tasks SET config_json = ?1 WHERE id = ?2",
                    params![config.to_string(), task.id],
                )?;
                return Ok(());
            }
        }
    }
    config["nextRunAt"] = json!(next);
    db.conn().execute(
        "UPDATE scheduled_tasks SET config_json = ?1 WHERE id = ?2",
        params![config.to_string(), task.id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scheduled::{begin_run, create_task, finish_run, update_task};

    #[test]
    fn legacy_tasks_are_not_armed_and_explicit_schedule_survives_edits() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let task = create_task(&db, &json!({"prompt":"check", "cadence":"daily"})).unwrap();
        assert!(task.schedule.is_none());
        assert!(due(&db, now_ms()).unwrap().is_empty());
        let task = update_task(
            &db,
            &json!({"id":task.id,"schedule":{"hour":9,"minute":0,"weekday":0}}),
        )
        .unwrap()
        .unwrap();
        assert!(task.next_run_at.is_some());
        let edited = update_task(&db, &json!({"id":task.id,"title":"Edited"}))
            .unwrap()
            .unwrap();
        assert_eq!(edited.next_run_at, task.next_run_at);
    }

    #[test]
    fn due_paused_overlap_missed_and_restart_paths() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let task = create_task(&db, &json!({"prompt":"check", "cadence":"hourly", "schedule":{"hour":9,"minute":0,"weekday":0}})).unwrap();
        let at = crate::db::ts_to_ms(task.next_run_at.as_ref().unwrap());
        assert_eq!(due(&db, at).unwrap(), vec![task.id.clone()]);
        let run = begin_run(&db, &task.id, None).unwrap();
        assert!(due(&db, at).unwrap().is_empty());
        finish_run(&db, &run, "completed", None).unwrap();
        assert!(due(&db, at + 3_600_000 + 90_001).unwrap().is_empty());
        update_task(&db, &json!({"id":task.id,"enabled":false})).unwrap();
        assert!(due(&db, at + 10 * 3_600_000).unwrap().is_empty());
        let interrupted = begin_run(&db, &task.id, None).unwrap();
        drop(db);
        let db = Database::open_in_dir(dir.path()).unwrap();
        recover(&db).unwrap();
        assert!(!running(&db, &task.id).unwrap());
        assert_eq!(
            super::super::list_runs(&db, Some(&task.id), 100)
                .unwrap()
                .into_iter()
                .find(|run| run.id == interrupted)
                .unwrap()
                .status,
            "aborted"
        );
    }
}


#[cfg(test)]
mod cron_tests {
    use super::*;
    use crate::scheduled::{begin_run, create_task, finish_run, list_tasks, update_task};

    fn task_by_id(db: &Database, id: &str) -> super::super::ScheduledTask {
        super::super::get_task(db, id).unwrap().unwrap()
    }

    #[test]
    fn cron_create_sets_next_run_and_rejects_bad_expression() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let task = create_task(
            &db,
            &json!({"prompt":"check","cadence":"cron","cronExpr":"*/5 * * * *"}),
        )
        .unwrap();
        assert_eq!(task.cadence, "cron");
        assert_eq!(task.cron_expr.as_deref(), Some("*/5 * * * *"));
        assert!(task.next_run_at.is_some());
        assert!(create_task(
            &db,
            &json!({"prompt":"bad","cadence":"cron","cronExpr":"70 * * * *"})
        )
        .is_err());
        let due_now = due(&db, now_ms()).unwrap();
        // nextRunAt is in the future: not due yet.
        assert!(due_now.is_empty());
    }

    #[test]
    fn cron_task_becomes_due_and_reschedules_after_dispatch_window() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let task = create_task(&db, &json!({"prompt":"check","cadence":"cron","cronExpr":"* * * * *"})).unwrap();
        // Force nextRunAt into the past: the 30s tick window missed it.
        let raw: String = db
            .conn()
            .query_row("SELECT config_json FROM scheduled_tasks WHERE id = ?1", [task.id.as_str()], |r| r.get(0))
            .unwrap();
        let mut config: Value = serde_json::from_str(&raw).unwrap();
        config["nextRunAt"] = json!(now_ms() - 120_000);
        db.conn().execute(
            "UPDATE scheduled_tasks SET config_json = ?1 WHERE id = ?2",
            params![config.to_string(), task.id],
        )
        .unwrap();
        // Within the 90s window it is due...
        let due_ids = due(&db, now_ms() - 100_000).unwrap();
        assert_eq!(due_ids, vec![task.id.clone()]);
        // ...a running run blocks dispatch...
        let run = begin_run(&db, &task.id, None).unwrap();
        assert!(due(&db, now_ms()).unwrap().is_empty());
        finish_run(&db, &run, "completed", None).unwrap();
        // ...and a missed cron occurrence reschedules to the next occurrence
        // (never replays skipped ticks while the app is live).
        let missed = due(&db, now_ms()).unwrap();
        assert!(missed.is_empty());
        let updated = task_by_id(&db, &task.id);
        assert!(updated.next_run_at.is_some());
    }

    #[test]
    fn recover_catches_up_recent_missed_cron_occurrence_once() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        // Created 10 minutes ago with one completed run: catch-up applies.
        let task = create_task(&db, &json!({"prompt":"check","cadence":"cron","cronExpr":"0 9 * * *"})).unwrap();
        let run = begin_run(&db, &task.id, None).unwrap();
        finish_run(&db, &run, "completed", None).unwrap();
        // Make the last run ancient (simulates downtime across the 9:00 tick).
        let raw: String = db
            .conn()
            .query_row("SELECT config_json FROM scheduled_tasks WHERE id = ?1", [task.id.as_str()], |r| r.get(0))
            .unwrap();
        let mut config: Value = serde_json::from_str(&raw).unwrap();
        config["nextRunAt"] = json!(now_ms() - 30 * 3_600_000);
        db.conn()
            .execute(
                "UPDATE scheduled_tasks SET config_json = ?1, last_run_at = ?2 WHERE id = ?3",
                params![config.to_string(), now_ms() - 30 * 3_600_000, task.id],
            )
            .unwrap();
        recover(&db).unwrap();
        let updated = task_by_id(&db, &task.id);
        let next = ts_to_ms(updated.next_run_at.as_ref().unwrap());
        // Catch-up scheduled ~60s after boot (now + delay), not the next 9:00.
        assert!(
            next <= now_ms() + 120_000,
            "expected catch-up within ~2min, got {}",
            updated.next_run_at.unwrap()
        );
        // Editing (update) keeps the cron expression and reschedules correctly.
        let edited = update_task(
            &db,
            &json!({"id": task.id, "cronExpr": "30 12 * * *"}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(edited.cron_expr.as_deref(), Some("30 12 * * *"));
    }

    #[test]
    fn recover_skips_catch_up_for_fresh_task_without_runs() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let task = create_task(&db, &json!({"prompt":"check","cadence":"cron","cronExpr":"* * * * *"})).unwrap();
        // Fresh task (created just now, no runs): no catch-up burst.
        recover(&db).unwrap();
        let updated = task_by_id(&db, &task.id);
        assert!(updated.next_run_at.is_some());
        let due_ids = due(&db, now_ms()).unwrap();
        assert!(due_ids.is_empty());
    }
}
