import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { join } from "@tauri-apps/api/path";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api } from "@/api";
import {
  formatKnowledgeFactValue,
  formatKnowledgeKind,
  formatProjectMapRelation,
  groupProjectMapFacts,
  groupProjectMapHits,
  localProjectMapHits,
  projectMapAncestorIds,
  projectMapBreadcrumbs,
  projectMapChildren,
  projectMapConnections,
  projectMapFacetCounts,
  projectMapNeighborhood,
  pushProjectMapHistory,
  reconcileProjectMapHistory,
  type ProjectMapConnection,
  type ProjectMapFacet,
  type ProjectMapNeighborhood,
  type ProjectMapNeighborhoodArm,
  type ProjectMapNeighborhoodArmId,
} from "@/lib/projectMap";
import { relativeTime } from "@/lib/relativeTime";
import { useUiStore } from "@/stores/useUiStore";
import type {
  KnowledgeEntity,
  KnowledgeEntityKind,
  KnowledgeFact,
  KnowledgeRelationKind,
  ProjectMapAnswer,
  ProjectMapData,
  ProjectMapSearchHit,
} from "@/types/projectMap";
import {
  ChevronIcon,
  CloseIcon,
  MapIcon,
  RefreshIcon,
  SearchIcon,
} from "@/components/shell/icons";

const FACETS: Array<{ id: ProjectMapFacet; label: string }> = [
  { id: "all", label: "Overview" },
  { id: "module", label: "Folders" },
  { id: "scene", label: "Scenes" },
  { id: "prefab", label: "Prefabs" },
  { id: "script", label: "Scripts" },
  { id: "type", label: "Types" },
  { id: "package", label: "Packages" },
];

const SEARCH_EXAMPLES = [
  "what handles saving?",
  "types derived from MonoBehaviour",
  "what handles player input?",
];

const ASK_EXAMPLES = [
  "what does the player controller do?",
  "how many textures do we have?",
];

interface NavigationState {
  history: string[];
  index: number;
}

/** Read-only Q&A about the project, owned by the drawer and rendered by
 *  [`AskBox`]. */
interface AskState {
  question: string;
  asking: boolean;
  answer: ProjectMapAnswer | null;
  error: string | null;
  onQuestion: (question: string) => void;
  /** Explicit text wins over the input's current value, so an example chip can
   *  fill and ask in one click without waiting for state to settle. */
  onAsk: (question?: string) => void;
  onDismiss: () => void;
}

export default function ProjectMapDrawer({ project }: { project: string }) {
  const open = useUiStore((state) => state.projectMapOpen);
  const setOpen = useUiStore((state) => state.setProjectMapOpen);
  const [data, setData] = useState<ProjectMapData | null>(null);
  const [remoteHits, setRemoteHits] = useState<ProjectMapSearchHit[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const [navigation, setNavigation] = useState<NavigationState>({
    history: [],
    index: -1,
  });
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState<string | null>(null);
  const [facet, setFacet] = useState<ProjectMapFacet>("all");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [querying, setQuerying] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<ProjectMapAnswer | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const inspectorHeadingRef = useRef<HTMLHeadingElement>(null);
  const scrollSelectionIntoTreeRef = useRef(false);
  const inertAppRootRef = useRef<{
    element: HTMLElement;
    wasInert: boolean;
  } | null>(null);
  const readEpoch = useRef(0);
  const searchEpoch = useRef(0);
  const refreshEpoch = useRef(0);
  const revealEpoch = useRef(0);
  const projectOperationQueue = useRef<Promise<void>>(Promise.resolve());
  const mapLoadInFlight = useRef<{
    project: string;
    promise: Promise<ProjectMapData | null>;
  } | null>(null);

  function enqueueProjectOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = projectOperationQueue.current.then(
      () => operation(),
      () => operation(),
    );
    projectOperationQueue.current = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function trackMapLoad(
    nextProject: string,
    promise: Promise<ProjectMapData | null>,
  ): Promise<ProjectMapData | null> {
    const tracked = { project: nextProject, promise };
    mapLoadInFlight.current = tracked;
    void promise.then(
      () => {
        if (mapLoadInFlight.current === tracked) mapLoadInFlight.current = null;
      },
      () => {
        if (mapLoadInFlight.current === tracked) mapLoadInFlight.current = null;
      },
    );
    return promise;
  }

  function readMap(nextProject: string): Promise<ProjectMapData | null> {
    const current = mapLoadInFlight.current;
    if (current?.project === nextProject) return current.promise;
    return trackMapLoad(
      nextProject,
      enqueueProjectOperation(() => api.readProjectMap(nextProject)),
    );
  }

  function setSelection(id: string | null) {
    selectedIdRef.current = id;
    setSelectedId(id);
  }

  function restoreAppRoot() {
    const inertState = inertAppRootRef.current;
    if (!inertState) return;
    inertState.element.inert = inertState.wasInert;
    inertAppRootRef.current = null;
  }

  function expandSelectionAncestors(
    nextData: ProjectMapData | null,
    id: string | null,
  ) {
    if (!nextData || !id) return;
    const ancestors = projectMapAncestorIds(nextData, id);
    scrollSelectionIntoTreeRef.current = true;
    if (ancestors.length === 0) {
      setExpandedIds((current) => new Set(current));
      return;
    }
    setExpandedIds((current) => {
      const next = new Set(current);
      for (const ancestorId of ancestors) next.add(ancestorId);
      return next;
    });
  }

  function adoptData(next: ProjectMapData | null, resetNavigation = false) {
    const current = selectedIdRef.current;
    const nextId =
      (current && next?.entities.some((entity) => entity.id === current)
        ? current
        : null) ??
      next?.entities.find((entity) => entity.kind === "project")?.id ??
      next?.entities[0]?.id ??
      null;

    setData(next);
    setSelection(nextId);
    if (resetNavigation || !nextId) {
      setNavigation({
        history: nextId ? [nextId] : [],
        index: nextId ? 0 : -1,
      });
      const scriptsRoot = next?.entities.find(
        (entity) => entity.kind === "module" && entity.path === "Assets/Scripts",
      );
      const nextExpanded = new Set(scriptsRoot ? [scriptsRoot.id] : []);
      if (next && nextId) {
        scrollSelectionIntoTreeRef.current = true;
        for (const ancestorId of projectMapAncestorIds(next, nextId)) {
          nextExpanded.add(ancestorId);
        }
      }
      setExpandedIds(nextExpanded);
    } else {
      setNavigation((currentNavigation) =>
        reconcileProjectMapHistory(
          currentNavigation.history,
          currentNavigation.index,
          next?.entities.map((entity) => entity.id) ?? [],
          nextId,
        ),
      );
      expandSelectionAncestors(next, nextId);
    }
  }

  useEffect(() => {
    if (!open) return;
    const request = ++readEpoch.current;
    searchEpoch.current += 1;
    refreshEpoch.current += 1;
    revealEpoch.current += 1;
    let alive = true;
    setLoading(true);
    setError(null);
    setQuery("");
    setQuerying(false);
    setRefreshing(false);
    setSubmittedQuery(null);
    setRemoteHits([]);
    setQueryError(null);
    setRevealError(null);
    setFacet("all");
    void readMap(project)
      .then((next) => {
        if (alive && request === readEpoch.current) {
          adoptData(next, true);
        }
      })
      .catch((nextError) => {
        if (alive && request === readEpoch.current) {
          adoptData(null, true);
          setError(String(nextError));
        }
      })
      .finally(() => {
        if (alive && request === readEpoch.current) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, project]);

  function closeMap() {
    readEpoch.current += 1;
    searchEpoch.current += 1;
    refreshEpoch.current += 1;
    revealEpoch.current += 1;
    setLoading(false);
    setQuerying(false);
    setRefreshing(false);
    setOpen(false);
    requestAnimationFrame(() => {
      restoreAppRoot();
      document.getElementById("project-map-trigger")?.focus();
    });
  }

  useEffect(() => {
    if (!open) return;
    const appRoot = document.getElementById("root");
    if (!appRoot) return;
    inertAppRootRef.current = {
      element: appRoot,
      wasInert: appRoot.inert,
    };
    appRoot.inert = true;
    return restoreAppRoot;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => dialogRef.current?.focus());
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMap();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), summary, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === dialogRef.current)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, setOpen]);

  useEffect(() => {
    if (!open || loading || !data) return;
    const frame = requestAnimationFrame(() => {
      if (
        document.activeElement === dialogRef.current ||
        document.activeElement === document.body
      ) {
        searchRef.current?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [data, loading, open]);

  function changeQuery(next: string) {
    searchEpoch.current += 1;
    setQuery(next);
    setQuerying(false);
    setSubmittedQuery(null);
    setRemoteHits([]);
    setQueryError(null);
  }

  async function searchMap(value = query) {
    const nextQuery = value.trim();
    if (!nextQuery || !data || loading || querying || refreshing) return;
    const request = ++searchEpoch.current;
    setQuery(nextQuery);
    setFacet("all");
    setSubmittedQuery(nextQuery);
    setRemoteHits([]);
    setQueryError(null);
    setQuerying(true);
    try {
      const next = await enqueueProjectOperation(() =>
        api.queryProjectMap(project, nextQuery, 50),
      );
      if (request !== searchEpoch.current) return;
      if (next.refreshedMap) adoptData(next.refreshedMap);
      setRemoteHits(next.hits);
    } catch (nextError) {
      if (request === searchEpoch.current) {
        setRemoteHits([]);
        setQueryError(String(nextError));
      }
    } finally {
      if (request === searchEpoch.current) setQuerying(false);
    }
  }

  async function refresh() {
    if (loading || querying || refreshing) return;
    const request = ++refreshEpoch.current;
    setRefreshing(true);
    setError(null);
    try {
      const next = await trackMapLoad(
        project,
        enqueueProjectOperation(() => api.refreshProjectMap(project)),
      );
      if (request !== refreshEpoch.current || !next) return;
      adoptData(next, true);
      setQuery("");
      setSubmittedQuery(null);
      setRemoteHits([]);
      setQueryError(null);
      setFacet("all");
    } catch (nextError) {
      if (request === refreshEpoch.current) setError(String(nextError));
    } finally {
      if (request === refreshEpoch.current) setRefreshing(false);
    }
  }

  function navigateTo(id: string, focusInspector = false) {
    expandSelectionAncestors(data, id);
    if (selectedIdRef.current === id) {
      if (focusInspector) {
        requestAnimationFrame(() => inspectorHeadingRef.current?.focus());
      }
      return;
    }
    revealEpoch.current += 1;
    setRevealError(null);
    setSelection(id);
    setNavigation((current) =>
      pushProjectMapHistory(current.history, current.index, id),
    );
    if (focusInspector) {
      requestAnimationFrame(() => inspectorHeadingRef.current?.focus());
    }
  }

  /** Ask the agent about the project. Read-only — the answer is prose plus the
   *  entities it cited, which we jump to so the map shows what it is talking
   *  about. */
  async function onAsk(explicit?: string) {
    const asked = (explicit ?? question).trim();
    if (!asked || asking) return;
    if (explicit) setQuestion(explicit);
    setAsking(true);
    setAskError(null);
    setAnswer(null);
    try {
      const result = await enqueueProjectOperation(() =>
        api.askProjectMap(project, asked),
      );
      setAnswer(result);
      const [first] = result.entityIds;
      if (first) navigateTo(first);
    } catch (e) {
      setAskError(String(e));
    } finally {
      setAsking(false);
    }
  }

  function navigateBack() {
    if (navigation.index <= 0) return;
    const index = navigation.index - 1;
    const id = navigation.history[index];
    revealEpoch.current += 1;
    setRevealError(null);
    setSelection(id);
    expandSelectionAncestors(data, id);
    setNavigation({ ...navigation, index });
    requestAnimationFrame(() => inspectorHeadingRef.current?.focus());
  }

  function showFacet(next: ProjectMapFacet) {
    setFacet(next);
    setQuery("");
    setSubmittedQuery(null);
    setRemoteHits([]);
    setQueryError(null);
  }

  function selectFacet(next: ProjectMapFacet) {
    searchEpoch.current += 1;
    setFacet(next);
    setQuerying(false);
    setSubmittedQuery(null);
    setRemoteHits([]);
    setQueryError(null);
  }

  async function reveal(entity: KnowledgeEntity) {
    if (!entity.path || entity.scope === "external") return;
    const request = ++revealEpoch.current;
    setRevealError(null);
    try {
      const target =
        entity.path === "." ? project : await join(project, entity.path);
      await revealItemInDir(target);
    } catch (nextError) {
      if (
        request === revealEpoch.current &&
        selectedIdRef.current === entity.id
      ) {
        setRevealError(String(nextError));
      }
    }
  }

  const selected = useMemo(
    () => data?.entities.find((entity) => entity.id === selectedId) ?? null,
    [data, selectedId],
  );
  const connections = useMemo(
    () =>
      data && selected
        ? projectMapConnections(data, selected.id)
        : { inbound: [], outbound: [] },
    [data, selected],
  );
  const neighborhood = useMemo(
    () =>
      data && selected ? projectMapNeighborhood(data, selected.id, 8) : null,
    [data, selected],
  );
  const facetCounts = useMemo(
    () => (data ? projectMapFacetCounts(data.entities) : null),
    [data],
  );
  const localHits = useMemo(() => {
    if (!data) return [];
    const entities =
      facet === "all"
        ? data.entities
        : data.entities.filter((entity) => entity.kind === facet);
    return localProjectMapHits(entities, query, 80);
  }, [data, facet, query]);
  const semanticActive =
    submittedQuery !== null && submittedQuery === query.trim();
  const visibleHits = semanticActive ? remoteHits : localHits;
  const hitGroups = useMemo(
    () => groupProjectMapHits(visibleHits),
    [visibleHits],
  );

  useEffect(() => {
    if (
      !scrollSelectionIntoTreeRef.current ||
      !open ||
      query.trim() ||
      facet !== "all" ||
      !selectedId
    ) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>("[data-project-map-tree-selected]")
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
      scrollSelectionIntoTreeRef.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [expandedIds, facet, open, query, selectedId]);

  if (!open) return null;

  return createPortal(
    <div
      className="project-map-backdrop fixed inset-0 z-[70] flex justify-end p-3"
      onMouseDown={closeMap}
    >
      <section
        ref={dialogRef}
        id="project-map-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-map-title"
        aria-busy={loading || refreshing}
        tabIndex={-1}
        className="project-map-surface flex h-full w-[min(1180px,calc(100vw-1.5rem))] min-w-0 flex-col overflow-hidden rounded-xl border focus:outline-none"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-white/[0.08] px-5 py-3.5">
          <span className="project-map-mark flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 text-accent">
            <MapIcon className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="project-map-title" className="text-base font-semibold text-fg">
              Project Map
            </h2>
            <p className="mt-0.5 truncate text-xs text-fg-dim">
              Find code, assets, and dependencies in {projectName(project)}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing || loading || querying}
            className="flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-xs font-medium text-fg-muted hover:border-ink-600 hover:bg-ink-800 hover:text-fg disabled:cursor-wait disabled:opacity-50"
          >
            <RefreshIcon className={refreshing ? "animate-spin" : undefined} />
            {refreshing ? "Rescanning…" : "Rescan"}
          </button>
          <button
            type="button"
            onClick={closeMap}
            aria-label="Close project map"
            className="icon-button rounded-lg text-fg-dim hover:text-fg"
          >
            <CloseIcon />
          </button>
        </header>

        {loading && !data ? (
          <LoadingState />
        ) : error && !data ? (
          <ErrorState
            error={error}
            refreshing={refreshing}
            onRetry={() => void refresh()}
          />
        ) : !data ? (
          <EmptyState onBuild={() => void refresh()} refreshing={refreshing} />
        ) : (
          <>
            <MapStatus data={data} />
            {error && (
              <div
                role="alert"
                className="mx-4 mt-3 flex items-start justify-between gap-3 rounded-lg border border-danger/25 bg-danger/[0.06] px-3 py-2 text-xs text-fg-muted"
              >
                <span className="selectable min-w-0 break-words">{error}</span>
                <button
                  type="button"
                  onClick={() => setError(null)}
                  className="shrink-0 text-fg-dim hover:text-fg"
                >
                  Dismiss
                </button>
              </div>
            )}
            <div className="project-map-layout min-h-0 flex-1">
              <EntityBrowser
                data={data}
                facet={facet}
                facetCounts={facetCounts!}
                query={query}
                mapBusy={loading || refreshing}
                querying={querying}
                queryError={queryError}
                semanticActive={semanticActive}
                hits={visibleHits}
                groups={hitGroups}
                selectedId={selectedId}
                expandedIds={expandedIds}
                searchRef={searchRef}
                ask={{
                  question,
                  asking,
                  answer,
                  error: askError,
                  onQuestion: setQuestion,
                  onAsk: (explicit) => void onAsk(explicit),
                  onDismiss: () => {
                    setAnswer(null);
                    setAskError(null);
                  },
                }}
                onQuery={changeQuery}
                onSearch={(value) => void searchMap(value)}
                onFacet={selectFacet}
                onShowFacet={showFacet}
                onSelect={(id) => navigateTo(id)}
                onToggle={(id) =>
                  setExpandedIds((current) => {
                    const next = new Set(current);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
              />
              <EntityInspector
                data={data}
                entity={selected}
                neighborhood={neighborhood}
                inbound={connections.inbound}
                outbound={connections.outbound}
                canGoBack={navigation.index > 0}
                revealError={revealError}
                headingRef={inspectorHeadingRef}
                onBack={navigateBack}
                onSelect={(id) => navigateTo(id, true)}
                onReveal={(entity) => void reveal(entity)}
              />
            </div>
          </>
        )}
      </section>
    </div>,
    document.body,
  );
}

function MapStatus({ data }: { data: ProjectMapData }) {
  const { manifest } = data;
  const partial =
    !manifest.coverage.complete ||
    manifest.coverage.truncated ||
    manifest.coverage.errors.length > 0;
  const warning = manifest.dirty.value || partial;
  const label = manifest.dirty.value
    ? "Rescan recommended"
    : partial
      ? "Partial map"
      : "Up to date";
  const detail = `${manifest.coverage.scanned.toLocaleString()} files · scanned ${relativeTime(manifest.generatedAt)}`;

  if (!warning) {
    return (
      <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.07] bg-ink-850 px-5 py-2 text-[11px] text-fg-dim">
        <span className="h-1.5 w-1.5 rounded-full bg-success" />
        <span className="font-medium text-fg-muted">{label}</span>
        <span aria-hidden>·</span>
        <span>{detail}</span>
      </div>
    );
  }

  return (
    <details className="group shrink-0 border-b border-warning/20 bg-warning/[0.05] px-5 py-2 text-[11px]">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-warning marker:hidden">
        <span className="h-1.5 w-1.5 rounded-full bg-warning" />
        <span className="font-medium">{label}</span>
        <span aria-hidden>·</span>
        <span className="text-fg-dim">{detail}</span>
        <ChevronIcon className="ml-auto h-3.5 w-3.5 transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-2 grid gap-2 pb-1 text-fg-muted sm:grid-cols-2">
        {manifest.dirty.value && (
          <div className="rounded-lg border border-warning/15 bg-white px-3 py-2">
            <div className="font-medium text-fg">Project changed after this scan</div>
            <ul className="mt-1 space-y-1 text-fg-dim">
              {manifest.dirty.reasons.slice(-5).map((reason, index) => (
                <li key={`${reason.at}:${index}`}>{humanize(reason.change)}</li>
              ))}
            </ul>
          </div>
        )}
        {partial && (
          <div className="rounded-lg border border-warning/15 bg-white px-3 py-2">
            <div className="font-medium text-fg">
              {manifest.coverage.errors.length > 0
                ? `${manifest.coverage.errors.length} ${manifest.coverage.errors.length === 1 ? "file was" : "files were"} not indexed`
                : "The scan did not cover every file"}
            </div>
            <ul className="mt-1 space-y-1 text-fg-dim">
              {manifest.coverage.errors.slice(0, 5).map((item) => (
                <li key={item.path} className="selectable break-words">
                  {item.path}: {item.message}
                </li>
              ))}
              {manifest.coverage.truncated && (
                <li>Scan limit of {manifest.coverage.cap.toLocaleString()} files reached.</li>
              )}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}

/** Ask the agent about the project and jump to what it cites. Answer-only:
 *  the run has no write tools, so this can never change the project. */
function AskBox({
  ask,
  data,
  onSelect,
}: {
  ask: AskState;
  data: ProjectMapData;
  onSelect: (id: string) => void;
}) {
  const cited = (ask.answer?.entityIds ?? [])
    .map((id) => data.entities.find((entity) => entity.id === id))
    .filter((entity): entity is KnowledgeEntity => Boolean(entity));
  const idle = !ask.asking && !ask.answer && !ask.error;

  return (
    <div className="mb-3">
      <label htmlFor="project-map-ask" className="sr-only">
        Ask a question about this project
      </label>
      <div className="flex gap-2">
        <input
          id="project-map-ask"
          type="text"
          value={ask.question}
          disabled={ask.asking}
          onChange={(event) => ask.onQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            ask.onAsk();
          }}
          placeholder="Ask about this project…"
          className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-white px-3 py-2.5 text-xs text-fg outline-none placeholder:text-fg-dim focus:border-accent/40 disabled:opacity-60"
        />
        <button
          type="button"
          onClick={() => ask.onAsk()}
          disabled={!ask.question.trim() || ask.asking}
          className="shrink-0 rounded-lg bg-accent px-3 text-xs font-medium text-white disabled:opacity-40"
        >
          {ask.asking ? "Asking…" : "Ask"}
        </button>
      </div>

      {idle && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {ASK_EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => ask.onAsk(example)}
              className="rounded-full border border-ink-700 px-2 py-0.5 text-[10px] text-fg-dim hover:border-ink-600 hover:text-fg-muted"
            >
              {example}
            </button>
          ))}
          <span className="text-[10px] text-fg-dim">
            Answers only — never changes your project.
          </span>
        </div>
      )}

      {ask.asking && (
        <p className="mt-2 text-[11px] text-fg-dim" role="status">
          Reading the project map…
        </p>
      )}

      {ask.error && (
        <p
          role="alert"
          className="selectable mt-2 rounded-lg border border-danger/30 bg-danger/5 px-2.5 py-2 text-[11px] leading-relaxed text-danger"
        >
          {ask.error}
        </p>
      )}

      {ask.answer && (
        <div className="mt-2 rounded-lg border border-ink-700 bg-white p-3">
          <p className="selectable text-xs leading-relaxed text-fg">
            {ask.answer.answer || "No answer came back."}
          </p>
          {cited.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {cited.map((entity) => (
                <button
                  key={entity.id}
                  type="button"
                  onClick={() => onSelect(entity.id)}
                  title={entity.path ?? entity.name}
                  className="max-w-full truncate rounded-full border border-accent/40 px-2 py-0.5 text-[10px] font-medium text-accent hover:border-accent"
                >
                  {entity.name}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={ask.onDismiss}
            className="mt-2.5 text-[10px] text-fg-dim hover:text-fg-muted"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

function EntityBrowser({
  data,
  facet,
  facetCounts,
  query,
  mapBusy,
  querying,
  queryError,
  semanticActive,
  hits,
  groups,
  selectedId,
  expandedIds,
  searchRef,
  ask,
  onQuery,
  onSearch,
  onFacet,
  onShowFacet,
  onSelect,
  onToggle,
}: {
  data: ProjectMapData;
  facet: ProjectMapFacet;
  facetCounts: Record<ProjectMapFacet, number>;
  query: string;
  mapBusy: boolean;
  querying: boolean;
  queryError: string | null;
  semanticActive: boolean;
  hits: ProjectMapSearchHit[];
  groups: ReturnType<typeof groupProjectMapHits>;
  selectedId: string | null;
  expandedIds: Set<string>;
  searchRef: RefObject<HTMLInputElement>;
  ask: AskState;
  onQuery: (query: string) => void;
  onSearch: (query?: string) => void;
  onFacet: (facet: ProjectMapFacet) => void;
  onShowFacet: (facet: ProjectMapFacet) => void;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const browsingStructure = !query.trim() && facet === "all";
  const totalForFacet = facetCounts[facet];
  const resultCopy = queryError
    ? "Search unavailable"
    : browsingStructure
    ? `${totalForFacet.toLocaleString()} indexed items · ${data.relations.length.toLocaleString()} relationships`
    : querying
      ? "Searching the project map…"
      : semanticActive
        ? `${hits.length}${hits.length === 50 ? "+" : ""} project-wide ranked ${hits.length === 1 ? "result" : "results"}`
        : query.trim()
          ? `${hits.length} quick ${hits.length === 1 ? "match" : "matches"} · Enter searches dependencies too`
          : hits.length < totalForFacet
            ? `Showing ${hits.length} of ${totalForFacet.toLocaleString()}`
            : `${totalForFacet.toLocaleString()} ${totalForFacet === 1 ? "item" : "items"}`;

  return (
    <aside
      className="project-map-browser flex min-h-0 flex-col border-r border-white/[0.07]"
      aria-labelledby="project-map-browse-title"
    >
      <div className="shrink-0 border-b border-white/[0.07] p-3">
        <h3 id="project-map-browse-title" className="sr-only">
          Browse project map
        </h3>
        <AskBox ask={ask} data={data} onSelect={onSelect} />
        <label htmlFor="project-map-search" className="sr-only">
          Find code, assets, or dependencies
        </label>
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-dim" />
            <input
              ref={searchRef}
              id="project-map-search"
              type="search"
              value={query}
              disabled={mapBusy}
              onChange={(event) => onQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                onSearch();
              }}
              placeholder="Name, path, or question…"
              className="w-full rounded-lg border border-ink-700 bg-white py-2.5 pl-9 pr-3 text-xs text-fg outline-none placeholder:text-fg-dim focus:border-accent/40"
            />
          </div>
          <button
            type="button"
            onClick={() => onSearch()}
            disabled={!query.trim() || querying || mapBusy}
            className="rounded-lg bg-accent px-3 text-xs font-medium text-white disabled:opacity-40"
          >
            {querying ? "Searching…" : "Search"}
          </button>
        </div>
        <div
          className="mt-3 grid grid-cols-4 gap-1.5"
          role="group"
          aria-label="Filter project map"
        >
          {FACETS.map((item) => {
            const active = facet === item.id;
            const count = facetCounts[item.id];
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={active}
                disabled={mapBusy || (count === 0 && !active)}
                onClick={() => onFacet(item.id)}
                className={`flex min-w-0 items-center justify-center gap-1 rounded-lg border px-1.5 py-1.5 text-[10px] font-medium disabled:opacity-35 ${
                  active
                    ? "border-accent bg-accent text-fg"
                    : "border-ink-700 bg-white text-fg-muted hover:border-ink-600 hover:bg-ink-800"
                }`}
              >
                {item.label}
                <span
                  className={`rounded px-1 text-[9px] tabular-nums ${
                    active ? "bg-white/60 text-fg" : "bg-ink-850 text-fg-dim"
                  }`}
                >
                  {count.toLocaleString()}
                </span>
              </button>
            );
          })}
        </div>
        {!query.trim() && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            <span className="py-1 text-[10px] font-medium uppercase tracking-[0.1em] text-fg-dim">
              Ask
            </span>
            {SEARCH_EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                disabled={mapBusy}
                onClick={() => onSearch(example)}
                className="rounded-md bg-ink-800 px-2 py-1 text-[10px] text-fg-muted hover:bg-accent hover:text-fg disabled:opacity-40"
              >
                {example}
              </button>
            ))}
          </div>
        )}
        <div
          role="status"
          aria-live="polite"
          className="mt-3 text-[10px] uppercase tracking-[0.08em] text-fg-dim"
        >
          {resultCopy}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
        {queryError ? (
          <div role="alert" className="rounded-lg border border-danger/20 bg-danger/5 p-3">
            <div className="text-xs font-medium text-danger">Search failed</div>
            <p className="selectable mt-1 break-words text-[11px] leading-relaxed text-fg-dim">
              {queryError}
            </p>
          </div>
        ) : browsingStructure ? (
          <StructureBrowse
            data={data}
            counts={facetCounts}
            selectedId={selectedId}
            expandedIds={expandedIds}
            onSelect={onSelect}
            onToggle={onToggle}
            onFacet={onShowFacet}
          />
        ) : querying ? (
          <div
            className="project-map-searching flex items-center gap-3 rounded-lg border p-3"
          >
            <span className="project-map-searching-spinner block h-4 w-4 shrink-0 animate-spin rounded-full border-2" />
            <div>
              <div className="text-xs font-medium text-fg">
                Searching relationships…
              </div>
              <p className="mt-0.5 text-[10px] leading-relaxed text-fg-dim">
                Ranking names, code details, and dependencies across the map.
              </p>
            </div>
          </div>
        ) : hits.length === 0 ? (
          <div className="p-6 text-center">
            <div className="text-xs font-medium text-fg">Nothing matched</div>
            <p className="mt-1 text-[11px] leading-relaxed text-fg-dim">
              {query.trim() && !semanticActive
                ? "Press Enter or Search to check names, code details, and dependencies."
                : "Try another phrase or choose a different category."}
            </p>
          </div>
        ) : semanticActive ? (
          <RankedResults
            hits={hits}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        ) : (
          <ResultGroups
            groups={groups}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        )}
      </div>
    </aside>
  );
}

function RankedResults({
  hits,
  selectedId,
  onSelect,
}: {
  hits: ProjectMapSearchHit[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section aria-labelledby="project-map-ranked-results">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <h4
          id="project-map-ranked-results"
          className="text-[10px] font-medium uppercase tracking-[0.1em] text-fg-dim"
        >
          Best matches
        </h4>
        <span className="text-[10px] tabular-nums text-fg-dim">
          Ranked
        </span>
      </div>
      <ol className="space-y-0.5">
        {hits.map(({ entity }, index) => (
          <li key={entity.id} className="flex items-center gap-1.5">
            <span className="w-5 shrink-0 text-right text-[10px] tabular-nums text-fg-dim">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <EntityRow
                entity={entity}
                selected={selectedId === entity.id}
                onSelect={() => onSelect(entity.id)}
              />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function StructureBrowse({
  data,
  counts,
  selectedId,
  expandedIds,
  onSelect,
  onToggle,
  onFacet,
}: {
  data: ProjectMapData;
  counts: Record<ProjectMapFacet, number>;
  selectedId: string | null;
  expandedIds: Set<string>;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onFacet: (facet: ProjectMapFacet) => void;
}) {
  const root =
    data.entities.find((entity) => entity.kind === "project") ??
    data.entities[0] ??
    null;
  const rootChildren = root ? projectMapChildren(data, root.id) : [];
  const modules = rootChildren.filter(
    (entity) => entity.kind === "module" && entity.scope !== "package",
  );

  return (
    <div>
      {root && (
        <div
          data-project-map-tree-selected={
            selectedId === root.id ? "true" : undefined
          }
        >
          <EntityRow
            entity={root}
            selected={selectedId === root.id}
            onSelect={() => onSelect(root.id)}
            prominent
          />
        </div>
      )}

      <SectionLabel className="mb-2 mt-4">Project folders</SectionLabel>
      {modules.length > 0 ? (
        <ul className="space-y-0.5">
          {modules.map((module) => (
            <TreeNode
              key={module.id}
              data={data}
              entity={module}
              selectedId={selectedId}
              expandedIds={expandedIds}
              ancestors={new Set()}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed border-ink-700 p-3 text-[11px] text-fg-dim">
          No indexed project folders.
        </p>
      )}

      <SectionLabel className="mb-2 mt-5">Browse by asset</SectionLabel>
      <div className="grid grid-cols-2 gap-2">
        {(
          [
            ["scene", "Scenes"],
            ["prefab", "Prefabs"],
            ["script", "Scripts"],
            ["package", "Packages"],
          ] as Array<[ProjectMapFacet, string]>
        ).map(([kind, label]) => (
          <button
            key={kind}
            type="button"
            onClick={() => onFacet(kind)}
            className="rounded-lg border border-ink-700 bg-white p-3 text-left hover:border-ink-600 hover:bg-ink-800"
          >
            <div className="text-base font-semibold tabular-nums text-fg">
              {counts[kind].toLocaleString()}
            </div>
            <div className="mt-0.5 text-[10px] uppercase tracking-[0.1em] text-fg-dim">
              {label}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function TreeNode({
  data,
  entity,
  selectedId,
  expandedIds,
  ancestors,
  onSelect,
  onToggle,
}: {
  data: ProjectMapData;
  entity: KnowledgeEntity;
  selectedId: string | null;
  expandedIds: Set<string>;
  ancestors: Set<string>;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  if (ancestors.has(entity.id)) return null;
  const children = projectMapChildren(data, entity.id).filter(
    (child) => child.scope !== "external",
  );
  const expanded = expandedIds.has(entity.id);
  const nextAncestors = new Set(ancestors).add(entity.id);
  return (
    <li>
      <div
        data-project-map-tree-selected={
          selectedId === entity.id ? "true" : undefined
        }
        className={`project-map-tree-row flex items-center rounded-lg ${
          selectedId === entity.id ? "bg-accent" : "hover:bg-ink-800"
        }`}
      >
        {children.length > 0 ? (
          <button
            type="button"
            onClick={() => onToggle(entity.id)}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${entity.name}`}
            aria-expanded={expanded}
            className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center text-fg-dim hover:text-fg"
          >
            <ChevronIcon
              className={`h-3.5 w-3.5 transition-transform ${
                expanded ? "" : "-rotate-90"
              }`}
            />
          </button>
        ) : (
          <span className="ml-1 h-7 w-7 shrink-0" />
        )}
        <button
          type="button"
          aria-current={selectedId === entity.id ? "true" : undefined}
          onClick={() => onSelect(entity.id)}
          className="flex min-w-0 flex-1 items-center gap-2 py-2 pr-2 text-left"
        >
          <KindGlyph kind={entity.kind} />
          <span className="min-w-0 flex-1 truncate text-xs text-fg">
            {entity.name}
          </span>
          {children.length > 0 && (
            <span className="text-[9px] tabular-nums text-fg-dim">
              {children.length}
            </span>
          )}
        </button>
      </div>
      {expanded && children.length > 0 && (
        <ul className="ml-[18px] border-l border-ink-700 pl-2">
          {children.map((child) => (
            <TreeNode
              key={child.id}
              data={data}
              entity={child}
              selectedId={selectedId}
              expandedIds={expandedIds}
              ancestors={nextAncestors}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function ResultGroups({
  groups,
  selectedId,
  onSelect,
}: {
  groups: ReturnType<typeof groupProjectMapHits>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <section key={group.kind} aria-labelledby={`map-results-${group.kind}`}>
          <div className="mb-1.5 flex items-center justify-between px-1">
            <h4
              id={`map-results-${group.kind}`}
              className="text-[10px] font-medium uppercase tracking-[0.1em] text-fg-dim"
            >
              {pluralKind(group.kind)}
            </h4>
            <span className="text-[10px] tabular-nums text-fg-dim">
              {group.hits.length}
            </span>
          </div>
          <ul className="space-y-0.5">
            {group.hits.map(({ entity }) => (
              <li key={entity.id}>
                <EntityRow
                  entity={entity}
                  selected={selectedId === entity.id}
                  onSelect={() => onSelect(entity.id)}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function EntityRow({
  entity,
  selected,
  onSelect,
  prominent = false,
}: {
  entity: KnowledgeEntity;
  selected: boolean;
  onSelect: () => void;
  prominent?: boolean;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={`project-map-entity-row w-full rounded-lg border px-3 py-2.5 text-left ${
        selected
          ? "border-accent bg-accent"
          : prominent
            ? "border-ink-700 bg-white hover:border-ink-600"
            : "border-transparent hover:border-ink-700 hover:bg-ink-800"
      }`}
    >
      <div className="flex items-start gap-2.5">
        <KindGlyph kind={entity.kind} large={prominent} />
        <div className="min-w-0 flex-1">
          <div className={`${prominent ? "text-sm" : "text-xs"} truncate font-medium text-fg`}>
            {entity.name}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-fg-dim">
            <span className="shrink-0 uppercase tracking-[0.08em]">
              {formatKnowledgeKind(entity.kind)}
            </span>
            {entity.path && entity.path !== "." && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{entity.path}</span>
              </>
            )}
          </div>
        </div>
      </div>
    </button>
  );
}

function EntityInspector({
  data,
  entity,
  neighborhood,
  inbound,
  outbound,
  canGoBack,
  revealError,
  headingRef,
  onBack,
  onSelect,
  onReveal,
}: {
  data: ProjectMapData;
  entity: KnowledgeEntity | null;
  neighborhood: ProjectMapNeighborhood | null;
  inbound: ProjectMapConnection[];
  outbound: ProjectMapConnection[];
  canGoBack: boolean;
  revealError: string | null;
  headingRef: RefObject<HTMLHeadingElement>;
  onBack: () => void;
  onSelect: (id: string) => void;
  onReveal: (entity: KnowledgeEntity) => void;
}) {
  const relationshipDetailsRef = useRef<HTMLDetailsElement>(null);

  if (!entity) {
    return (
      <section className="flex min-h-0 items-center justify-center p-8 text-center text-xs text-fg-dim">
        Choose something from the project to inspect it.
      </section>
    );
  }

  const breadcrumbs = projectMapBreadcrumbs(data, entity.id);
  const revealable = Boolean(entity.path && entity.scope !== "external");

  return (
    <section
      className="project-map-inspector min-h-0 overflow-y-auto"
      aria-labelledby="project-map-selection-title"
    >
      <div className="sticky top-0 z-10 border-b border-ink-700 bg-white px-5 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            disabled={!canGoBack}
            className="rounded-md border border-ink-700 px-2 py-1 text-[10px] font-medium text-fg-muted hover:border-ink-600 hover:text-fg disabled:opacity-35"
          >
            ← Back
          </button>
          <nav aria-label="Selected item path" className="min-w-0 flex-1 overflow-hidden">
            <ol className="flex min-w-0 items-center gap-1 overflow-hidden text-[10px] text-fg-dim">
              {breadcrumbs.map((item, index) => (
                <li key={item.id} className="flex min-w-0 items-center gap-1">
                  {index > 0 && <span aria-hidden>›</span>}
                  <button
                    type="button"
                    onClick={() => onSelect(item.id)}
                    aria-current={item.id === entity.id ? "page" : undefined}
                    className={`truncate rounded px-1 py-0.5 hover:bg-ink-800 hover:text-fg ${
                      item.id === entity.id ? "font-medium text-fg" : ""
                    }`}
                  >
                    {item.name}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        </div>
      </div>

      <div className="px-6 py-5">
        <div className="flex items-start gap-3">
          <KindGlyph kind={entity.kind} large />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3
                ref={headingRef}
                id="project-map-selection-title"
                tabIndex={-1}
                className="project-map-inspector-heading selectable min-w-0 break-words rounded-sm text-xl font-semibold text-fg"
              >
                {entity.name}
              </h3>
              <span className="rounded-md bg-ink-800 px-2 py-1 text-[9px] font-medium uppercase tracking-[0.1em] text-fg-dim">
                {formatKnowledgeKind(entity.kind)}
              </span>
              {entity.scope !== "project" &&
                !(entity.kind === "package" && entity.scope === "package") && (
                  <span className="rounded-md border border-ink-700 px-2 py-1 text-[9px] uppercase tracking-[0.1em] text-fg-dim">
                    {scopeLabel(entity.scope)}
                  </span>
                )}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-fg-muted">
              {entityDescription(entity)}
            </p>
          </div>
          {revealable && (
            <button
              type="button"
              onClick={() => onReveal(entity)}
              className="shrink-0 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-[11px] font-medium text-fg-muted hover:border-ink-600 hover:bg-ink-800 hover:text-fg"
            >
              Reveal in folder
            </button>
          )}
        </div>

        {entity.path && entity.path !== "." && (
          <div className="selectable mt-4 break-all rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 font-mono text-[10px] leading-relaxed text-fg-dim">
            {entity.path}
          </div>
        )}
        {revealError && (
          <p role="alert" className="selectable mt-2 break-words text-xs text-danger">
            Couldn&apos;t reveal this item: {revealError}
          </p>
        )}

        {neighborhood && (
          <FocusNeighborhood
            entity={entity}
            neighborhood={neighborhood}
            onSelect={onSelect}
            onShowAll={() => {
              const details = relationshipDetailsRef.current;
              if (!details) return;
              details.open = true;
              details.scrollIntoView({ block: "start" });
              requestAnimationFrame(() =>
                details.querySelector<HTMLElement>("summary")?.focus(),
              );
            }}
          />
        )}
        <RelationshipPanel
          detailsRef={relationshipDetailsRef}
          entity={entity}
          inbound={inbound}
          outbound={outbound}
          onSelect={onSelect}
        />
        <EntityDetails entity={entity} />
      </div>
    </section>
  );
}

const NEIGHBORHOOD_ARMS: Array<{
  id: ProjectMapNeighborhoodArmId;
  label: string;
  direction: "inbound" | "outbound";
}> = [
  { id: "north", label: "Lives in", direction: "inbound" },
  { id: "west", label: "Depends on this", direction: "inbound" },
  { id: "east", label: "This depends on", direction: "outbound" },
  { id: "south", label: "Contains", direction: "outbound" },
];

function FocusNeighborhood({
  entity,
  neighborhood,
  onSelect,
  onShowAll,
}: {
  entity: KnowledgeEntity;
  neighborhood: ProjectMapNeighborhood;
  onSelect: (id: string) => void;
  onShowAll: () => void;
}) {
  return (
    <section
      className="project-map-neighborhood mt-6"
      aria-labelledby="project-map-neighborhood-title"
    >
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <SectionHeading id="project-map-neighborhood-title">
            How it connects
          </SectionHeading>
          <p className="mt-1 text-[10px] leading-relaxed text-fg-dim">
            Select a nearby item to follow its path.
          </p>
        </div>
        <div
          className="project-map-neighborhood-legend flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-fg-dim"
          aria-label="Map direction legend"
        >
          <span>
            <i aria-hidden className="project-map-legend-line project-map-legend-line--vertical" />
            Structure and declarations
          </span>
          <span>
            <i aria-hidden className="project-map-legend-line" />
            Code dependencies
          </span>
        </div>
      </div>

      <div className="project-map-neighborhood-grid mt-3">
        {NEIGHBORHOOD_ARMS.map(({ id, label, direction }) => (
          <NeighborhoodArm
            key={`${entity.id}:${id}`}
            id={id}
            label={label}
            direction={direction}
            arm={neighborhood[id]}
            onSelect={onSelect}
            onShowAll={onShowAll}
          />
        ))}
        {neighborhood.north.nodes.length > 0 && (
          <span
            aria-hidden
            className="project-map-neighborhood-connector project-map-neighborhood-connector--north"
          />
        )}
        {neighborhood.west.nodes.length > 0 && (
          <span
            aria-hidden
            className="project-map-neighborhood-connector project-map-neighborhood-connector--west"
          />
        )}
        <div className="project-map-neighborhood-focus" aria-current="true">
          <KindGlyph kind={entity.kind} />
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold text-fg">
              {entity.name}
            </div>
            <div className="mt-0.5 truncate text-[10px] uppercase tracking-[0.08em] text-fg-dim">
              Selected {formatKnowledgeKind(entity.kind)}
            </div>
          </div>
        </div>
        {neighborhood.east.nodes.length > 0 && (
          <span
            aria-hidden
            className="project-map-neighborhood-connector project-map-neighborhood-connector--east"
          />
        )}
        {neighborhood.south.nodes.length > 0 && (
          <span
            aria-hidden
            className="project-map-neighborhood-connector project-map-neighborhood-connector--south"
          />
        )}
      </div>
    </section>
  );
}

function NeighborhoodArm({
  id,
  label,
  direction,
  arm,
  onSelect,
  onShowAll,
}: {
  id: ProjectMapNeighborhoodArmId;
  label: string;
  direction: "inbound" | "outbound";
  arm: ProjectMapNeighborhoodArm;
  onSelect: (id: string) => void;
  onShowAll: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? arm.nodes : arm.nodes.slice(0, 3);
  const total = arm.nodes.length + arm.omittedCount;
  const hiddenCount = Math.max(0, total - visible.length);

  return (
    <div className={`project-map-neighborhood-arm project-map-neighborhood-arm--${id}`}>
      <div className="project-map-neighborhood-arm-label text-[10px] font-medium uppercase tracking-[0.08em] text-fg-dim">
        {label}
      </div>
      {arm.nodes.length === 0 ? (
        <div className="project-map-neighborhood-empty text-[10px] text-fg-dim">
          None
        </div>
      ) : (
        <ul className="project-map-neighborhood-nodes">
          {visible.map((node) => {
            const relationLabel = formatProjectMapRelation(
              node.primaryRelationKind,
              direction,
            );
            return (
              <li key={node.neighbor.id}>
                <button
                  type="button"
                  onClick={() => onSelect(node.neighbor.id)}
                  aria-label={`${label}: ${node.neighbor.name}, ${relationLabel}`}
                  className="project-map-neighborhood-node"
                >
                  <KindGlyph kind={node.neighbor.kind} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] font-medium text-fg">
                      {node.neighbor.name}
                    </span>
                    <span className="project-map-neighborhood-relation mt-0.5 block truncate text-[10px]">
                      {relationLabel}
                      {node.relations.length > 1
                        ? ` +${node.relations.length - 1}`
                        : ""}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => (expanded ? onShowAll() : setExpanded(true))}
          className="project-map-neighborhood-more mt-1 w-full rounded-md py-1 text-[10px] font-medium"
        >
          {expanded ? `View all ${total}` : `+${hiddenCount} more`}
        </button>
      )}
      {expanded && hiddenCount === 0 && arm.nodes.length > 3 && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="project-map-neighborhood-more mt-1 w-full rounded-md py-1 text-[10px] font-medium"
        >
          Show fewer
        </button>
      )}
    </div>
  );
}

function RelationshipPanel({
  detailsRef,
  entity,
  inbound,
  outbound,
  onSelect,
}: {
  detailsRef: RefObject<HTMLDetailsElement>;
  entity: KnowledgeEntity;
  inbound: ProjectMapConnection[];
  outbound: ProjectMapConnection[];
  onSelect: (id: string) => void;
}) {
  const groups = relationshipGroups(inbound, outbound);
  return (
    <details
      ref={detailsRef}
      className="group mt-5 scroll-mt-14 overflow-hidden rounded-xl border border-ink-700 bg-white"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-xs font-medium text-fg marker:hidden hover:bg-ink-800">
        All relationships
        <span className="rounded bg-ink-850 px-1.5 py-0.5 text-[10px] tabular-nums text-fg-dim">
          {inbound.length + outbound.length}
        </span>
        <span className="ml-1 min-w-0 flex-1 truncate text-[10px] font-normal text-fg-dim">
          Complete connection list
        </span>
        <ChevronIcon className="h-3.5 w-3.5 shrink-0 text-fg-dim transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-ink-700 bg-ink-850/50 p-3">
        {groups.length === 0 ? (
          <p className="rounded-lg border border-dashed border-ink-700 p-4 text-xs leading-relaxed text-fg-dim">
            No relationships were recorded for {entity.name}.
          </p>
        ) : (
          <div
            className={`grid items-start gap-3 ${
              groups.length > 1 ? "lg:grid-cols-2" : ""
            }`}
          >
            {groups.map((group) => (
              <RelationGroup
                key={`${entity.id}:${group.direction}:${group.kind}`}
                label={group.label}
                connections={group.connections}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

interface RelationshipGroup {
  kind: KnowledgeRelationKind;
  direction: "inbound" | "outbound";
  label: string;
  connections: ProjectMapConnection[];
}

function relationshipGroups(
  inbound: ProjectMapConnection[],
  outbound: ProjectMapConnection[],
): RelationshipGroup[] {
  const order: Array<["inbound" | "outbound", KnowledgeRelationKind]> = [
    ["inbound", "contains"],
    ["inbound", "declares"],
    ["outbound", "contains"],
    ["outbound", "declares"],
    ["outbound", "derives"],
    ["inbound", "derives"],
    ["outbound", "references"],
    ["inbound", "references"],
  ];
  return order.flatMap(([direction, kind]) => {
    const source = direction === "inbound" ? inbound : outbound;
    const connections = source.filter((item) => item.relation.kind === kind);
    return connections.length > 0
      ? [
          {
            kind,
            direction,
            label: formatProjectMapRelation(kind, direction),
            connections,
          },
        ]
      : [];
  });
}

function RelationGroup({
  label,
  connections,
  onSelect,
}: {
  label: string;
  connections: ProjectMapConnection[];
  onSelect: (id: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? connections : connections.slice(0, 8);
  return (
    <div className="overflow-hidden rounded-xl border border-ink-700 bg-white">
      <div className="flex items-center justify-between border-b border-ink-700 bg-ink-850 px-3 py-2">
        <div className="text-[10px] font-medium uppercase tracking-[0.1em] text-fg-dim">
          {label}
        </div>
        <span className="rounded bg-white px-1.5 py-0.5 text-[9px] tabular-nums text-fg-dim">
          {connections.length}
        </span>
      </div>
      <ul className="divide-y divide-ink-700">
        {visible.map(({ relation, neighbor }) => {
          const source = `${relation.provenance.path}${
            relation.provenance.line ? `:${relation.provenance.line}` : ""
          }`;
          return (
            <li key={relation.id}>
              <button
                type="button"
                disabled={!neighbor}
                onClick={() => neighbor && onSelect(neighbor.id)}
                aria-label={`${label}: ${neighbor?.name ?? "unknown item"}`}
                className="w-full px-3 py-2.5 text-left hover:bg-ink-800 disabled:cursor-default"
              >
                <div className="flex items-center gap-2">
                  {neighbor && <KindGlyph kind={neighbor.kind} />}
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">
                    {neighbor?.name ?? relation.id}
                  </span>
                  <ChevronIcon
                    aria-hidden
                    className="h-3.5 w-3.5 -rotate-90 text-fg-dim"
                  />
                </div>
                <div className="mt-1 truncate pl-7 text-[9px] text-fg-dim">
                  {neighbor ? formatKnowledgeKind(neighbor.kind) : "Unknown"}
                  {source ? ` · ${source}` : ""}
                  {relation.confidence !== undefined
                    ? ` · ${Math.round(relation.confidence * 100)}% confidence`
                    : ""}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
      {connections.length > 8 && (
        <button
          type="button"
          onClick={() => setShowAll((current) => !current)}
          className="w-full border-t border-ink-700 px-3 py-2 text-[10px] font-medium text-fg-muted hover:bg-ink-800 hover:text-fg"
        >
          {showAll ? "Show fewer" : `Show all ${connections.length}`}
        </button>
      )}
    </div>
  );
}

function EntityDetails({ entity }: { entity: KnowledgeEntity }) {
  const groups = groupProjectMapFacts(entity.facts);
  const members = groups.find((group) => group.key === "memberSignature");
  const details = groups.filter(
    (group) =>
      !["memberSignature", "path", "directory"].includes(group.key) &&
      !(group.key === "memberSignatureCount" && members),
  );
  const sources = factSources(entity.facts);

  return (
    <section className="mt-7" aria-labelledby="project-details-title">
      <SectionHeading id="project-details-title">Details</SectionHeading>
      {details.length === 0 && !members ? (
        <p className="mt-3 rounded-lg border border-dashed border-ink-700 p-4 text-xs leading-relaxed text-fg-dim">
          No structured details were recorded for this item.
        </p>
      ) : (
        <div className="mt-3 overflow-hidden rounded-xl border border-ink-700 bg-white">
          {details.map((group) => {
            const values = [
              ...new Set(
                group.facts.map((fact) => formatKnowledgeFactValue(fact.value)),
              ),
            ];
            return (
              <div
                key={group.key}
                className="grid gap-1 border-b border-ink-700 px-4 py-3 last:border-b-0 sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-4"
              >
                <div className="text-[10px] font-medium uppercase tracking-[0.09em] text-fg-dim">
                  {factLabel(group.key)}
                </div>
                {values.length === 1 ? (
                  <div className="selectable break-words text-xs leading-relaxed text-fg">
                    {values[0]}
                  </div>
                ) : (
                  <ul className="selectable space-y-1 text-xs leading-relaxed text-fg">
                    {values.map((value) => (
                      <li key={value}>{value}</li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}

      {members && (
        <details className="group mt-3 overflow-hidden rounded-xl border border-ink-700 bg-white">
          <summary className="flex cursor-pointer list-none items-center gap-2 bg-ink-850 px-4 py-3 text-xs font-medium text-fg marker:hidden">
            Members
            <span className="rounded bg-white px-1.5 py-0.5 text-[9px] tabular-nums text-fg-dim">
              {members.facts.length}
            </span>
            <ChevronIcon className="ml-auto h-3.5 w-3.5 text-fg-dim transition-transform group-open:rotate-180" />
          </summary>
          <ul className="selectable max-h-80 divide-y divide-ink-700 overflow-y-auto font-mono text-[10px] leading-relaxed text-fg-muted">
            {members.facts.map((fact, index) => (
              <li key={`${fact.provenance.line ?? index}:${index}`} className="px-4 py-2">
                {formatKnowledgeFactValue(fact.value)}
              </li>
            ))}
          </ul>
        </details>
      )}

      {sources.length > 0 && (
        <details className="group mt-3 rounded-xl border border-ink-700 bg-white">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-xs font-medium text-fg-muted marker:hidden hover:text-fg">
            How this was found
            <span className="text-[10px] font-normal text-fg-dim">
              {sources.length} {sources.length === 1 ? "source" : "sources"}
            </span>
            <ChevronIcon className="ml-auto h-3.5 w-3.5 text-fg-dim transition-transform group-open:rotate-180" />
          </summary>
          <ul className="border-t border-ink-700 px-4 py-3 text-[10px] text-fg-dim">
            {sources.map((source) => (
              <li key={source.path} className="selectable mb-2 last:mb-0">
                <div className="break-all font-mono text-fg-muted">{source.path}</div>
                <div className="mt-0.5">
                  {humanize(source.source)}
                  {source.heuristic ? " · inferred" : ""}
                  {source.confidence !== undefined
                    ? ` · ${Math.round(source.confidence * 100)}% confidence`
                    : ""}
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

interface FactSource {
  path: string;
  source: KnowledgeFact["provenance"]["source"];
  heuristic: boolean;
  confidence?: number;
}

function factSources(facts: KnowledgeFact[]): FactSource[] {
  const sources = new Map<string, FactSource>();
  for (const fact of facts) {
    const path = fact.provenance.path;
    const current = sources.get(path);
    const confidence = fact.confidence;
    if (!current) {
      sources.set(path, {
        path,
        source: fact.provenance.source,
        heuristic: Boolean(fact.provenance.heuristic),
        confidence,
      });
    } else {
      current.heuristic ||= Boolean(fact.provenance.heuristic);
      if (confidence !== undefined) {
        current.confidence = Math.max(current.confidence ?? 0, confidence);
      }
    }
  }
  return [...sources.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function KindGlyph({
  kind,
  large = false,
}: {
  kind: KnowledgeEntity["kind"];
  large?: boolean;
}) {
  const glyph: Record<KnowledgeEntity["kind"], string> = {
    project: "◆",
    package: "▣",
    scene: "◫",
    prefab: "◇",
    script: "⌘",
    type: "T",
    module: "▦",
  };
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-md border border-ink-700 bg-ink-850 font-mono text-accent ${
        large ? "h-9 w-9 text-xs" : "h-5 w-5 text-[9px]"
      }`}
    >
      {glyph[kind] ?? "·"}
    </span>
  );
}

function SectionLabel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`text-[10px] font-medium uppercase tracking-[0.12em] text-fg-dim ${className}`}
    >
      {children}
    </div>
  );
}

function SectionHeading({ children, id }: { children: ReactNode; id: string }) {
  return (
    <h4 id={id} className="text-sm font-semibold text-fg">
      {children}
    </h4>
  );
}

function LoadingState() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <div className="text-center" role="status">
        <span className="mx-auto block h-5 w-5 animate-spin rounded-full border-2 border-ink-700 border-t-fg-muted" />
        <p className="mt-3 text-xs text-fg-dim">Reading the project map…</p>
      </div>
    </div>
  );
}

function ErrorState({
  error,
  refreshing,
  onRetry,
}: {
  error: string;
  refreshing: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <div className="max-w-md text-center" role="alert">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg border border-danger/25 bg-danger/[0.07] text-danger">
          !
        </div>
        <h3 className="mt-4 text-sm font-medium text-fg">
          Couldn&apos;t read the project map
        </h3>
        <p className="selectable mt-2 break-words text-xs leading-relaxed text-fg-dim">
          {error}
        </p>
        <button
          type="button"
          onClick={onRetry}
          disabled={refreshing}
          className="mt-4 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-xs text-fg-muted hover:bg-ink-800 hover:text-fg"
        >
          {refreshing ? "Rebuilding…" : "Rebuild map"}
        </button>
      </div>
    </div>
  );
}

function EmptyState({
  onBuild,
  refreshing,
}: {
  onBuild: () => void;
  refreshing: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <span className="project-map-mark mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-white/10 text-accent">
          <MapIcon className="h-5 w-5" />
        </span>
        <h3 className="mt-4 text-sm font-medium text-fg">Build a project map</h3>
        <p className="mt-2 text-xs leading-relaxed text-fg-dim">
          Index the project&apos;s code, scenes, prefabs, packages, and dependencies.
        </p>
        <button
          type="button"
          onClick={onBuild}
          disabled={refreshing}
          className="mt-4 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
        >
          {refreshing ? "Building…" : "Build project map"}
        </button>
      </div>
    </div>
  );
}

function pluralKind(kind: KnowledgeEntityKind): string {
  const labels: Record<KnowledgeEntityKind, string> = {
    project: "Project",
    module: "Folders",
    scene: "Scenes",
    prefab: "Prefabs",
    script: "C# scripts",
    type: "Types",
    package: "Packages",
  };
  return labels[kind];
}

function factLabel(value: string): string {
  const labels: Record<string, string> = {
    assetType: "Asset type",
    baseTypes: "Inherits or implements",
    bundleIdentifier: "Bundle identifier",
    companyName: "Company",
    declarationKind: "Declaration",
    declaredTypeCount: "Declared types",
    inputSystem: "Input system",
    isUnityProject: "Unity project",
    language: "Language",
    memberSignatureCount: "Members",
    name: "Name",
    namespace: "Namespace",
    partial: "Partial declaration",
    productName: "Product",
    qualifiedName: "Qualified name",
    renderPipeline: "Render pipeline",
    scriptingBackend: "Scripting backend",
    source: "Source",
    symbol: "Assembly symbol",
    unityRevision: "Unity revision",
    unityVersion: "Unity version",
    version: "Version",
  };
  return labels[value] ?? humanize(value);
}

function humanize(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .trim();
  return words ? words[0].toUpperCase() + words.slice(1) : value;
}

function entityDescription(entity: KnowledgeEntity): string {
  const descriptions: Record<KnowledgeEntity["kind"], string> = {
    project: "Indexed overview of this Unity project.",
    module: "A project folder that groups related code.",
    scene: "A Unity scene asset.",
    prefab: "A reusable Unity prefab asset.",
    script: "A C# source file and the types it declares.",
    type: "A C# type with its members, inheritance, and dependencies.",
    package: "A package available to this Unity project.",
  };
  return descriptions[entity.kind];
}

function scopeLabel(scope: KnowledgeEntity["scope"]): string {
  const labels: Record<KnowledgeEntity["scope"], string> = {
    project: "Project",
    "first-party": "Project code",
    package: "Package",
    external: "External",
  };
  return labels[scope];
}

function projectName(project: string): string {
  return project.split(/[\\/]/).filter(Boolean).pop() ?? project;
}
