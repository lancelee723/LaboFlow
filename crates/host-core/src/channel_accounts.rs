//! IM channel account persistence (FR-IM-01/02, migration v21). Credential-
//! free account records only: provider/name/scope/allowlist/enabled plus the
//! secret_ref pointer. The secrets themselves live in the sealed secrets
//! table and never pass through here.

use anyhow::Result;
use rusqlite::params;
use serde::Serialize;
use serde_json::Value;

use crate::db::{now_ms, Database};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelAccountRecord {
    pub id: String,
    pub provider: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret_ref: Option<String>,
    pub scope: String,
    pub allowlist: Vec<String>,
    pub enabled: bool,
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChannelAccountRecord> {
    let allowlist_raw: String = row.get("allowlist")?;
    Ok(ChannelAccountRecord {
        id: row.get("id")?,
        provider: row.get("provider")?,
        name: row.get("name")?,
        secret_ref: row.get("secret_ref")?,
        scope: row.get("scope")?,
        allowlist: serde_json::from_str(&allowlist_raw).unwrap_or_default(),
        enabled: row.get::<_, i64>("enabled")? != 0,
    })
}

pub fn list(db: &Database) -> Result<Vec<ChannelAccountRecord>> {
    let mut stmt = db
        .conn()
        .prepare_cached("SELECT * FROM channel_accounts ORDER BY provider, name")?;
    let rows = stmt.query_map([], row_to_record)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Upsert one account record. The caller (desktop main) owns secret
/// lifecycle: `secret_ref` may be omitted to keep the stored pointer.
pub fn upsert(db: &Database, record: &ChannelAccountRecord) -> Result<()> {
    let allowlist = serde_json::to_string(&record.allowlist)?;
    db.conn().prepare_cached(
        "INSERT INTO channel_accounts
           (id, provider, name, secret_ref, scope, allowlist, enabled, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
         ON CONFLICT(id) DO UPDATE SET
           provider = excluded.provider,
           name = excluded.name,
           secret_ref = COALESCE(excluded.secret_ref, channel_accounts.secret_ref),
           scope = excluded.scope,
           allowlist = excluded.allowlist,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at",
    )?
    .execute(params![
        record.id,
        record.provider,
        record.name,
        record.secret_ref,
        record.scope,
        allowlist,
        i64::from(record.enabled),
        now_ms(),
    ])?;
    Ok(())
}

pub fn delete(db: &Database, id: &str) -> Result<()> {
    db.conn()
        .prepare_cached("DELETE FROM channel_accounts WHERE id = ?1")?
        .execute(params![id])?;
    Ok(())
}

/// Replace the whole set atomically (the desktop registry snapshots its
/// in-memory map after every mutation, mirroring the registry's own shape).
pub fn replace_all(db: &Database, accounts: &[ChannelAccountRecord]) -> Result<()> {
    let tx = db.conn().unchecked_transaction()?;
    tx.execute("DELETE FROM channel_accounts", [])?;
    for record in accounts {
        let allowlist = serde_json::to_string(&record.allowlist)?;
        let version = now_ms();
        tx.execute(
            "INSERT INTO channel_accounts
               (id, provider, name, secret_ref, scope, allowlist, enabled, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
             ON CONFLICT(id) DO UPDATE SET
               provider = excluded.provider,
               name = excluded.name,
               secret_ref = COALESCE(excluded.secret_ref, channel_accounts.secret_ref),
               scope = excluded.scope,
               allowlist = excluded.allowlist,
               enabled = excluded.enabled,
               updated_at = excluded.updated_at",
            params![
                record.id,
                record.provider,
                record.name,
                record.secret_ref,
                record.scope,
                allowlist,
                i64::from(record.enabled),
                version,
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Parse an RPC params object into a record (shared by the JSON-RPC face).
pub fn record_from_params(params: &Value) -> Result<ChannelAccountRecord> {
    let obj = params
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("account object required"))?;
    let id = obj
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("id required"))?
        .to_string();
    let parse_list = |v: Option<&Value>| -> Vec<String> {
        v.and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    };
    Ok(ChannelAccountRecord {
        id,
        provider: obj
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or("feishu")
            .to_string(),
        name: obj.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
        secret_ref: obj.get("secretRef").and_then(Value::as_str).map(str::to_string),
        scope: obj
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or("both")
            .to_string(),
        allowlist: parse_list(obj.get("allowlist")),
        enabled: obj.get("enabled").and_then(Value::as_bool).unwrap_or(true),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        (dir, db)
    }

    #[test]
    fn upsert_list_delete_roundtrip() {
        let (_dir, db) = open();
        let record = ChannelAccountRecord {
            id: "acc-1".into(),
            provider: "feishu".into(),
            name: "飞书主号".into(),
            secret_ref: Some("channels/acc-1/appSecret".into()),
            scope: "both".into(),
            allowlist: vec!["ou_123".into()],
            enabled: true,
        };
        upsert(&db, &record).unwrap();
        // Update path: name changes, secret_ref omitted keeps stored pointer.
        upsert(
            &db,
            &ChannelAccountRecord {
                id: "acc-1".into(),
                provider: "feishu".into(),
                name: "飞书主号(改)".into(),
                secret_ref: None,
                scope: "p2p".into(),
                allowlist: vec![],
                enabled: false,
            },
        )
        .unwrap();
        let listed = list(&db).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "飞书主号(改)");
        assert_eq!(listed[0].scope, "p2p");
        assert_eq!(
            listed[0].secret_ref.as_deref(),
            Some("channels/acc-1/appSecret")
        );
        assert!(!listed[0].enabled);
        delete(&db, "acc-1").unwrap();
        assert!(list(&db).unwrap().is_empty());
    }

    #[test]
    fn replace_all_swaps_the_set() {
        let (_dir, db) = open();
        upsert(
            &db,
            &ChannelAccountRecord {
                id: "old".into(),
                provider: "wecom".into(),
                name: "旧".into(),
                secret_ref: None,
                scope: "both".into(),
                allowlist: vec![],
                enabled: true,
            },
        )
        .unwrap();
        replace_all(
            &db,
            &[ChannelAccountRecord {
                id: "new".into(),
                provider: "wechat_mp".into(),
                name: "新".into(),
                secret_ref: None,
                scope: "both".into(),
                allowlist: vec![],
                enabled: true,
            }],
        )
        .unwrap();
        let listed = list(&db).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "new");
    }

    #[test]
    fn record_from_params_maps_camel_case() {
        let params: Value = serde_json::json!({
            "id": "a1", "provider": "feishu", "name": "n",
            "secretRef": "s", "scope": "p2p", "allowlist": ["u1"], "enabled": false
        });
        let record = record_from_params(&params).unwrap();
        assert_eq!(record.secret_ref.as_deref(), Some("s"));
        assert_eq!(record.allowlist, vec!["u1"]);
        assert!(!record.enabled);
    }
}
