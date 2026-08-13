//! Read, search, and refresh the canonical Godot project brain.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State};

const KNOWLEDGE_SCHEMA_VERSION: u32 = 2;
const MAX_QUERY_RESULTS: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeManifest {
    pub schema_version: u32,
    pub generated_at: u64,
    pub project: KnowledgeProject,
    pub coverage: KnowledgeCoverage,
    pub fingerprint: KnowledgeFingerprint,
    pub dirty: KnowledgeDirty,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeProject {
    pub id: String,
    pub path: String,
    pub name: String,
    pub is_godot_project: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeCoverage {
    pub cap: u64,
    pub discovered: u64,
    pub scanned: u64,
    pub complete: bool,
    pub truncated: bool,
    pub errors: Vec<KnowledgeScanError>,
    pub counts: KnowledgeCounts,
    pub scopes: KnowledgeScopes,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeScanError {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeCounts {
    pub files: u64,
    pub first_party_scripts: u64,
    pub addon_scripts: u64,
    pub scenes: u64,
    pub resources: u64,
    pub shaders: u64,
    pub entities: u64,
    pub relations: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeScopes {
    pub first_party: KnowledgeScope,
    pub addons: KnowledgeScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeScope {
    pub root: String,
    pub discovered: u64,
    pub scanned: u64,
    pub scripts: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeFingerprint {
    pub algorithm: String,
    pub source: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDirty {
    pub value: bool,
    pub reasons: Vec<KnowledgeDirtyReason>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDirtyReason {
    pub at: u64,
    pub change: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeEntity {
    pub id: String,
    pub kind: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub scope: String,
    pub facts: Vec<KnowledgeFact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeFact {
    pub key: String,
    pub value: Value,
    pub provenance: KnowledgeProvenance,
    pub observed_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeProvenance {
    pub source: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heuristic: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeRelation {
    pub id: String,
    pub kind: String,
    pub from: String,
    pub to: String,
    pub provenance: KnowledgeProvenance,
    pub observed_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMapData {
    pub manifest: KnowledgeManifest,
    pub entities: Vec<KnowledgeEntity>,
    pub relations: Vec<KnowledgeRelation>,
    /// Wall-clock age of the snapshot. Dirty state is kept separately in the
    /// manifest so the UI never conflates "old" with "known to be changed".
    pub age_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMapSearchHit {
    pub entity: KnowledgeEntity,
    pub score: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMapQueryResult {
    pub hits: Vec<ProjectMapSearchHit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refreshed_map: Option<ProjectMapData>,
}

/// Cheap readiness probe for project selection. Full parsing and count
/// validation remain in `load_project_map` when the drawer actually opens.
pub fn project_map_is_initialized(project: &Path) -> bool {
    let directory = project.join(".godot-vibe").join("brain");
    let required = [
        "manifest.json",
        "entities.jsonl",
        "relations.jsonl",
        "index.md",
    ];
    if required.iter().any(|name| !directory.join(name).is_file()) {
        return false;
    }
    std::fs::read(directory.join("manifest.json"))
        .ok()
        .and_then(|raw| serde_json::from_slice::<KnowledgeManifest>(&raw).ok())
        .map(|manifest| {
            manifest.schema_version == KNOWLEDGE_SCHEMA_VERSION && !manifest.dirty.value
        })
        .unwrap_or(false)
}

#[tauri::command]
pub async fn read_project_map(
    app: AppHandle,
    project: String,
    state: State<'_, AppState>,
) -> AppResult<Option<ProjectMapData>> {
    reconcile_project_map(app, project, state, true)
        .await
        .map(Some)
}

#[tauri::command]
pub async fn query_project_map(
    app: AppHandle,
    project: String,
    query: String,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> AppResult<ProjectMapQueryResult> {
    let project_for_revision = project.clone();
    let before =
        tokio::task::spawn_blocking(move || project_map_revision(Path::new(&project_for_revision)))
            .await
            .map_err(|error| {
                AppError::Other(format!("project map revision task failed: {error}"))
            })?;
    let map = reconcile_project_map(app, project, state, true).await?;
    let refreshed = before.as_ref() != Some(&ProjectMapRevision::from(&map.manifest));
    Ok(project_map_query_result(
        map,
        &query,
        limit.unwrap_or(50),
        refreshed,
    ))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMapAnswer {
    pub answer: String,
    /// Ids of entities the answer is about, already resolved against the
    /// current map — the drawer highlights exactly these.
    pub entity_ids: Vec<String>,
}

#[derive(Deserialize)]
struct AskRaw {
    #[serde(default)]
    answer: String,
    #[serde(default)]
    entities: Vec<String>,
}

const ASK_MAX_QUESTION_CHARS: usize = 500;
const ASK_MAX_HIGHLIGHTS: usize = 8;
const ASK_MAX_TURNS: u32 = 12;

/// Answer a question *about* the project without touching it.
///
/// Runs one cold agent turn with a read-only tool set (see
/// [`crate::agent::flags::FlagInput::read_only`]) and returns its prose answer
/// plus the entities it cited, so the drawer can highlight them. Nothing here
/// can write: the turn gets no MCP server and no edit/shell tools.
#[tauri::command]
pub async fn ask_project_map(
    app: AppHandle,
    project: String,
    question: String,
    state: State<'_, AppState>,
) -> AppResult<ProjectMapAnswer> {
    let question = question.trim().to_string();
    if question.is_empty() {
        return Err(AppError::Other("Ask a question first.".into()));
    }
    if question.chars().count() > ASK_MAX_QUESTION_CHARS {
        return Err(AppError::Other(format!(
            "Questions are limited to {ASK_MAX_QUESTION_CHARS} characters."
        )));
    }

    let map = reconcile_project_map(app.clone(), project.clone(), state.clone(), true).await?;
    let project_path = PathBuf::from(&project);
    let mcp_config = crate::mcpconfig::ensure_mcp_config(&app, &state.config_dir, &project_path)?;
    let mcp_entry = crate::mcpconfig::mcp_entry(&app, &project_path);
    let settings = state.settings.read().await.clone();
    let backend = settings.agent_backend;

    let args = crate::agent::flags::build_args(
        backend,
        &settings,
        &crate::agent::flags::FlagInput {
            mcp_config_path: &mcp_config,
            mcp_entry: &mcp_entry,
            resume_session_id: None,
            max_turns: Some(ASK_MAX_TURNS),
            run_options: None,
            read_only: true,
        },
    );

    // One channel per ask. The map's timestamp would repeat across questions,
    // so consecutive asks would stream onto the same event name.
    static ASK_SEQ: AtomicU64 = AtomicU64::new(0);
    let run_id = format!("ask:{}", ASK_SEQ.fetch_add(1, Ordering::Relaxed));
    let (_handle, join) = crate::agent::spawn_streaming(
        app,
        backend,
        run_id,
        &project_path,
        args,
        ask_prompt(&project, &question),
    )
    .map_err(|error| AppError::Other(error.to_string()))?;
    let info = join
        .await
        .map_err(|error| AppError::Other(format!("ask task failed: {error}")))?;

    let text = info.result_text.unwrap_or_default();
    let known: HashSet<&str> = map.entities.iter().map(|e| e.id.as_str()).collect();
    Ok(parse_answer(&text, &known))
}

fn ask_prompt(project: &str, question: &str) -> String {
    format!(
        "You are answering a question about a Godot project. This is a READ-ONLY task: \
         explain what is there, change nothing.\n\n\
         PROJECT: {project}\n\n\
         QUESTION:\n{question}\n\n\
         The project map is already built at `.godot-vibe/brain/` — start there rather than \
         scanning the whole project:\n\
         - `entities.jsonl`: one JSON object per line with `id`, `kind` \
         (project|addon|scene|resource|script|class|module|shader), `name`, `path`.\n\
         - `relations.jsonl`: `kind` (contains|declares|extends|references|instantiates), `from`, `to` \
         (entity ids).\n\
         - `index.md`: a human-readable overview.\n\
         Grep those files first, then read the specific source files you still need.\n\n\
         Answer in at most 4 sentences of plain prose — no headings, no bullet lists. Say plainly \
         when the map does not cover something rather than guessing.\n\n\
         END your reply with EXACTLY one fenced json block and NOTHING after it. `entities` holds \
         the ids (from entities.jsonl) of what the answer is about, most relevant first, at most \
         {ASK_MAX_HIGHLIGHTS}; use an empty list when no single entity fits:\n\
         ```json\n\
         {{\"answer\":\"<your answer>\",\"entities\":[\"<entity id>\"]}}\n\
         ```"
    )
}

/// Pull the answer out of the turn's text, keeping only entity ids that exist
/// in the current map — a hallucinated id highlights nothing rather than
/// leaving a dead selection in the drawer.
fn parse_answer(text: &str, known: &HashSet<&str>) -> ProjectMapAnswer {
    let parsed = crate::looprunner::reflect::last_fenced_block(text)
        .and_then(|block| serde_json::from_str::<AskRaw>(&block).ok());

    let Some(parsed) = parsed else {
        // No block: the prose is still worth showing, minus any stray fence.
        let answer = text.split("```").next().unwrap_or("").trim().to_string();
        return ProjectMapAnswer {
            answer,
            entity_ids: Vec::new(),
        };
    };

    let mut seen = HashSet::new();
    let entity_ids = parsed
        .entities
        .into_iter()
        .filter(|id| known.contains(id.as_str()) && seen.insert(id.clone()))
        .take(ASK_MAX_HIGHLIGHTS)
        .collect();

    ProjectMapAnswer {
        answer: parsed.answer.trim().to_string(),
        entity_ids,
    }
}

#[tauri::command]
pub async fn refresh_project_map(
    app: AppHandle,
    project: String,
    state: State<'_, AppState>,
) -> AppResult<ProjectMapData> {
    reconcile_project_map(app, project, state, false).await
}

/// Reconcile filesystem freshness before a normal read, or force a full build
/// for the explicit Refresh action. Both modes hold Studio's per-project task
/// permit through the CLI run and the validated snapshot read.
async fn reconcile_project_map(
    app: AppHandle,
    project: String,
    state: State<'_, AppState>,
    ensure: bool,
) -> AppResult<ProjectMapData> {
    let project_path = PathBuf::from(&project);
    let permit = state
        .executions
        .try_acquire(&project_path)
        .ok_or_else(|| AppError::Other("busy: another task is using this project".into()))?;
    let (command, prefix) = crate::mcpconfig::resolve_gvibe(&app);

    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let args = brain_args(&project, ensure);
        let command = crate::mcpconfig::resolved_gvibe_command(&command, &prefix, &args)?;
        let output = crate::proc::output_with_timeout(command, Duration::from_secs(600))?;
        if !output.status.success() {
            let operation = if ensure { "reconciliation" } else { "refresh" };
            return Err(AppError::Other(format!(
                "project map {operation} failed: {}",
                process_detail(&output.stderr, &output.stdout)
            )));
        }
        load_project_map(Path::new(&project))?.ok_or_else(|| {
            AppError::Other("gvibe brain finished without writing a canonical project map".into())
        })
    })
    .await
    .map_err(|error| AppError::Other(format!("project map task failed: {error}")))?
}

fn brain_args(project: &str, ensure: bool) -> Vec<String> {
    let mut args = vec!["brain".to_string()];
    if ensure {
        args.push("--ensure".to_string());
    }
    args.extend(["--project".to_string(), project.to_string()]);
    args
}

fn load_project_map(project: &Path) -> AppResult<Option<ProjectMapData>> {
    let directory = project.join(".godot-vibe").join("brain");
    let manifest_path = directory.join("manifest.json");
    if !manifest_path.is_file() {
        return Ok(None);
    }

    let manifest_before = std::fs::read(&manifest_path)?;
    let manifest: KnowledgeManifest =
        serde_json::from_slice(&manifest_before).map_err(|error| {
            AppError::Other(format!(
                "invalid project map manifest at {}: {error}",
                manifest_path.display()
            ))
        })?;
    if manifest.schema_version != KNOWLEDGE_SCHEMA_VERSION {
        return Err(AppError::Other(format!(
            "unsupported project map schema {} (Studio supports {})",
            manifest.schema_version, KNOWLEDGE_SCHEMA_VERSION
        )));
    }

    let (entities_raw, entities): (Vec<u8>, Vec<KnowledgeEntity>) =
        read_jsonl_with_raw(&directory.join("entities.jsonl"))?;
    let (relations_raw, relations): (Vec<u8>, Vec<KnowledgeRelation>) =
        read_jsonl_with_raw(&directory.join("relations.jsonl"))?;
    let manifest_after = std::fs::read(&manifest_path)?;
    if manifest_before != manifest_after {
        return Err(AppError::Other(
            "project map changed while Studio was reading it; retry the read".into(),
        ));
    }
    validate_store(
        &manifest,
        &entities_raw,
        &relations_raw,
        &entities,
        &relations,
    )?;

    Ok(Some(ProjectMapData {
        age_ms: now_ms().saturating_sub(manifest.generated_at),
        manifest,
        entities,
        relations,
    }))
}

fn read_jsonl_with_raw<T: DeserializeOwned>(path: &Path) -> AppResult<(Vec<u8>, Vec<T>)> {
    let raw = std::fs::read(path).map_err(|error| {
        AppError::Other(format!(
            "project map file is missing or unreadable at {}: {error}",
            path.display()
        ))
    })?;
    let text = std::str::from_utf8(&raw).map_err(|error| {
        AppError::Other(format!(
            "project map file is not UTF-8 at {}: {error}",
            path.display()
        ))
    })?;
    let mut records = Vec::new();
    for (index, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let record = serde_json::from_str(&line).map_err(|error| {
            AppError::Other(format!(
                "invalid project map record at {}:{}: {error}",
                path.display(),
                index + 1
            ))
        })?;
        records.push(record);
    }
    Ok((raw, records))
}

#[cfg(test)]
fn read_jsonl<T: DeserializeOwned>(path: &Path) -> AppResult<Vec<T>> {
    read_jsonl_with_raw(path).map(|(_, records)| records)
}

fn validate_store(
    manifest: &KnowledgeManifest,
    entities_raw: &[u8],
    relations_raw: &[u8],
    entities: &[KnowledgeEntity],
    relations: &[KnowledgeRelation],
) -> AppResult<()> {
    if manifest.fingerprint.algorithm != "sha256" {
        return Err(AppError::Other(format!(
            "unsupported project map fingerprint algorithm `{}`",
            manifest.fingerprint.algorithm
        )));
    }
    if manifest.coverage.counts.entities != entities.len() as u64
        || manifest.coverage.counts.relations != relations.len() as u64
    {
        return Err(AppError::Other(format!(
            "project map is incomplete: manifest declares {} entities and {} relations, but {} and {} were loaded; refresh the map",
            manifest.coverage.counts.entities,
            manifest.coverage.counts.relations,
            entities.len(),
            relations.len()
        )));
    }

    let actual_content = knowledge_content_fingerprint(entities_raw, relations_raw);
    if manifest.fingerprint.content != actual_content {
        return Err(AppError::Other(
            "project map content fingerprint does not match its manifest; refresh the map".into(),
        ));
    }

    let mut entity_ids = HashSet::with_capacity(entities.len());
    if let Some(duplicate) = entities
        .iter()
        .map(|entity| entity.id.as_str())
        .find(|id| !entity_ids.insert(*id))
    {
        return Err(AppError::Other(format!(
            "project map contains duplicate entity id `{duplicate}`; refresh the map"
        )));
    }
    let mut relation_ids = HashSet::with_capacity(relations.len());
    if let Some(duplicate) = relations
        .iter()
        .map(|relation| relation.id.as_str())
        .find(|id| !relation_ids.insert(*id))
    {
        return Err(AppError::Other(format!(
            "project map contains duplicate relation id `{duplicate}`; refresh the map"
        )));
    }
    for relation in relations {
        for endpoint in [&relation.from, &relation.to] {
            if !entity_ids.contains(endpoint.as_str()) {
                return Err(AppError::Other(format!(
                    "project map relation `{}` references missing entity `{endpoint}`; refresh the map",
                    relation.id
                )));
            }
        }
    }
    Ok(())
}

/// Canonical writers hash the exact JSONL snapshot: entity bytes, a NUL
/// separator, then relationship bytes. Hashing the bytes also preserves the
/// distinction between omitted optional fields and explicit JSON nulls.
fn knowledge_content_fingerprint(entities_raw: &[u8], relations_raw: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(entities_raw);
    hasher.update([0]);
    hasher.update(relations_raw);
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

fn search_entities(
    entities: Vec<KnowledgeEntity>,
    relations: &[KnowledgeRelation],
    query: &str,
    requested_limit: usize,
) -> Vec<ProjectMapSearchHit> {
    let limit = requested_limit.clamp(1, MAX_QUERY_RESULTS);
    let context = query_scoring_context(query);
    let mut hits = relation_query_matches(&entities, relations, query).unwrap_or_else(|| {
        entities
            .into_iter()
            .filter_map(|entity| {
                let score = lexical_score(&entity, &context);
                (score > 0).then_some(ProjectMapSearchHit { entity, score })
            })
            .collect()
    });

    hits.sort_by(compare_search_hits);
    hits.truncate(limit);
    hits
}

#[derive(Debug, PartialEq, Eq)]
struct ProjectMapRevision {
    generated_at: u64,
    source_fingerprint: String,
    content_fingerprint: String,
    dirty: bool,
}

impl From<&KnowledgeManifest> for ProjectMapRevision {
    fn from(manifest: &KnowledgeManifest) -> Self {
        Self {
            generated_at: manifest.generated_at,
            source_fingerprint: manifest.fingerprint.source.clone(),
            content_fingerprint: manifest.fingerprint.content.clone(),
            dirty: manifest.dirty.value,
        }
    }
}

fn project_map_revision(project: &Path) -> Option<ProjectMapRevision> {
    let manifest = std::fs::read(project.join(".godot-vibe/brain/manifest.json")).ok()?;
    serde_json::from_slice::<KnowledgeManifest>(&manifest)
        .ok()
        .map(|manifest| ProjectMapRevision::from(&manifest))
}

fn project_map_query_result(
    map: ProjectMapData,
    query: &str,
    limit: usize,
    include_refreshed_map: bool,
) -> ProjectMapQueryResult {
    if include_refreshed_map {
        ProjectMapQueryResult {
            hits: search_entities(map.entities.clone(), &map.relations, query, limit),
            refreshed_map: Some(map),
        }
    } else {
        ProjectMapQueryResult {
            hits: search_entities(map.entities, &map.relations, query, limit),
            refreshed_map: None,
        }
    }
}

struct QueryScoringContext {
    tokens: Vec<String>,
    raw_query: String,
    natural_question: bool,
    addon_intent: bool,
    test_intent: bool,
    kind_intents: HashSet<String>,
}

fn tokenize_query(value: &str) -> Vec<String> {
    let tokens = tokenize_text(value)
        .into_iter()
        .filter(|token| !is_grammar_stopword(token))
        .collect::<Vec<_>>();
    let semantic = tokens
        .iter()
        .filter(|token| !is_query_intent_stopword(token))
        .cloned()
        .collect::<Vec<_>>();
    if semantic.is_empty() {
        tokens
    } else {
        semantic
    }
}

fn tokenize_text(value: &str) -> Vec<String> {
    static LOWER_UPPER: OnceLock<regex::Regex> = OnceLock::new();
    static ACRONYM_WORD: OnceLock<regex::Regex> = OnceLock::new();
    let lower_upper = LOWER_UPPER.get_or_init(|| {
        regex::Regex::new(r"([a-z0-9])([A-Z])").expect("camel-case boundary regex")
    });
    let acronym_word = ACRONYM_WORD.get_or_init(|| {
        regex::Regex::new(r"([A-Z]+)([A-Z][a-z])").expect("acronym boundary regex")
    });
    let separated = lower_upper.replace_all(value, "$1 $2");
    let separated = acronym_word.replace_all(&separated, "$1 $2");
    let mut seen = HashSet::new();
    separated
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .filter_map(|token| {
            let token = normalize_query_token(&token.to_lowercase());
            seen.insert(token.clone()).then_some(token)
        })
        .collect()
}

fn normalize_query_token(token: &str) -> String {
    if token.len() > 5 && token.ends_with("ing") {
        let mut base = token[..token.len() - 3].to_string();
        if base.len() > 2 {
            let mut chars = base.chars().rev();
            if chars.next() == chars.next() {
                base.pop();
            }
        }
        if base.ends_with('v') {
            base.push('e');
        }
        return base;
    }
    if token.len() > 4 && token.ends_with("ies") {
        return format!("{}y", &token[..token.len() - 3]);
    }
    if token.len() > 5 && token.ends_with("sses") {
        return token[..token.len() - 2].to_string();
    }
    if token.len() > 4
        && token.ends_with('s')
        && !token.ends_with("ss")
        && !token.ends_with("us")
        && !token.ends_with("is")
    {
        return token[..token.len() - 1].to_string();
    }
    token.to_string()
}

fn query_scoring_context(raw_query: &str) -> QueryScoringContext {
    let tokens = tokenize_query(raw_query);
    let kind_intents = tokens
        .iter()
        .filter_map(|token| {
            if matches!(token.as_str(), "class" | "struct" | "interface" | "enum") {
                Some("class".to_string())
            } else if is_entity_kind(token) {
                Some(token.clone())
            } else {
                None
            }
        })
        .collect::<HashSet<_>>();
    let raw_tokens = tokenize_text(raw_query);
    let natural_question = raw_tokens.iter().any(|token| {
        matches!(
            token.as_str(),
            "how" | "what" | "where" | "which" | "who" | "why"
        ) || is_query_intent_stopword(token)
    });
    let addon_intent =
        kind_intents.contains("addon") || raw_tokens.iter().any(|token| token == "plugin");
    let test_intent = raw_tokens
        .iter()
        .any(|token| matches!(token.as_str(), "test" | "testing" | "editor"));
    QueryScoringContext {
        tokens,
        raw_query: raw_query.to_string(),
        natural_question,
        addon_intent,
        test_intent,
        kind_intents,
    }
}

fn lexical_score(entity: &KnowledgeEntity, context: &QueryScoringContext) -> u32 {
    if context.tokens.is_empty() {
        return 0;
    }
    let name_tokens = tokenize_text(&entity.name)
        .into_iter()
        .collect::<HashSet<_>>();
    let path_tokens = tokenize_text(entity.path.as_deref().unwrap_or_default())
        .into_iter()
        .collect::<HashSet<_>>();
    let fact_tokens = tokenize_text(
        &entity
            .facts
            .iter()
            .map(|fact| format!("{} {}", fact.key, fact_value_text(&fact.value)))
            .collect::<Vec<_>>()
            .join(" "),
    )
    .into_iter()
    .collect::<HashSet<_>>();
    let exact = context.raw_query.trim();
    let mut score: u32 = if !exact.is_empty() && entity.name.eq_ignore_ascii_case(exact) {
        120
    } else {
        0
    };
    for token in &context.tokens {
        if name_tokens.contains(token) {
            score += 24;
        }
        if path_tokens.contains(token) {
            score += 8;
        }
        if fact_tokens.contains(token) {
            score += 3;
        }
    }
    if context.kind_intents.contains(&entity.kind) {
        score += 16;
    }
    if score == 0 {
        return 0;
    }
    if context.addon_intent {
        if entity.scope == "addon" {
            score += 24;
        }
    } else if entity.scope == "first-party" {
        score += 18;
    } else if entity.scope == "external" {
        score = score.saturating_sub(6);
    }
    if context.natural_question && context.kind_intents.is_empty() {
        if entity.kind == "class" {
            score += 14;
        } else if entity.kind == "script" {
            score += 9;
        }
        if matches!(entity.kind.as_str(), "class" | "script")
            && name_tokens.iter().any(|token| {
                matches!(
                    token.as_str(),
                    "controller" | "director" | "flow" | "hub" | "manager" | "service" | "system"
                )
            })
        {
            score += 10;
        }
    }
    if is_test_entity(entity) {
        if context.test_intent {
            score += 24;
        } else {
            score = score.saturating_sub(60);
        }
    }
    score
}

fn is_test_entity(entity: &KnowledgeEntity) -> bool {
    let name = entity.name.to_ascii_lowercase();
    let path = entity
        .path
        .as_deref()
        .unwrap_or_default()
        .replace('\\', "/")
        .to_ascii_lowercase();
    name.ends_with("test")
        || name.ends_with("tests")
        || path.starts_with("tests/")
        || path.contains("/tests/")
}

fn relation_query_matches(
    entities: &[KnowledgeEntity],
    relations: &[KnowledgeRelation],
    raw_query: &str,
) -> Option<Vec<ProjectMapSearchHit>> {
    let entity_by_id = entities
        .iter()
        .map(|entity| (entity.id.as_str(), entity))
        .collect::<HashMap<_, _>>();
    if let Some(target) = derived_target_from_query(raw_query) {
        let target_ids = entities
            .iter()
            .filter(|entity| entity.kind == "class" && entity_matches_name(entity, &target))
            .map(|entity| entity.id.as_str())
            .collect::<HashSet<_>>();
        return Some(unique_ranked(
            relations
                .iter()
                .filter(|relation| {
                    relation.kind == "extends" && target_ids.contains(relation.to.as_str())
                })
                .filter_map(|relation| entity_by_id.get(relation.from.as_str()).copied())
                .map(|entity| ProjectMapSearchHit {
                    entity: entity.clone(),
                    score: 200,
                })
                .collect(),
        ));
    }

    if let Some(module_name) = module_contents_target_from_query(raw_query) {
        let mut modules = entities
            .iter()
            .filter(|entity| entity.kind == "module" && entity_matches_name(entity, &module_name))
            .collect::<Vec<_>>();
        modules.sort_by(|left, right| {
            scope_priority(&left.scope)
                .cmp(&scope_priority(&right.scope))
                .then_with(|| left.id.cmp(&right.id))
        });
        if modules.is_empty() {
            return None;
        }
        let mut contains_by_owner: HashMap<&str, Vec<&KnowledgeRelation>> = HashMap::new();
        for relation in relations
            .iter()
            .filter(|relation| relation.kind == "contains")
        {
            contains_by_owner
                .entry(relation.from.as_str())
                .or_default()
                .push(relation);
        }
        let mut queue = modules
            .iter()
            .map(|entity| entity.id.as_str())
            .collect::<VecDeque<_>>();
        let mut visited = queue.iter().copied().collect::<HashSet<_>>();
        let mut scripts = Vec::new();
        while let Some(owner) = queue.pop_front() {
            for relation in contains_by_owner.get(owner).into_iter().flatten() {
                let Some(entity) = entity_by_id.get(relation.to.as_str()).copied() else {
                    continue;
                };
                if entity.kind == "module" && visited.insert(entity.id.as_str()) {
                    queue.push_back(entity.id.as_str());
                } else if entity.kind == "script" {
                    scripts.push(ProjectMapSearchHit {
                        entity: entity.clone(),
                        score: 200,
                    });
                }
            }
        }
        return Some(unique_ranked(scripts));
    }

    let dependency = dependency_target_from_query(raw_query)?;
    let subject_ids = entities
        .iter()
        .filter(|entity| entity.kind == "class" && entity_matches_name(entity, &dependency.target))
        .map(|entity| entity.id.as_str())
        .collect::<HashSet<_>>();
    if subject_ids.is_empty() {
        return None;
    }
    Some(unique_ranked(
        relations
            .iter()
            .filter(|relation| {
                matches!(
                    relation.kind.as_str(),
                    "references" | "extends" | "instantiates"
                )
            })
            .filter_map(|relation| {
                let related = if dependency.incoming {
                    subject_ids
                        .contains(relation.to.as_str())
                        .then_some(relation.from.as_str())
                } else {
                    subject_ids
                        .contains(relation.from.as_str())
                        .then_some(relation.to.as_str())
                }?;
                entity_by_id.get(related).copied()
            })
            .map(|entity| ProjectMapSearchHit {
                entity: entity.clone(),
                score: 200,
            })
            .collect(),
    ))
}

struct DependencyIntent {
    target: String,
    incoming: bool,
}

fn derived_target_from_query(query: &str) -> Option<String> {
    static DERIVED: OnceLock<regex::Regex> = OnceLock::new();
    static SUBCLASSES: OnceLock<regex::Regex> = OnceLock::new();
    let patterns = [
        DERIVED.get_or_init(|| {
            regex::Regex::new(
                r"(?i)\b(?:types?|classes?)\s+(?:that\s+)?(?:derive|derived|inherit|inheriting|extend|extending)\s+(?:from\s+)?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)",
            )
            .expect("extended class query regex")
        }),
        SUBCLASSES.get_or_init(|| {
            regex::Regex::new(
                r"(?i)\b(?:subclasses|implementations|derivatives)\s+of\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)",
            )
            .expect("subclass query regex")
        }),
    ];
    patterns.iter().find_map(|pattern| {
        pattern
            .captures(query)
            .and_then(|captures| captures.get(1))
            .map(|capture| capture.as_str().to_string())
    })
}

fn module_contents_target_from_query(query: &str) -> Option<String> {
    static MODULE_CONTENTS: OnceLock<regex::Regex> = OnceLock::new();
    MODULE_CONTENTS
        .get_or_init(|| {
            regex::Regex::new(
                r"(?i)\bscripts?\s+(?:contained\s+)?in\s+(?:the\s+)?(.+?)\s+(?:modules?|folders?|directories?)\b",
            )
            .expect("module contents query regex")
        })
        .captures(query)
        .and_then(|captures| captures.get(1))
        .map(|capture| capture.as_str().trim().to_string())
        .filter(|value| !value.is_empty())
}

fn dependency_target_from_query(query: &str) -> Option<DependencyIntent> {
    static DEPENDENCY: OnceLock<regex::Regex> = OnceLock::new();
    let captures = DEPENDENCY
        .get_or_init(|| {
            regex::Regex::new(
                r"(?i)^\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s+(dependencies|dependents|references)\s*[?!.]*\s*$",
            )
            .expect("dependency query regex")
        })
        .captures(query)?;
    Some(DependencyIntent {
        target: captures.get(1)?.as_str().to_string(),
        incoming: captures.get(2)?.as_str().eq_ignore_ascii_case("dependents"),
    })
}

fn entity_matches_name(entity: &KnowledgeEntity, expected: &str) -> bool {
    entity.name.eq_ignore_ascii_case(expected)
        || entity.facts.iter().any(|fact| {
            fact.key == "className" && fact_value_text(&fact.value).eq_ignore_ascii_case(expected)
        })
}

fn unique_ranked(values: Vec<ProjectMapSearchHit>) -> Vec<ProjectMapSearchHit> {
    let mut seen = HashSet::new();
    let mut unique = values
        .into_iter()
        .filter(|hit| seen.insert(hit.entity.id.clone()))
        .collect::<Vec<_>>();
    unique.sort_by(compare_search_hits);
    unique
}

fn compare_search_hits(
    left: &ProjectMapSearchHit,
    right: &ProjectMapSearchHit,
) -> std::cmp::Ordering {
    right
        .score
        .cmp(&left.score)
        .then_with(|| scope_priority(&left.entity.scope).cmp(&scope_priority(&right.entity.scope)))
        .then_with(|| left.entity.id.cmp(&right.entity.id))
}

fn scope_priority(scope: &str) -> u8 {
    match scope {
        "first-party" => 0,
        "project" => 1,
        "addon" => 2,
        "external" => 3,
        _ => 4,
    }
}

fn is_entity_kind(value: &str) -> bool {
    matches!(
        value,
        "project" | "addon" | "scene" | "resource" | "script" | "class" | "module" | "shader"
    )
}

fn is_grammar_stopword(value: &str) -> bool {
    matches!(
        value,
        "a" | "an"
            | "and"
            | "are"
            | "as"
            | "at"
            | "be"
            | "by"
            | "do"
            | "does"
            | "for"
            | "from"
            | "how"
            | "i"
            | "in"
            | "is"
            | "it"
            | "of"
            | "on"
            | "or"
            | "that"
            | "the"
            | "this"
            | "to"
            | "what"
            | "where"
            | "which"
            | "who"
            | "why"
            | "with"
    )
}

fn is_query_intent_stopword(value: &str) -> bool {
    matches!(
        value,
        "find"
            | "handle"
            | "handling"
            | "locate"
            | "responsibility"
            | "responsible"
            | "show"
            | "tell"
            | "use"
            | "used"
    )
}

fn fact_value_text(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" "),
        other => other.to_string(),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn process_detail(primary: &[u8], fallback: &[u8]) -> String {
    for bytes in [primary, fallback] {
        if let Some(line) = String::from_utf8_lossy(bytes)
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
        {
            return line.trim().to_string();
        }
    }
    "gvibe brain exited unsuccessfully".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_answer_keeps_only_entity_ids_that_exist() {
        let known: HashSet<&str> = ["script:Player.gd", "class:Player"].into_iter().collect();
        let answer = parse_answer(
            "Sure.\n```json\n{\"answer\":\"It moves the player.\",\"entities\":\
             [\"class:Player\",\"class:Ghost\",\"class:Player\"]}\n```",
            &known,
        );
        assert_eq!(answer.answer, "It moves the player.");
        // The unknown id is dropped and the repeat collapsed, so every chip the
        // drawer renders resolves to something selectable.
        assert_eq!(answer.entity_ids, vec!["class:Player".to_string()]);
    }

    #[test]
    fn a_reply_without_a_json_block_still_shows_its_prose() {
        let known: HashSet<&str> = HashSet::new();
        let answer = parse_answer("There are 42 textures under res://art.", &known);
        assert_eq!(answer.answer, "There are 42 textures under res://art.");
        assert!(answer.entity_ids.is_empty());
    }

    fn store_path(root: &Path, name: &str) -> PathBuf {
        root.join(".godot-vibe").join("brain").join(name)
    }

    fn write_records<T: Serialize>(path: &Path, records: &[T]) {
        let raw = records
            .iter()
            .map(|record| serde_json::to_string(record).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(path, if raw.is_empty() { raw } else { raw + "\n" }).unwrap();
    }

    fn rewrite_manifest_integrity(root: &Path) {
        let entities_path = store_path(root, "entities.jsonl");
        let relations_path = store_path(root, "relations.jsonl");
        let entities: Vec<KnowledgeEntity> = read_jsonl(&entities_path).unwrap();
        let relations: Vec<KnowledgeRelation> = read_jsonl(&relations_path).unwrap();
        let entities_raw = std::fs::read(entities_path).unwrap();
        let relations_raw = std::fs::read(relations_path).unwrap();
        let manifest_path = store_path(root, "manifest.json");
        let mut manifest: KnowledgeManifest =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        manifest.coverage.counts.entities = entities.len() as u64;
        manifest.coverage.counts.relations = relations.len() as u64;
        manifest.fingerprint.content = knowledge_content_fingerprint(&entities_raw, &relations_raw);
        std::fs::write(manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    }

    fn fixture_store() -> (PathBuf, KnowledgeManifest) {
        let root =
            std::env::temp_dir().join(format!("godot-vibe-project-map-{}", nanoid::nanoid!(10)));
        let directory = root.join(".godot-vibe").join("brain");
        std::fs::create_dir_all(&directory).unwrap();
        let mut manifest = KnowledgeManifest {
            schema_version: 2,
            generated_at: now_ms(),
            project: KnowledgeProject {
                id: "project:sample".into(),
                path: ".".into(),
                name: "Sample".into(),
                is_godot_project: true,
            },
            coverage: KnowledgeCoverage {
                cap: 100,
                discovered: 2,
                scanned: 2,
                complete: true,
                truncated: false,
                errors: Vec::new(),
                counts: KnowledgeCounts {
                    files: 2,
                    first_party_scripts: 1,
                    addon_scripts: 0,
                    scenes: 0,
                    resources: 0,
                    shaders: 0,
                    entities: 2,
                    relations: 1,
                },
                scopes: KnowledgeScopes {
                    first_party: KnowledgeScope {
                        root: "res://".into(),
                        discovered: 2,
                        scanned: 2,
                        scripts: 1,
                    },
                    addons: KnowledgeScope {
                        root: "res://addons".into(),
                        discovered: 0,
                        scanned: 0,
                        scripts: 0,
                    },
                },
            },
            fingerprint: KnowledgeFingerprint {
                algorithm: "sha256".into(),
                source: "source-hash".into(),
                content: String::new(),
            },
            dirty: KnowledgeDirty {
                value: false,
                reasons: Vec::new(),
            },
        };
        let provenance = KnowledgeProvenance {
            source: "gdscript-text".into(),
            path: "res://player_controller.gd".into(),
            line: Some(3),
            evidence: Some("class_name PlayerController extends CharacterBody2D".into()),
            heuristic: None,
        };
        let script = KnowledgeEntity {
            id: "script:player".into(),
            kind: "script".into(),
            name: "PlayerController.gd".into(),
            path: Some("res://player_controller.gd".into()),
            scope: "first-party".into(),
            facts: vec![KnowledgeFact {
                key: "purpose".into(),
                value: Value::String("handles character movement".into()),
                provenance: provenance.clone(),
                observed_at: now_ms(),
                confidence: Some(0.8),
            }],
        };
        let entity_type = KnowledgeEntity {
            id: "class:player".into(),
            kind: "class".into(),
            name: "PlayerController".into(),
            path: None,
            scope: "first-party".into(),
            facts: Vec::new(),
        };
        let entity_records = vec![script, entity_type];
        let entities = entity_records
            .iter()
            .map(|entity| serde_json::to_string(entity).unwrap())
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        std::fs::write(directory.join("entities.jsonl"), entities.as_bytes()).unwrap();
        let relation = KnowledgeRelation {
            id: "declares:player".into(),
            kind: "declares".into(),
            from: "script:player".into(),
            to: "class:player".into(),
            provenance,
            observed_at: now_ms(),
            confidence: None,
        };
        let relation_records = vec![relation];
        let relations = serde_json::to_string(&relation_records[0]).unwrap() + "\n";
        std::fs::write(directory.join("relations.jsonl"), relations.as_bytes()).unwrap();
        std::fs::write(directory.join("index.md"), "# Sample\n").unwrap();
        manifest.fingerprint.content =
            knowledge_content_fingerprint(entities.as_bytes(), relations.as_bytes());
        std::fs::write(
            directory.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        (root, manifest)
    }

    fn test_entity(
        id: &str,
        kind: &str,
        name: &str,
        scope: &str,
        path: Option<&str>,
    ) -> KnowledgeEntity {
        KnowledgeEntity {
            id: id.into(),
            kind: kind.into(),
            name: name.into(),
            path: path.map(str::to_string),
            scope: scope.into(),
            facts: Vec::new(),
        }
    }

    fn test_relation(id: &str, kind: &str, from: &str, to: &str) -> KnowledgeRelation {
        KnowledgeRelation {
            id: id.into(),
            kind: kind.into(),
            from: from.into(),
            to: to.into(),
            provenance: KnowledgeProvenance {
                source: "gdscript-text".into(),
                path: "res://test.gd".into(),
                line: Some(1),
                evidence: None,
                heuristic: None,
            },
            observed_at: now_ms(),
            confidence: None,
        }
    }

    #[test]
    fn reads_the_canonical_store_and_checks_manifest_counts() {
        let (root, manifest) = fixture_store();
        let map = load_project_map(&root).unwrap().expect("map");
        assert_eq!(map.manifest.project.id, manifest.project.id);
        assert_eq!(map.entities.len(), 2);
        assert_eq!(map.relations.len(), 1);
        assert!(project_map_is_initialized(&root));
        let manifest_path = store_path(&root, "manifest.json");
        let mut dirty = manifest;
        dirty.dirty.value = true;
        std::fs::write(&manifest_path, serde_json::to_vec(&dirty).unwrap()).unwrap();
        assert!(!project_map_is_initialized(&root));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn normal_reads_ensure_freshness_while_refresh_forces_a_rebuild() {
        assert_eq!(
            brain_args("/game", true),
            ["brain", "--ensure", "--project", "/game"]
        );
        assert_eq!(brain_args("/game", false), ["brain", "--project", "/game"]);
    }

    #[test]
    fn hashes_project_brain_jsonl_bytes_with_omitted_optional_fields() {
        let entities = b"{\"id\":\"class:external:Node\",\"kind\":\"class\",\"name\":\"Node\",\"scope\":\"external\",\"facts\":[]}\n";
        assert_eq!(
            knowledge_content_fingerprint(entities, b""),
            "d9d5bf78d1860716836401f00baac46e2c3ea1850a55e2f697449542d04c8452"
        );

        let entity: KnowledgeEntity =
            serde_json::from_slice(&entities[..entities.len() - 1]).unwrap();
        assert!(entity.path.is_none());
    }

    #[test]
    fn query_matches_fact_values_and_orders_name_matches_first() {
        let (root, _) = fixture_store();
        let map = load_project_map(&root).unwrap().expect("map");
        let movement = search_entities(
            map.entities.clone(),
            &map.relations,
            "character movement",
            20,
        );
        assert_eq!(movement.len(), 1);
        assert_eq!(movement[0].entity.id, "script:player");

        let player = search_entities(map.entities, &map.relations, "playercontroller", 20);
        assert_eq!(player.len(), 1);
        assert_eq!(player[0].entity.id, "class:player");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn natural_question_matches_a_save_system_by_normalized_prefix() {
        let (root, _) = fixture_store();
        let map = load_project_map(&root).unwrap().expect("map");
        let mut entities = map.entities;
        entities.push(KnowledgeEntity {
            id: "class:save-system".into(),
            kind: "class".into(),
            name: "SaveSystem".into(),
            path: Some("res://systems/save_system.gd".into()),
            scope: "first-party".into(),
            facts: Vec::new(),
        });

        let hits = search_entities(entities, &map.relations, "what handles saving?", 20);
        assert_eq!(
            hits.first().map(|hit| hit.entity.id.as_str()),
            Some("class:save-system")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn natural_runtime_questions_do_not_rank_test_classes_above_the_owner() {
        let mut owner = test_entity(
            "class:level-manager",
            "class",
            "LevelManager",
            "first-party",
            Some("res://scripts/managers/level_manager.gd"),
        );
        owner.facts.push(KnowledgeFact {
            key: "function".into(),
            value: Value::String("func _spawn_scheduled_targets()".into()),
            provenance: KnowledgeProvenance {
                source: "gdscript-text".into(),
                path: "res://scripts/managers/level_manager.gd".into(),
                line: Some(685),
                evidence: None,
                heuristic: Some(true),
            },
            observed_at: now_ms(),
            confidence: Some(0.85),
        });
        let coverage = test_entity(
            "class:level-manager-spawn-tests",
            "class",
            "LevelManagerSpawnTests",
            "first-party",
            Some("res://tests/level_manager_spawn_test.gd"),
        );

        let runtime = search_entities(
            vec![coverage.clone(), owner.clone()],
            &[],
            "which system handles scheduled spawning?",
            20,
        );
        assert_eq!(runtime[0].entity.id, owner.id);

        let tests = search_entities(
            vec![owner, coverage.clone()],
            &[],
            "which test covers scheduled spawning?",
            20,
        );
        assert_eq!(tests[0].entity.id, coverage.id);
    }

    #[test]
    fn whole_token_scoring_ignores_stopword_and_substring_noise() {
        let entities = vec![
            test_entity(
                "class:save-system",
                "class",
                "SaveSystem",
                "first-party",
                Some("res://systems/save_system.gd"),
            ),
            test_entity(
                "class:vendor-save-adapter",
                "class",
                "VendorSaveAdapter",
                "addon",
                Some("res://addons/vendor_tools/vendor_save_adapter.gd"),
            ),
            test_entity(
                "class:handle-registry",
                "class",
                "HandleRegistry",
                "addon",
                Some("res://addons/vendor_tools/handle_registry.gd"),
            ),
            test_entity(
                "class:massive-renderer",
                "class",
                "MassiveRenderer",
                "first-party",
                Some("res://rendering/massive_renderer.gd"),
            ),
        ];

        let hits = search_entities(entities, &[], "what handles saving?", 20);
        assert_eq!(hits[0].entity.id, "class:save-system");
        assert!(hits
            .iter()
            .any(|hit| hit.entity.id == "class:vendor-save-adapter"));
        assert!(!hits
            .iter()
            .any(|hit| hit.entity.id == "class:handle-registry"));
        assert!(!hits
            .iter()
            .any(|hit| hit.entity.id == "class:massive-renderer"));
    }

    #[test]
    fn explicit_addon_query_prefers_the_addon_scope() {
        let entities = vec![
            test_entity(
                "module:local-input",
                "module",
                "dialogue_manager",
                "first-party",
                Some("res://dialogue_manager"),
            ),
            test_entity(
                "addon:dialogue-manager",
                "addon",
                "dialogue_manager",
                "addon",
                Some("res://addons/dialogue_manager/plugin.cfg"),
            ),
        ];

        let hits = search_entities(entities, &[], "addon dialogue_manager", 20);
        assert_eq!(hits[0].entity.id, "addon:dialogue-manager");
    }

    #[test]
    fn module_query_returns_recursively_contained_scripts() {
        let entities = vec![
            test_entity(
                "module:combat",
                "module",
                "Combat",
                "first-party",
                Some("res://combat"),
            ),
            test_entity(
                "module:bosses",
                "module",
                "Bosses",
                "first-party",
                Some("res://combat/bosses"),
            ),
            test_entity(
                "script:combat-director",
                "script",
                "combat_director.gd",
                "first-party",
                Some("res://combat/combat_director.gd"),
            ),
            test_entity(
                "script:boss-spawner",
                "script",
                "boss_spawner.gd",
                "first-party",
                Some("res://combat/bosses/boss_spawner.gd"),
            ),
        ];
        let relations = vec![
            test_relation(
                "contains:combat-director",
                "contains",
                "module:combat",
                "script:combat-director",
            ),
            test_relation(
                "contains:bosses",
                "contains",
                "module:combat",
                "module:bosses",
            ),
            test_relation(
                "contains:boss-spawner",
                "contains",
                "module:bosses",
                "script:boss-spawner",
            ),
        ];

        let hits = search_entities(entities, &relations, "scripts in Combat folder", 20);
        assert_eq!(
            hits.iter()
                .map(|hit| hit.entity.id.as_str())
                .collect::<Vec<_>>(),
            ["script:boss-spawner", "script:combat-director"]
        );
        assert!(hits.iter().all(|hit| hit.score == 200));
    }

    #[test]
    fn relation_queries_follow_extensions_dependencies_and_dependents() {
        let entities = vec![
            test_entity("class:node2d", "class", "Node2D", "external", None),
            test_entity("class:boss", "class", "FishBoss", "first-party", None),
            test_entity("class:weapon", "class", "WeaponData", "first-party", None),
            test_entity("class:view", "class", "BossView", "first-party", None),
        ];
        let relations = vec![
            test_relation("extends:boss", "extends", "class:boss", "class:node2d"),
            test_relation(
                "references:weapon",
                "references",
                "class:boss",
                "class:weapon",
            ),
            test_relation("references:boss", "references", "class:view", "class:boss"),
        ];

        let derived = search_entities(entities.clone(), &relations, "classes extending Node2D", 20);
        assert_eq!(derived[0].entity.id, "class:boss");

        let dependencies =
            search_entities(entities.clone(), &relations, "FishBoss dependencies", 20);
        assert_eq!(
            dependencies
                .iter()
                .map(|hit| hit.entity.id.as_str())
                .collect::<HashSet<_>>(),
            HashSet::from(["class:node2d", "class:weapon"])
        );

        let dependents = search_entities(entities, &relations, "FishBoss dependents", 20);
        assert_eq!(dependents[0].entity.id, "class:view");
    }

    #[test]
    fn map_revision_detects_clean_snapshot_changes_and_dirty_markers() {
        let (root, _) = fixture_store();
        let manifest_path = store_path(&root, "manifest.json");
        let initial = project_map_revision(&root).expect("initial revision");
        let mut manifest: KnowledgeManifest =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        manifest.generated_at += 1;
        manifest.fingerprint.source = "changed-source-fingerprint".into();
        manifest.dirty.value = false;
        std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        let changed = project_map_revision(&root).expect("changed revision");
        assert_ne!(initial, changed);

        manifest.dirty.value = true;
        manifest.dirty.reasons.push(KnowledgeDirtyReason {
            at: now_ms(),
            change: "res://player_controller.gd changed".into(),
        });
        std::fs::write(manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        let dirty = project_map_revision(&root).expect("dirty revision");
        assert_ne!(changed, dirty);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn query_response_carries_the_full_map_only_after_reconciliation() {
        let (root, _) = fixture_store();
        let map = load_project_map(&root).unwrap().expect("map");

        let clean = project_map_query_result(map.clone(), "PlayerController", 20, false);
        assert!(clean.refreshed_map.is_none());
        assert!(serde_json::to_value(&clean)
            .unwrap()
            .get("refreshedMap")
            .is_none());

        let refreshed = project_map_query_result(map, "PlayerController", 20, true);
        assert!(refreshed.refreshed_map.is_some());
        assert!(serde_json::to_value(&refreshed)
            .unwrap()
            .get("refreshedMap")
            .is_some());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn missing_store_is_an_empty_state_not_a_parse_error() {
        let root = std::env::temp_dir().join(format!(
            "godot-vibe-project-map-missing-{}",
            nanoid::nanoid!(10)
        ));
        std::fs::create_dir_all(&root).unwrap();
        assert!(load_project_map(&root).unwrap().is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_partial_store_instead_of_showing_false_counts() {
        let (root, _) = fixture_store();
        std::fs::write(
            root.join(".godot-vibe")
                .join("brain")
                .join("relations.jsonl"),
            "",
        )
        .unwrap();
        let error = load_project_map(&root).unwrap_err().to_string();
        assert!(error.contains("manifest declares 2 entities and 1 relations"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_same_count_records_from_a_different_snapshot() {
        let (root, _) = fixture_store();
        let path = store_path(&root, "entities.jsonl");
        let mut entities: Vec<KnowledgeEntity> = read_jsonl(&path).unwrap();
        entities[0].name = "MixedSnapshotController".into();
        write_records(&path, &entities);

        let error = load_project_map(&root).unwrap_err().to_string();
        assert!(error.contains("content fingerprint does not match"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_a_hash_consistent_relation_with_a_missing_endpoint() {
        let (root, _) = fixture_store();
        let path = store_path(&root, "relations.jsonl");
        let mut relations: Vec<KnowledgeRelation> = read_jsonl(&path).unwrap();
        relations[0].to = "class:missing".into();
        write_records(&path, &relations);
        rewrite_manifest_integrity(&root);

        let error = load_project_map(&root).unwrap_err().to_string();
        assert!(error.contains("references missing entity `class:missing`"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_hash_consistent_duplicate_entity_ids() {
        let (root, _) = fixture_store();
        let path = store_path(&root, "entities.jsonl");
        let mut entities: Vec<KnowledgeEntity> = read_jsonl(&path).unwrap();
        entities[1].id = entities[0].id.clone();
        write_records(&path, &entities);
        rewrite_manifest_integrity(&root);

        let error = load_project_map(&root).unwrap_err().to_string();
        assert!(error.contains("duplicate entity id"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_hash_consistent_duplicate_relation_ids() {
        let (root, _) = fixture_store();
        let path = store_path(&root, "relations.jsonl");
        let mut relations: Vec<KnowledgeRelation> = read_jsonl(&path).unwrap();
        let mut duplicate = relations[0].clone();
        duplicate.kind = "references".into();
        relations.push(duplicate);
        write_records(&path, &relations);
        rewrite_manifest_integrity(&root);

        let error = load_project_map(&root).unwrap_err().to_string();
        assert!(error.contains("duplicate relation id"));
        let _ = std::fs::remove_dir_all(root);
    }
}
