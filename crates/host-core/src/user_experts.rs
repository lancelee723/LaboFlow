//! User-defined expert and expert-team registries (module 01, plan T51.1).
//!
//! Experts and teams are Markdown definition files in the `~/.agents/<kind>/`
//! family, exactly like user subagents: front matter carries the metadata, the
//! body is the persona (experts) or the leader/merge templates (teams).
//! Unlike subagents, the id *is* the display name and CJK is allowed —
//! consulting expert names are Chinese first (`战略规划分析师`), and slugifying
//! them away would make every expert collapse onto the same id.

use crate::activation::ActivationScope;
use crate::agent_capabilities::{
    capability_dir, file_timestamp, parse_front_matter, sorted_files, CapabilityLevel, CapabilityState,
};
use anyhow::{bail, Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::Path;

const MAX_USER_EXPERTS: usize = 64;
const MAX_EXPERT_BYTES: usize = 64 * 1024;
const MAX_TEAMS: usize = 32;
const MAX_NAME_BYTES: usize = 120;
const MAX_DESCRIPTION_CHARS: usize = 400;
const MAX_INDUSTRY_CHARS: usize = 40;
const MAX_LIST_ITEMS: usize = 12;
const MAX_BUDGET_TOKENS: u64 = 10_000_000;
const DEFAULT_TEAM_BUDGET_TOKENS: u64 = 200_000;
const LEADER_STYLES: [&str; 2] = ["fine", "coarse"];
const INTEGRATIONS: [&str; 3] = ["moderator", "summary", "sections"];
const THINKING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const EXPERT_KIND: &str = "experts";
const TEAM_KIND: &str = "teams";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserExpertRecord {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub industry: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub examples: Vec<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub mcp_servers: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    pub enabled: bool,
    #[serde(default)]
    pub scope: ActivationScope,
    pub path: String,
    #[serde(default)]
    pub size_bytes: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserExpertInput {
    pub id: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub industry: Option<String>,
    pub tags: Option<Vec<String>>,
    pub examples: Option<Vec<String>>,
    pub skills: Option<Vec<String>>,
    pub mcp_servers: Option<Vec<String>>,
    pub model: Option<String>,
    pub thinking_level: Option<String>,
    pub body: Option<String>,
    pub enabled: Option<bool>,
    #[allow(dead_code)]
    pub scope: Option<ActivationScope>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserTeamRecord {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub members: Vec<String>,
    #[serde(default)]
    pub leader_style: String,
    #[serde(default)]
    pub integration: String,
    /// Loop pipeline (pi-agent-loop protocol): ordered stage names joined by
    /// `|`. Empty = classic leader-decomposition mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pipeline: Option<String>,
    /// `stage=expert` pairs (comma separated) binding each stage to a member.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage_experts: Option<String>,
    /// Goal text: presence enables repeat-until-done semantics on stages.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    /// Fixed pass count for every stage (alternative to `goal`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rounds: Option<u32>,
    /// Hard cap for goal-mode rounds (default 5, executor side).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_rounds: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_tokens: Option<u64>,
    pub enabled: bool,
    #[serde(default)]
    pub scope: ActivationScope,
    pub path: String,
    #[serde(default)]
    pub size_bytes: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserTeamInput {
    pub id: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub members: Option<Vec<String>>,
    pub leader_style: Option<String>,
    pub integration: Option<String>,
    pub pipeline: Option<String>,
    pub stage_experts: Option<String>,
    pub goal: Option<String>,
    pub rounds: Option<u32>,
    pub max_rounds: Option<u32>,
    pub budget_tokens: Option<u64>,
    pub body: Option<String>,
    pub enabled: Option<bool>,
    #[allow(dead_code)]
    pub scope: Option<ActivationScope>,
}

/// Expert/team ids keep the display name: CJK-safe, no separators/control
/// characters, one line. This is intentionally NOT `slugify` — Chinese names
/// are the primary case, not an edge case.
fn normalize_name(value: &str) -> String {
    let mut name = String::new();
    for ch in value.trim().chars() {
        if ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            continue;
        }
        name.push(ch);
    }
    let truncated: String = name.chars().take(MAX_NAME_BYTES.min(name.len())).collect();
    let mut out = truncated.trim().to_string();
    while out.len() > MAX_NAME_BYTES {
        out.pop();
    }
    out
}

fn clip(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    trimmed.chars().take(max_chars).collect()
}

/// Examples are free-text task sentences, so they may contain commas; they
/// render and parse with a ` | ` separator instead.
fn parse_example_list(value: Option<&String>) -> Vec<String> {
    let mut items = Vec::new();
    let Some(raw) = value else {
        return items;
    };
    for item in raw.trim_matches(['[', ']']).split('|') {
        let item = item.trim();
        if !item.is_empty() && items.len() < MAX_LIST_ITEMS {
            items.push(item.to_string());
        }
    }
    items
}

fn parse_list(value: Option<&String>) -> Vec<String> {
    let mut items = Vec::new();
    let Some(raw) = value else {
        return items;
    };
    for item in raw.trim_matches(['[', ']']).split(',') {
        let item = item.trim();
        if !item.is_empty() && items.len() < MAX_LIST_ITEMS {
            items.push(item.to_string());
        }
    }
    items
}

fn normalize_thinking(value: Option<&str>) -> Option<String> {
    let candidate = value?.trim().to_lowercase();
    THINKING_LEVELS
        .iter()
        .find(|level| **level == candidate)
        .map(|level| (*level).to_string())
}

fn normalize_budget(value: Option<&u64>) -> Option<u64> {
    value
        .copied()
        .filter(|value| *value > 0)
        .map(|value| value.min(MAX_BUDGET_TOKENS))
}

fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= MAX_NAME_BYTES && name != "." && name != ".."
}

fn expert_from_front_matter(
    path: &Path,
    state: &CapabilityState,
) -> Option<UserExpertRecord> {
    let raw = fs::read_to_string(path).ok()?;
    if raw.len() > MAX_EXPERT_BYTES {
        return None;
    }
    let (front, body) = parse_front_matter(&raw);
    if body.trim().is_empty() {
        return None;
    }
    let name = normalize_name(front.get("name").map(String::as_str).unwrap_or(
        path.file_stem()?.to_str().unwrap_or_default(),
    ));
    let description = clip(front.get("description")?, MAX_DESCRIPTION_CHARS);
    if !valid_name(&name) || description.is_empty() {
        return None;
    }
    let enabled = state.enabled(EXPERT_KIND, CapabilityLevel::Global, &name, None);
    let updated_at = file_timestamp(path);
    Some(UserExpertRecord {
        id: name.clone(),
        name,
        description,
        industry: front
            .get("industry")
            .map(|value| clip(value, MAX_INDUSTRY_CHARS))
            .filter(|value| !value.is_empty()),
        tags: parse_list(front.get("tags")),
        examples: parse_example_list(front.get("examples")),
        skills: parse_list(front.get("skills")),
        mcp_servers: parse_list(front.get("mcpservers")),
        model: front
            .get("model")
            .cloned()
            .filter(|value| !value.trim().is_empty()),
        thinking_level: normalize_thinking(front.get("thinkinglevel").map(String::as_str)),
        enabled,
        scope: ActivationScope::default(),
        path: path.to_string_lossy().to_string(),
        size_bytes: raw.len() as u64,
        created_at: updated_at.clone(),
        updated_at,
    })
}

fn render_expert_document(record: &UserExpertRecord, body: &str) -> String {
    let mut output = String::from("---\n");
    output.push_str(&format!("name: {}\n", record.name));
    output.push_str(&format!(
        "description: {}\n",
        record.description.replace('\n', " ")
    ));
    if let Some(industry) = &record.industry {
        output.push_str(&format!("industry: {industry}\n"));
    }
    if !record.tags.is_empty() {
        output.push_str(&format!("tags: [{}]\n", record.tags.join(", ")));
    }
    if !record.examples.is_empty() {
        output.push_str(&format!("examples: [{}]\n", record.examples.join(" | ")));
    }
    if !record.skills.is_empty() {
        output.push_str(&format!("skills: [{}]\n", record.skills.join(", ")));
    }
    if !record.mcp_servers.is_empty() {
        output.push_str(&format!("mcpServers: [{}]\n", record.mcp_servers.join(", ")));
    }
    if let Some(model) = &record.model {
        output.push_str(&format!("model: {model}\n"));
    }
    if let Some(level) = &record.thinking_level {
        output.push_str(&format!("thinkingLevel: {level}\n"));
    }
    output.push_str("---\n\n");
    output.push_str(body.trim());
    output.push('\n');
    output
}

fn team_from_front_matter(
    path: &Path,
    state: &CapabilityState,
) -> Option<UserTeamRecord> {
    let raw = fs::read_to_string(path).ok()?;
    if raw.len() > MAX_EXPERT_BYTES {
        return None;
    }
    let (front, body) = parse_front_matter(&raw);
    if body.trim().is_empty() {
        return None;
    }
    let name = normalize_name(front.get("name").map(String::as_str).unwrap_or(
        path.file_stem()?.to_str().unwrap_or_default(),
    ));
    let description = clip(front.get("description")?, MAX_DESCRIPTION_CHARS);
    if !valid_name(&name) || description.is_empty() {
        return None;
    }
    let members = parse_list(front.get("members"));
    if members.is_empty() {
        return None;
    }
    let leader_style = front
        .get("leaderstyle")
        .map(|value| value.trim().to_lowercase())
        .map(|value| {
            LEADER_STYLES
                .iter()
                .find(|style| **style == value)
                .map(|style| (*style).to_string())
                .unwrap_or_else(|| "fine".to_string())
        })
        .unwrap_or_else(|| "fine".to_string());
    let integration = front
        .get("integration")
        .map(|value| value.trim().to_lowercase())
        .map(|value| {
            INTEGRATIONS
                .iter()
                .find(|style| **style == value)
                .map(|style| (*style).to_string())
                .unwrap_or_else(|| "moderator".to_string())
        })
        .unwrap_or_else(|| "moderator".to_string());
    let pipeline = front
        .get("pipeline")
        .map(|value| clip(value, 200))
        .filter(|value| !value.is_empty());
    let stage_experts = front
        .get("stageexperts")
        .map(|value| clip(value, 500))
        .filter(|value| !value.is_empty());
    let goal = front
        .get("goal")
        .map(|value| clip(value, MAX_DESCRIPTION_CHARS))
        .filter(|value| !value.is_empty());
    let rounds = front
        .get("rounds")
        .and_then(|value| value.trim().parse::<u32>().ok())
        .filter(|value| *value > 0)
        .map(|value| value.min(20));
    let max_rounds = front
        .get("maxrounds")
        .and_then(|value| value.trim().parse::<u32>().ok())
        .filter(|value| *value > 0)
        .map(|value| value.min(20));
    let enabled = state.enabled(TEAM_KIND, CapabilityLevel::Global, &name, None);
    let updated_at = file_timestamp(path);
    Some(UserTeamRecord {
        id: name.clone(),
        name,
        description,
        members,
        leader_style,
        integration,
        pipeline,
        stage_experts,
        goal,
        rounds,
        max_rounds,
        budget_tokens: front
            .get("budgettokens")
            .and_then(|value| value.trim().parse::<u64>().ok())
            .filter(|value| *value > 0)
            .map(|value| value.min(MAX_BUDGET_TOKENS))
            .or(Some(DEFAULT_TEAM_BUDGET_TOKENS)),
        enabled,
        scope: ActivationScope::default(),
        path: path.to_string_lossy().to_string(),
        size_bytes: raw.len() as u64,
        created_at: updated_at.clone(),
        updated_at,
    })
}

fn render_team_document(record: &UserTeamRecord, body: &str) -> String {
    let mut output = String::from("---\n");
    output.push_str(&format!("name: {}\n", record.name));
    output.push_str(&format!(
        "description: {}\n",
        record.description.replace('\n', " ")
    ));
    output.push_str(&format!("members: [{}]\n", record.members.join(", ")));
    output.push_str(&format!("leaderStyle: {}\n", record.leader_style));
    output.push_str(&format!("integration: {}\n", record.integration));
    if let Some(pipeline) = &record.pipeline {
        output.push_str(&format!("pipeline: {pipeline}\n"));
    }
    if let Some(pairs) = &record.stage_experts {
        output.push_str(&format!("stageExperts: {pairs}\n"));
    }
    if let Some(goal) = &record.goal {
        output.push_str(&format!("goal: {goal}\n"));
    }
    if let Some(rounds) = record.rounds {
        output.push_str(&format!("rounds: {rounds}\n"));
    }
    if let Some(max_rounds) = record.max_rounds {
        output.push_str(&format!("maxRounds: {max_rounds}\n"));
    }
    if let Some(budget) = record.budget_tokens {
        output.push_str(&format!("budgetTokens: {budget}\n"));
    }
    output.push_str("---\n\n");
    output.push_str(body.trim());
    output.push('\n');
    output
}

fn default_expert_body(name: &str) -> String {
    format!("你是「{name}」。以该专家的身份与用户协作：先确认目标与已知信息，再按你的方法论推进，最后给出结论与依据。\n")
}

fn default_team_body() -> String {
    "【拆解指令】把任务拆解为各成员职责内的子任务，明确依赖关系与预期产出。\n【整合指令】汇总各成员成果，标注贡献与缺口，输出结论先行的整合成果。\n".to_string()
}

pub struct UserExpertRegistry {
    state: CapabilityState,
    /// Test seam: overrides the global `~/.agents/experts` root so registry
    /// lifecycle tests never touch the real home directory.
    agents_root: Option<std::path::PathBuf>,
}

impl UserExpertRegistry {
    pub fn new(data_dir: &Path) -> Self {
        Self::with_agents_root(data_dir, None)
    }

    pub fn with_agents_root(data_dir: &Path, agents_root: Option<std::path::PathBuf>) -> Self {
        Self {
            state: CapabilityState::new(data_dir, EXPERT_KIND),
            agents_root,
        }
    }

    fn experts_dir(&self) -> Result<std::path::PathBuf> {
        match &self.agents_root {
            Some(root) => Ok(root.join(EXPERT_KIND)),
            None => capability_dir(CapabilityLevel::Global, None, EXPERT_KIND),
        }
    }

    fn scan(&mut self) -> Result<Vec<UserExpertRecord>> {
        let directory = self.experts_dir()?;
        let mut records = Vec::new();
        let mut seen = HashSet::new();
        for path in sorted_files(&directory, "md") {
            let Some(record) = expert_from_front_matter(&path, &self.state) else {
                continue;
            };
            if seen.insert(record.id.clone()) {
                records.push(record);
            }
        }
        let ids = records.iter().map(|record| record.id.clone()).collect();
        self.state
            .prune(EXPERT_KIND, CapabilityLevel::Global, None, &ids)?;
        records.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(records)
    }

    pub fn list(&mut self) -> Result<Vec<UserExpertRecord>> {
        self.scan()
    }

    pub fn active_for(&mut self, _project_path: Option<&str>) -> Result<Vec<UserExpertRecord>> {
        Ok(self
            .scan()?
            .into_iter()
            .filter(|record| record.enabled)
            .collect())
    }

    fn find(&mut self, id: &str) -> Result<Option<UserExpertRecord>> {
        Ok(self.scan()?.into_iter().find(|record| record.id == id))
    }

    pub fn create(&mut self, input: UserExpertInput) -> Result<UserExpertRecord> {
        let name = normalize_name(
            input
                .id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .or(input.name.as_deref())
                .unwrap_or_default(),
        );
        if !valid_name(&name) {
            bail!("EXPERT_INVALID: name is required");
        }
        let description = clip(
            input.description.as_deref().unwrap_or_default(),
            MAX_DESCRIPTION_CHARS,
        );
        if description.is_empty() {
            bail!("EXPERT_INVALID: description is required");
        }
        if self.scan()?.iter().any(|record| record.id == name) {
            bail!("EXPERT_INVALID: an expert named \"{name}\" already exists");
        }
        if self.scan()?.len() >= MAX_USER_EXPERTS {
            bail!("EXPERT_INVALID: at most {MAX_USER_EXPERTS} experts");
        }
        let record = UserExpertRecord {
            id: name.clone(),
            name,
            description,
            industry: input
                .industry
                .as_deref()
                .map(|value| clip(value, MAX_INDUSTRY_CHARS))
                .filter(|value| !value.is_empty()),
            tags: input.tags.unwrap_or_default().into_iter().take(MAX_LIST_ITEMS).collect(),
            examples: input
                .examples
                .unwrap_or_default()
                .into_iter()
                .take(MAX_LIST_ITEMS)
                .collect(),
            skills: input
                .skills
                .unwrap_or_default()
                .into_iter()
                .take(MAX_LIST_ITEMS)
                .collect(),
            mcp_servers: input
                .mcp_servers
                .unwrap_or_default()
                .into_iter()
                .take(MAX_LIST_ITEMS)
                .collect(),
            model: input.model.filter(|value| !value.trim().is_empty()),
            thinking_level: normalize_thinking(input.thinking_level.as_deref()),
            enabled: input.enabled.unwrap_or(true),
            scope: ActivationScope::default(),
            path: String::new(),
            size_bytes: 0,
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
        };
        let directory = self.experts_dir()?;
        fs::create_dir_all(&directory)?;
        let path = directory.join(format!("{}.md", record.id));
        let default_body = default_expert_body(&record.name);
        let body: &str = input
            .body
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(default_body.as_str());
        let document = render_expert_document(&record, body);
        if document.len() > MAX_EXPERT_BYTES {
            bail!("EXPERT_INVALID: document exceeds {MAX_EXPERT_BYTES} bytes");
        }
        fs::write(&path, &document).with_context(|| format!("write {}", path.display()))?;
        if !record.enabled {
            self.state.set_enabled(
                EXPERT_KIND,
                CapabilityLevel::Global,
                &record.id,
                None,
                false,
            )?;
        }
        self.find(&record.id)?
            .ok_or_else(|| anyhow::anyhow!("EXPERT_INVALID: created expert was not found"))
    }

    pub fn update(&mut self, id: &str, input: UserExpertInput) -> Result<Option<UserExpertRecord>> {
        let Some(current) = self.find(id)? else {
            return Ok(None);
        };
        let name = input
            .name
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(normalize_name)
            .unwrap_or_else(|| current.name.clone());
        if !valid_name(&name) {
            bail!("EXPERT_INVALID: name is required");
        }
        if name != current.name && self.scan()?.iter().any(|record| record.id == name) {
            bail!("EXPERT_INVALID: an expert named \"{name}\" already exists");
        }
        let description = input
            .description
            .as_deref()
            .map(|value| clip(value, MAX_DESCRIPTION_CHARS))
            .unwrap_or_else(|| current.description.clone());
        if description.is_empty() {
            bail!("EXPERT_INVALID: description is required");
        }
        let raw = fs::read_to_string(&current.path)?;
        let (_, old_body) = parse_front_matter(&raw);
        let body = input.body.unwrap_or(old_body);
        let mut next = current.clone();
        next.id = name.clone();
        next.name = name.clone();
        next.description = description;
        next.industry = match input.industry {
            Some(value) if value.trim().is_empty() => None,
            Some(value) => Some(clip(&value, MAX_INDUSTRY_CHARS)),
            None => current.industry,
        };
        if let Some(tags) = input.tags {
            next.tags = tags.into_iter().take(MAX_LIST_ITEMS).collect();
        }
        if let Some(examples) = input.examples {
            next.examples = examples.into_iter().take(MAX_LIST_ITEMS).collect();
        }
        if let Some(skills) = input.skills {
            next.skills = skills.into_iter().take(MAX_LIST_ITEMS).collect();
        }
        if let Some(servers) = input.mcp_servers {
            next.mcp_servers = servers.into_iter().take(MAX_LIST_ITEMS).collect();
        }
        next.model = match input.model {
            Some(value) if value.trim().is_empty() => None,
            Some(value) => Some(value),
            None => current.model,
        };
        next.thinking_level = match input.thinking_level {
            Some(value) if value.trim().is_empty() => None,
            Some(value) => normalize_thinking(Some(value.as_str())),
            None => current.thinking_level,
        };
        next.enabled = input.enabled.unwrap_or(current.enabled);
        next.path = current.path.clone();
        if next.id != current.id {
            next.path = self
                .experts_dir()?
                .join(format!("{}.md", next.id))
                .to_string_lossy()
                .to_string();
        }
        let document = render_expert_document(&next, &body);
        if document.len() > MAX_EXPERT_BYTES {
            bail!("EXPERT_INVALID: document exceeds {MAX_EXPERT_BYTES} bytes");
        }
        fs::write(&next.path, &document)?;
        if next.path != current.path {
            fs::remove_file(&current.path).ok();
        }
        if next.enabled != current.enabled {
            self.state.set_enabled(
                EXPERT_KIND,
                CapabilityLevel::Global,
                &next.id,
                None,
                next.enabled,
            )?;
        }
        self.find(&next.id)
    }

    pub fn read(&mut self, id: &str) -> Result<Option<(UserExpertRecord, String)>> {
        let Some(record) = self.find(id)? else {
            return Ok(None);
        };
        let raw = fs::read_to_string(&record.path)?;
        if raw.len() > MAX_EXPERT_BYTES {
            bail!("EXPERT_INVALID: document exceeds {MAX_EXPERT_BYTES} bytes");
        }
        let (_, body) = parse_front_matter(&raw);
        Ok(Some((record, body)))
    }

    pub fn remove(&mut self, id: &str) -> Result<bool> {
        let Some(record) = self.find(id)? else {
            return Ok(false);
        };
        fs::remove_file(&record.path).ok();
        let _ = self.scan()?;
        Ok(true)
    }

    pub fn set_enabled(&mut self, id: &str, enabled: bool) -> Result<Option<UserExpertRecord>> {
        let Some(record) = self.find(id)? else {
            return Ok(None);
        };
        self.state.set_enabled(
            EXPERT_KIND,
            CapabilityLevel::Global,
            &record.id,
            None,
            enabled,
        )?;
        self.find(id)
    }
}

pub struct UserTeamRegistry {
    state: CapabilityState,
    agents_root: Option<std::path::PathBuf>,
}

impl UserTeamRegistry {
    pub fn new(data_dir: &Path) -> Self {
        Self::with_agents_root(data_dir, None)
    }

    pub fn with_agents_root(data_dir: &Path, agents_root: Option<std::path::PathBuf>) -> Self {
        Self {
            state: CapabilityState::new(data_dir, TEAM_KIND),
            agents_root,
        }
    }

    fn teams_dir(&self) -> Result<std::path::PathBuf> {
        match &self.agents_root {
            Some(root) => Ok(root.join(TEAM_KIND)),
            None => capability_dir(CapabilityLevel::Global, None, TEAM_KIND),
        }
    }

    fn scan(&mut self) -> Result<Vec<UserTeamRecord>> {
        let directory = self.teams_dir()?;
        let mut records = Vec::new();
        let mut seen = HashSet::new();
        for path in sorted_files(&directory, "md") {
            let Some(record) = team_from_front_matter(&path, &self.state) else {
                continue;
            };
            if seen.insert(record.id.clone()) {
                records.push(record);
            }
        }
        let ids = records.iter().map(|record| record.id.clone()).collect();
        self.state
            .prune(TEAM_KIND, CapabilityLevel::Global, None, &ids)?;
        records.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(records)
    }

    pub fn list(&mut self) -> Result<Vec<UserTeamRecord>> {
        self.scan()
    }

    fn find(&mut self, id: &str) -> Result<Option<UserTeamRecord>> {
        Ok(self.scan()?.into_iter().find(|record| record.id == id))
    }

    pub fn create(&mut self, input: UserTeamInput) -> Result<UserTeamRecord> {
        let name = normalize_name(
            input
                .id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .or(input.name.as_deref())
                .unwrap_or_default(),
        );
        if !valid_name(&name) {
            bail!("EXPERT_INVALID: team name is required");
        }
        let description = clip(
            input.description.as_deref().unwrap_or_default(),
            MAX_DESCRIPTION_CHARS,
        );
        if description.is_empty() {
            bail!("EXPERT_INVALID: team description is required");
        }
        let members: Vec<String> = input
            .members
            .unwrap_or_default()
            .into_iter()
            .map(|member| normalize_name(&member))
            .filter(|member| !member.is_empty())
            .take(6)
            .collect();
        if members.is_empty() {
            bail!("EXPERT_INVALID: at least one member is required");
        }
        if self.scan()?.iter().any(|record| record.id == name) {
            bail!("EXPERT_INVALID: a team named \"{name}\" already exists");
        }
        if self.scan()?.len() >= MAX_TEAMS {
            bail!("EXPERT_INVALID: at most {MAX_TEAMS} teams");
        }
        let leader_style = input
            .leader_style
            .as_deref()
            .map(|value| value.trim().to_lowercase())
            .map(|value| {
                LEADER_STYLES
                    .iter()
                    .find(|style| **style == value)
                    .map(|style| (*style).to_string())
                    .unwrap_or_else(|| "fine".to_string())
            })
            .unwrap_or_else(|| "fine".to_string());
        let integration = input
            .integration
            .as_deref()
            .map(|value| value.trim().to_lowercase())
            .map(|value| {
                INTEGRATIONS
                    .iter()
                    .find(|style| **style == value)
                    .map(|style| (*style).to_string())
                    .unwrap_or_else(|| "moderator".to_string())
            })
            .unwrap_or_else(|| "moderator".to_string());
        let pipeline = input
            .pipeline
            .as_deref()
            .map(|value| clip(value, 200))
            .filter(|value| !value.is_empty());
        let stage_experts = input
            .stage_experts
            .as_deref()
            .map(|value| clip(value, 500))
            .filter(|value| !value.is_empty());
        let goal = input
            .goal
            .as_deref()
            .map(|value| clip(value, MAX_DESCRIPTION_CHARS))
            .filter(|value| !value.is_empty());
        let rounds = input
            .rounds
            .filter(|value| *value > 0)
            .map(|value| value.min(20));
        let max_rounds = input
            .max_rounds
            .filter(|value| *value > 0)
            .map(|value| value.min(20));
        let record = UserTeamRecord {
            id: name.clone(),
            name,
            description,
            members,
            leader_style,
            integration,
            pipeline,
            stage_experts,
            goal,
            rounds,
            max_rounds,
            budget_tokens: normalize_budget(input.budget_tokens.as_ref()),
            enabled: input.enabled.unwrap_or(true),
            scope: ActivationScope::default(),
            path: String::new(),
            size_bytes: 0,
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
        };
        let directory = self.teams_dir()?;
        fs::create_dir_all(&directory)?;
        let path = directory.join(format!("{}.md", record.id));
        let default_body = default_team_body();
        let document = render_team_document(
            &record,
            input.body.as_deref().unwrap_or(default_body.as_str()),
        );
        if document.len() > MAX_EXPERT_BYTES {
            bail!("EXPERT_INVALID: document exceeds {MAX_EXPERT_BYTES} bytes");
        }
        fs::write(&path, &document).with_context(|| format!("write {}", path.display()))?;
        if !record.enabled {
            self.state
                .set_enabled(TEAM_KIND, CapabilityLevel::Global, &record.id, None, false)?;
        }
        self.find(&record.id)?
            .ok_or_else(|| anyhow::anyhow!("EXPERT_INVALID: created team was not found"))
    }

    pub fn update(&mut self, id: &str, input: UserTeamInput) -> Result<Option<UserTeamRecord>> {
        let Some(current) = self.find(id)? else {
            return Ok(None);
        };
        let name = input
            .name
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(normalize_name)
            .unwrap_or_else(|| current.name.clone());
        if !valid_name(&name) {
            bail!("EXPERT_INVALID: team name is required");
        }
        if name != current.name && self.scan()?.iter().any(|record| record.id == name) {
            bail!("EXPERT_INVALID: a team named \"{name}\" already exists");
        }
        let description = input
            .description
            .as_deref()
            .map(|value| clip(value, MAX_DESCRIPTION_CHARS))
            .unwrap_or_else(|| current.description.clone());
        if description.is_empty() {
            bail!("EXPERT_INVALID: team description is required");
        }
        let members = match input.members {
            Some(members) => {
                let filtered: Vec<String> = members
                    .into_iter()
                    .map(|member| normalize_name(&member))
                    .filter(|member| !member.is_empty())
                    .take(6)
                    .collect();
                if filtered.is_empty() {
                    bail!("EXPERT_INVALID: at least one member is required");
                }
                filtered
            }
            None => current.members.clone(),
        };
        let raw = fs::read_to_string(&current.path)?;
        let (_, old_body) = parse_front_matter(&raw);
        let body = input.body.unwrap_or(old_body);
        let mut next = current.clone();
        next.id = name.clone();
        next.name = name.clone();
        next.description = description;
        next.members = members;
        next.leader_style = input
            .leader_style
            .as_deref()
            .map(|value| value.trim().to_lowercase())
            .map(|value| {
                LEADER_STYLES
                    .iter()
                    .find(|style| **style == value)
                    .map(|style| (*style).to_string())
                    .unwrap_or_else(|| "fine".to_string())
            })
            .unwrap_or(current.leader_style);
        next.integration = input
            .integration
            .as_deref()
            .map(|value| value.trim().to_lowercase())
            .map(|value| {
                INTEGRATIONS
                    .iter()
                    .find(|style| **style == value)
                    .map(|style| (*style).to_string())
                    .unwrap_or_else(|| "moderator".to_string())
            })
            .unwrap_or(current.integration);
        next.pipeline = match input.pipeline {
            Some(value) if value.trim().is_empty() => None,
            Some(value) => Some(clip(&value, 200)),
            None => current.pipeline,
        };
        next.stage_experts = match input.stage_experts {
            Some(value) if value.trim().is_empty() => None,
            Some(value) => Some(clip(&value, 500)),
            None => current.stage_experts,
        };
        next.goal = match input.goal {
            Some(value) if value.trim().is_empty() => None,
            Some(value) => Some(clip(&value, MAX_DESCRIPTION_CHARS)),
            None => current.goal,
        };
        next.rounds = match input.rounds {
            Some(0) => None,
            Some(value) => Some(value.min(20)),
            None => current.rounds,
        };
        next.max_rounds = match input.max_rounds {
            Some(0) => None,
            Some(value) => Some(value.min(20)),
            None => current.max_rounds,
        };
        next.budget_tokens = match input.budget_tokens {
            Some(0) => None,
            Some(value) => Some(value.min(MAX_BUDGET_TOKENS)),
            None => current.budget_tokens,
        };
        next.enabled = input.enabled.unwrap_or(current.enabled);
        next.path = current.path.clone();
        if next.id != current.id {
            next.path = self
                .teams_dir()?
                .join(format!("{}.md", next.id))
                .to_string_lossy()
                .to_string();
        }
        let document = render_team_document(&next, &body);
        if document.len() > MAX_EXPERT_BYTES {
            bail!("EXPERT_INVALID: document exceeds {MAX_EXPERT_BYTES} bytes");
        }
        fs::write(&next.path, &document)?;
        if next.path != current.path {
            fs::remove_file(&current.path).ok();
        }
        if next.enabled != current.enabled {
            self.state
                .set_enabled(TEAM_KIND, CapabilityLevel::Global, &next.id, None, next.enabled)?;
        }
        self.find(&next.id)
    }

    pub fn read(&mut self, id: &str) -> Result<Option<(UserTeamRecord, String)>> {
        let Some(record) = self.find(id)? else {
            return Ok(None);
        };
        let raw = fs::read_to_string(&record.path)?;
        if raw.len() > MAX_EXPERT_BYTES {
            bail!("EXPERT_INVALID: document exceeds {MAX_EXPERT_BYTES} bytes");
        }
        let (_, body) = parse_front_matter(&raw);
        Ok(Some((record, body)))
    }

    pub fn remove(&mut self, id: &str) -> Result<bool> {
        let Some(record) = self.find(id)? else {
            return Ok(false);
        };
        fs::remove_file(&record.path).ok();
        let _ = self.scan()?;
        Ok(true)
    }

    pub fn set_enabled(&mut self, id: &str, enabled: bool) -> Result<Option<UserTeamRecord>> {
        let Some(record) = self.find(id)? else {
            return Ok(None);
        };
        self.state
            .set_enabled(TEAM_KIND, CapabilityLevel::Global, &record.id, None, enabled)?;
        self.find(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn harness() -> (std::path::PathBuf, std::path::PathBuf, UserExpertRegistry, UserTeamRegistry) {
        let data_dir = tempdir().unwrap();
        let agents_root = tempdir().unwrap();
        let experts = UserExpertRegistry::with_agents_root(data_dir.path(), Some(agents_root.path().to_path_buf()));
        let teams = UserTeamRegistry::with_agents_root(data_dir.path(), Some(agents_root.path().to_path_buf()));
        (data_dir.keep(), agents_root.keep(), experts, teams)
    }

    #[test]
    fn cjk_names_survive_normalization() {
        assert_eq!(normalize_name("  战略规划分析师 "), "战略规划分析师");
        assert_eq!(normalize_name("a/b\\c"), "abc");
        assert_eq!(normalize_name("x\n\ty"), "xy");
        assert!(normalize_name("").is_empty());
    }

    #[test]
    fn expert_roundtrips_through_front_matter() {
        let (_d, root, mut experts, _t) = harness();
        let directory = root.join(EXPERT_KIND);
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("战略规划分析师.md"),
            "---\nname: 战略规划分析师\ndescription: 行业与市场结构分析\nindustry: 战略与组织\ntags: [市场测算, 竞争分析]\nexamples: [测算TAM | 五力分析]\nmcpServers: [weknora]\n---\n\n你是麦肯锡合伙人视角的分析师。\n",
        )
        .unwrap();
        let records = experts.list().unwrap();
        assert_eq!(records.len(), 1);
        let record = &records[0];
        assert_eq!(record.id, "战略规划分析师");
        assert_eq!(record.industry.as_deref(), Some("战略与组织"));
        assert_eq!(record.tags, vec!["市场测算".to_string(), "竞争分析".to_string()]);
        assert_eq!(record.examples, vec!["测算TAM".to_string(), "五力分析".to_string()]);
        assert_eq!(record.mcp_servers, vec!["weknora".to_string()]);

        assert!(record.enabled);

        let (_, body) = experts.read("战略规划分析师").unwrap().unwrap();
        assert!(body.contains("麦肯锡合伙人"));
    }

    #[test]
    fn create_update_remove_expert_lifecycle() {
        let (_d, _r, mut experts, _t) = harness();
        let record = experts
            .create(UserExpertInput {
                id: Some("数据分析专家".into()),
                description: Some("数据清洗与指标测算".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(record.name, "数据分析专家");

        assert!(experts
            .create(UserExpertInput {
                id: Some("数据分析专家".into()),
                description: Some("another".into()),
                ..Default::default()
            })
            .is_err());

        let updated = experts
            .update(
                "数据分析专家",
                UserExpertInput {
                    name: Some("数据科学家".into()),
                    ..Default::default()
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(updated.id, "数据科学家");
        assert_eq!(experts.list().unwrap().len(), 1);

        assert!(experts.remove("数据科学家").unwrap());
        assert!(experts.list().unwrap().is_empty());
    }

    #[test]
    fn disabled_state_survives_rescan_without_touching_the_document() {
        let (_d, _r, mut experts, _t) = harness();
        experts
            .create(UserExpertInput {
                id: Some("审稿人".into()),
                description: Some("交付物评审".into()),
                enabled: Some(false),
                ..Default::default()
            })
            .unwrap();
        let records = experts.list().unwrap();
        assert_eq!(records.len(), 1);
        assert!(!records[0].enabled);

        let enabled = experts.set_enabled("审稿人", true).unwrap().unwrap();
        assert!(enabled.enabled);
        let raw = fs::read_to_string(&enabled.path).unwrap();
        assert!(!raw.contains("enabled"));
    }

    #[test]
    fn team_roundtrip_validates_members_and_defaults() {
        let (_d, _r, _e, mut teams) = harness();
        let record = teams
            .create(UserTeamInput {
                id: Some("咨询交付团".into()),
                description: Some("研究+数据+Slide 交付团队".into()),
                members: Some(vec![
                    "战略规划分析师".into(),
                    "数据分析专家".into(),
                    " PPT制作师 ".into(),
                ]),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(record.members.len(), 3);
        assert_eq!(record.members[2], "PPT制作师");
        assert_eq!(record.leader_style, "fine");
        assert_eq!(record.integration, "moderator");
        assert_eq!(record.budget_tokens, Some(DEFAULT_TEAM_BUDGET_TOKENS));

        assert!(teams
            .create(UserTeamInput {
                id: Some("空团队".into()),
                description: Some("no members".into()),
                ..Default::default()
            })
            .is_err());

        let (_, body) = teams.read("咨询交付团").unwrap().unwrap();
        assert!(body.contains("拆解指令"));
    }
}
