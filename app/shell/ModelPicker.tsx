"use client";

// The one control every surface that picks a model uses (docs/superpowers/specs/
// 2026-09-06-model-providers-design.md, "The model picker"). Value is the triple
// stored on a task/schedule/runbook row: `{agent, provider_id, model}`, each
// nullable meaning "inherit". Data comes from GET /api/models?agent=<env>
// through useModelTree, a module-scoped cache so the seven adopting surfaces
// share one fetch per environment instead of refetching on every open.

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { EnvMark, Icon, ProviderMark } from "@/app/icons";
import type { ModelsTree, ModelTreeFamily, ModelTreeSource, ModelTreeVersion } from "@/lib/providers/catalog";
import type { PresentedProvider } from "@/lib/providers/present";
import type { ProviderType } from "@/lib/providers/types";

import { Popover } from "./shared";
import type { AgentsResponseT } from "./types";
import { apiFetch } from "./api";

export interface ModelPickerValue {
  agent: string | null;
  provider_id: string | null;
  model: string | null;
}

export interface ModelPickerEnvOption {
  id: string;
  label: string;
}

export interface ModelPickerEnv {
  /** The environment whose tree is rendered right now. */
  current: string;
  /** Connected environments the footer/environment pane may switch between. */
  options: ModelPickerEnvOption[];
  /** Shown as "project default" in the environment pane. */
  projectDefault?: string | null;
}

export interface ModelPickerProps {
  value: ModelPickerValue;
  onChange: (value: ModelPickerValue) => void;
  /** Head-row text for the inherited value, e.g. {label:"Project default"}. Omit to hide the head row. */
  inherit?: { label: string; sub?: string };
  env: ModelPickerEnv;
  variant: "inline" | "popover" | "sheet";
  /** Hides the footer and the environment pane: Settings → Run defaults, one picker per fixed environment. */
  pinned?: boolean;
  /** popover/sheet: called after a selection, Esc, or a backdrop/outside dismissal. */
  onClose?: () => void;
  className?: string;
}

// ---------- shared caches ----------
// Every mounted picker (and any other surface asking for a label) shares one
// fetch per environment / one fetch for the provider list, so opening the
// picker on a second surface never refetches what the first already has.

interface TreeCacheEntry {
  data?: ModelsTree;
  loading: boolean;
}
const treeCache = new Map<string, TreeCacheEntry>();
const treeListeners = new Map<string, Set<() => void>>();
const treeEpochs = new Map<string, number>();

function fetchTree(agent: string): void {
  if (treeCache.has(agent)) return;
  const epoch = treeEpochs.get(agent) ?? 0;
  treeCache.set(agent, { loading: true });
  apiFetch(`/api/models?agent=${encodeURIComponent(agent)}`)
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
    .then((data: ModelsTree) => {
      if ((treeEpochs.get(agent) ?? 0) !== epoch) return;
      treeCache.set(agent, { data, loading: false });
      treeListeners.get(agent)?.forEach((cb) => cb());
    })
    .catch(() => {
      if ((treeEpochs.get(agent) ?? 0) !== epoch) return;
      treeCache.set(agent, { loading: false });
      treeListeners.get(agent)?.forEach((cb) => cb());
    });
}

/** Reads (and warms) the cache without subscribing to it: used for a
 *  cross-environment compatibility check that can't call a hook per option. */
export function peekModelTree(agent: string): ModelsTree | undefined {
  fetchTree(agent);
  return treeCache.get(agent)?.data;
}

export function useModelTree(agent: string | null | undefined): { tree: ModelsTree | undefined; loading: boolean } {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!agent) return;
    fetchTree(agent);
    const set = treeListeners.get(agent) ?? new Set<() => void>();
    treeListeners.set(agent, set);
    const cb = () => bump((n) => n + 1);
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }, [agent]);
  if (!agent) return { tree: undefined, loading: false };
  const entry = treeCache.get(agent);
  return { tree: entry?.data, loading: entry?.loading ?? true };
}

const providersCache: { data?: PresentedProvider[]; loading: boolean } = { loading: false };
const providersListeners = new Set<() => void>();
let providersEpoch = 0;

function fetchProviders(): void {
  if (providersCache.data || providersCache.loading) return;
  const epoch = providersEpoch;
  providersCache.loading = true;
  apiFetch("/api/providers")
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
    .then((body: { providers: PresentedProvider[] }) => {
      if (providersEpoch !== epoch) return;
      providersCache.data = body.providers;
      providersCache.loading = false;
      providersListeners.forEach((cb) => cb());
    })
    .catch(() => {
      if (providersEpoch !== epoch) return;
      providersCache.loading = false;
      providersListeners.forEach((cb) => cb());
    });
}

/** Drop picker data after a provider write and refresh every mounted consumer.
 * Epochs keep an older in-flight response from restoring the stale snapshot. */
export function invalidateModelPickerData(): void {
  const agents = new Set([...treeCache.keys(), ...treeListeners.keys()]);
  for (const agent of agents) treeEpochs.set(agent, (treeEpochs.get(agent) ?? 0) + 1);
  treeCache.clear();
  for (const agent of agents) {
    if (treeListeners.get(agent)?.size) fetchTree(agent);
    treeListeners.get(agent)?.forEach((cb) => cb());
  }

  providersEpoch += 1;
  providersCache.data = undefined;
  providersCache.loading = false;
  if (providersListeners.size) fetchProviders();
  providersListeners.forEach((cb) => cb());
}

function useProviders(): Map<string, PresentedProvider> {
  const [, bump] = useState(0);
  useEffect(() => {
    fetchProviders();
    const cb = () => bump((n) => n + 1);
    providersListeners.add(cb);
    return () => {
      providersListeners.delete(cb);
    };
  }, []);
  return useMemo(() => new Map((providersCache.data ?? []).map((p) => [p.id, p] as const)), [providersCache.data]);
}

/** Connected environments, in the shape the picker's `env.options` wants. */
export function connectedEnvOptions(bundle: AgentsResponseT): ModelPickerEnvOption[] {
  return bundle.agents.filter((a) => a.status === "connected").map((a) => ({ id: a.id, label: a.label }));
}

// ---------- pure helpers ----------

interface Located {
  family: ModelTreeFamily;
  version: ModelTreeVersion;
  source: ModelTreeSource;
}

function locate(tree: ModelsTree | undefined, providerId: string | null, model: string | null): Located | null {
  if (!tree || !providerId || !model) return null;
  for (const family of tree.families) {
    for (const version of family.versions) {
      const source = version.sources.find((s) => s.provider_id === providerId && s.model === model);
      if (source) return { family, version, source };
    }
  }
  return null;
}

/** True when there is nothing to choose between: one connected environment and
 *  every version has exactly one source, all from the same provider. */
function isFlatTree(tree: ModelsTree | undefined, singleEnvironment: boolean): boolean {
  if (!tree || !singleEnvironment) return false;
  const providerIds = new Set<string>();
  for (const family of tree.families) {
    for (const version of family.versions) {
      if (version.sources.length !== 1) return false;
      providerIds.add(version.sources[0].provider_id);
    }
  }
  return providerIds.size <= 1;
}

function versionUnavailable(version: ModelTreeVersion): boolean {
  return version.sources.length === 0 || version.sources.every((s) => s.unavailable);
}

function providerMarkFor(type?: ProviderType) {
  if (!type) return null;
  const mark = ProviderMark[type];
  return mark ? mark() : null;
}

function envMarkFor(id: string) {
  const mark = EnvMark[id];
  return mark ? mark() : null;
}

function priceLabel(price: ModelTreeSource["price"]): string {
  switch (price) {
    case "plan":
      return "Plan";
    case "metered":
      return "Metered";
    case "free":
      return "Free";
    default:
      return "";
  }
}

function formatCtx(n: number): string {
  if (!n) return "";
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}

export interface ResolvedModelLabel {
  name: string;
  sub: string;
  /** The provider label to show as "via X", or null when it would be redundant. */
  via: string | null;
  mark: React.ReactNode;
}

/** The label a chip/pill renders for a resolved value: "via Provider" only when
 *  the version has more than one source or the provider isn't the bundled one. */
export function resolveModelLabel(
  tree: ModelsTree | undefined,
  providers: Map<string, PresentedProvider>,
  value: Pick<ModelPickerValue, "provider_id" | "model">,
): ResolvedModelLabel | null {
  const loc = locate(tree, value.provider_id, value.model);
  if (!loc) return null;
  const provider = providers.get(loc.source.provider_id);
  const providerLabel = provider?.label ?? loc.source.provider_id;
  const multiSource = loc.version.sources.length > 1;
  return {
    name: loc.version.label,
    sub: loc.family.label,
    via: multiSource || !provider?.bundled ? providerLabel : null,
    mark: providerMarkFor(provider?.type),
  };
}

// ---------- recents (localStorage, shared across every surface) ----------

const RECENTS_KEY = "calandria.modelPicker.recents.v1";
const RECENTS_STORED = 6;
const RECENTS_SHOWN = 4;

function loadRecents(): ModelPickerValue[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENTS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.slice(0, RECENTS_STORED) : [];
  } catch {
    return [];
  }
}

function saveRecents(list: ModelPickerValue[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, RECENTS_STORED)));
  } catch {
    // Private-mode/quota storage failures leave recents empty; not worth surfacing.
  }
}

function pushRecent(list: ModelPickerValue[], entry: ModelPickerValue): ModelPickerValue[] {
  const deduped = list.filter((r) => !(r.agent === entry.agent && r.provider_id === entry.provider_id && r.model === entry.model));
  return [entry, ...deduped].slice(0, RECENTS_STORED);
}

// ---------- pane state ----------

type Pane = { kind: "root" } | { kind: "family"; familyId: string } | { kind: "source"; familyId: string; versionId: string } | { kind: "env" };

function backIcon() {
  return Icon.chevRight({ style: { transform: "rotate(180deg)" } });
}

export function ModelPicker({ value, onChange, inherit, env, variant, pinned, onClose, className }: ModelPickerProps) {
  const { tree } = useModelTree(env.current);
  const providers = useProviders();

  const [panes, setPanes] = useState<Pane[]>([{ kind: "root" }]);
  const [depth, setDepth] = useState(0);
  const [q, setQ] = useState("");
  const [note, setNote] = useState("");
  const [recents, setRecents] = useState<ModelPickerValue[]>(() => loadRecents());

  // Prefetch every connected environment's tree once, so a footer/environment-pane
  // switch (and its "does the same model exist there" check) never has to wait.
  useEffect(() => {
    for (const opt of env.options) fetchTree(opt.id);
  }, [env.options]);

  // A pinned picker's environment can change under it (Settings → Background
  // jobs re-points this picker at whichever agent utility jobs now run on), and
  // a family/version pane belongs to the tree it was opened from. Drop back to
  // the root so the panes always describe `env.current`. `note` survives: a
  // switchEnvironment() explanation is about exactly this transition.
  useEffect(() => {
    setPanes([{ kind: "root" }]);
    setDepth(0);
    setQ("");
  }, [env.current]);

  const singleEnvironment = env.options.length <= 1;
  const flat = isFlatTree(tree, singleEnvironment);

  function go(pane: Pane) {
    setPanes((prev) => [...prev.slice(0, depth + 1), pane]);
    setDepth((d) => d + 1);
  }
  function home() {
    setDepth(0);
  }
  function back() {
    setDepth((d) => Math.max(0, d - 1));
  }

  function select(agent: string, providerId: string, model: string) {
    const next: ModelPickerValue = { agent, provider_id: providerId, model };
    setRecents((prev) => {
      const updated = pushRecent(prev, next);
      saveRecents(updated);
      return updated;
    });
    setNote("");
    setQ("");
    onChange(next);
    home();
    onClose?.();
  }

  function selectInherit() {
    setNote("");
    setQ("");
    onChange({ agent: env.current, provider_id: null, model: null });
    home();
    onClose?.();
  }

  function switchEnvironment(nextEnv: string) {
    if (nextEnv === env.current) {
      home();
      return;
    }
    if (!value.provider_id || !value.model) {
      onChange({ agent: nextEnv, provider_id: null, model: null });
      setNote("");
      home();
      return;
    }
    const nextTree = peekModelTree(nextEnv);
    const keeps = !!locate(nextTree, value.provider_id, value.model);
    if (keeps) {
      onChange({ agent: nextEnv, provider_id: value.provider_id, model: value.model });
      setNote("");
    } else {
      const label = resolveModelLabel(tree, providers, value);
      const envLabel = env.options.find((o) => o.id === nextEnv)?.label ?? nextEnv;
      onChange({ agent: nextEnv, provider_id: null, model: null });
      setNote(
        label
          ? `${label.name}${label.via ? ` via ${label.via}` : ""} can't run in ${envLabel}, so it's back on ${inherit?.label ?? "the default"}.`
          : "",
      );
    }
    home();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      if (depth > 0) {
        e.preventDefault();
        back();
      }
      return;
    }
    const row = (e.target as HTMLElement).closest('[role="option"]') as HTMLElement | null;
    if (e.key === "Enter" || e.key === " ") {
      if (row && row.getAttribute("aria-disabled") !== "true") {
        e.preventDefault();
        row.click();
      }
      return;
    }
    if (e.key === "ArrowRight") {
      if (row && (row.dataset.act === "fam" || row.dataset.act === "ver")) {
        e.preventDefault();
        row.click();
      }
      return;
    }
    if (e.key === "ArrowLeft") {
      if (depth > 0) {
        e.preventDefault();
        back();
      }
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (!row) return;
    e.preventDefault();
    const sib = e.key === "ArrowDown" ? "nextElementSibling" : "previousElementSibling";
    let n = row[sib] as HTMLElement | null;
    while (n && (!n.matches('[role="option"]') || n.getAttribute("aria-disabled") === "true")) n = n[sib] as HTMLElement | null;
    n?.focus();
  }

  // ---------- rows ----------

  function renderHeadRow() {
    if (!inherit) return null;
    const on = !value.provider_id && !value.model;
    return (
      <div
        className={`mpick-row mpick-head${on ? " on" : ""}`}
        role="option"
        aria-selected={on}
        tabIndex={0}
        data-act="head"
        onClick={selectInherit}
      >
        <span className="mpick-lbl">
          <span className="mpick-nm">{inherit.label}</span>
          <span className="mpick-sub">{inherit.sub ?? "inherit"}</span>
        </span>
        {on && <span className="mpick-chk">{Icon.check()}</span>}
      </div>
    );
  }

  function StackedMarks({ providerIds }: { providerIds: string[] }) {
    if (providerIds.length === 0) return null;
    if (providerIds.length === 1) {
      return <span className="mpick-marks one">{providerMarkFor(providers.get(providerIds[0])?.type)}</span>;
    }
    const shown = providerIds.slice(0, 3);
    const extra = providerIds.length - shown.length;
    return (
      <span className="mpick-marks">
        {shown.map((id) => (
          <span key={id}>{providerMarkFor(providers.get(id)?.type)}</span>
        ))}
        {extra > 0 && <span className="mpick-more">+{extra}</span>}
      </span>
    );
  }

  function renderFamilyRow(family: ModelTreeFamily) {
    const activeVersion = family.versions.find((v) => v.sources.some((s) => s.provider_id === value.provider_id && s.model === value.model));
    const providerIds = Array.from(new Set(family.versions.flatMap((v) => v.sources.map((s) => s.provider_id))));
    return (
      <div
        key={family.id}
        className={`mpick-row mpick-fam${activeVersion ? " on" : ""}`}
        role="option"
        aria-selected={!!activeVersion}
        tabIndex={0}
        data-act="fam"
        onClick={() => go({ kind: "family", familyId: family.id })}
      >
        <span className="mpick-lbl">
          <span className="mpick-nm">{family.label}</span>
          <span className="mpick-sub">
            {family.versions.length} version{family.versions.length === 1 ? "" : "s"}
            {activeVersion ? ` · ${activeVersion.label}` : ""}
          </span>
        </span>
        <span className="mpick-trail">
          <StackedMarks providerIds={providerIds} />
          {Icon.chevRight()}
        </span>
      </div>
    );
  }

  function renderVersionRow(family: ModelTreeFamily, version: ModelTreeVersion) {
    const unavailable = versionUnavailable(version);
    const selected = !unavailable && version.sources.some((s) => s.provider_id === value.provider_id && s.model === value.model);
    const single = version.sources.length === 1;
    function activate() {
      if (unavailable) return;
      if (single) select(env.current, version.sources[0].provider_id, version.sources[0].model);
      else go({ kind: "source", familyId: family.id, versionId: version.id });
    }
    const providerIds = Array.from(new Set(version.sources.map((s) => s.provider_id)));
    return (
      <div
        key={version.id}
        className={`mpick-row${unavailable ? " off" : ""}${selected ? " on" : ""}`}
        role="option"
        aria-selected={selected}
        aria-disabled={unavailable || undefined}
        tabIndex={unavailable ? -1 : 0}
        data-act={unavailable ? undefined : "ver"}
        onClick={activate}
      >
        <span className="mpick-lbl">
          <span className="mpick-nm">{version.label}</span>
          <span className="mpick-sub">{version.sub}</span>
        </span>
        <span className="mpick-trail">
          {!unavailable && <StackedMarks providerIds={providerIds} />}
          {!unavailable && version.ctx > 0 && <span className="mpick-ctx">{formatCtx(version.ctx)}</span>}
          {!unavailable && !single && Icon.chevRight()}
          {selected && <span className="mpick-chk">{Icon.check()}</span>}
        </span>
      </div>
    );
  }

  function renderSourceRow(source: ModelTreeSource) {
    const provider = providers.get(source.provider_id);
    const selected = value.provider_id === source.provider_id && value.model === source.model;
    return (
      <div
        key={`${source.provider_id}:${source.model}`}
        className={`mpick-row mpick-src${source.unavailable ? " off" : ""}${selected ? " on" : ""}`}
        role="option"
        aria-selected={selected}
        aria-disabled={source.unavailable || undefined}
        tabIndex={source.unavailable ? -1 : 0}
        data-act={source.unavailable ? undefined : "src"}
        onClick={() => !source.unavailable && select(env.current, source.provider_id, source.model)}
      >
        <span className="mpick-pm">{providerMarkFor(provider?.type)}</span>
        <span className="mpick-lbl">
          <span className="mpick-nm">{provider?.label ?? source.provider_id}</span>
          <span className="mpick-sub">{provider?.config?.base_url ?? ""}</span>
        </span>
        <code className="mpick-mid">{source.model}</code>
        <span className="mpick-price">{priceLabel(source.price)}</span>
        {selected && <span className="mpick-chk">{Icon.check()}</span>}
      </div>
    );
  }

  function renderSearchRow(family: ModelTreeFamily, version: ModelTreeVersion, source: ModelTreeSource) {
    const provider = providers.get(source.provider_id);
    const selected = value.provider_id === source.provider_id && value.model === source.model;
    return (
      <div
        key={`${family.id}:${version.id}:${source.provider_id}:${source.model}`}
        className={`mpick-row mpick-src${source.unavailable ? " off" : ""}${selected ? " on" : ""}`}
        role="option"
        aria-selected={selected}
        aria-disabled={source.unavailable || undefined}
        tabIndex={source.unavailable ? -1 : 0}
        data-act={source.unavailable ? undefined : "src"}
        onClick={() => !source.unavailable && select(env.current, source.provider_id, source.model)}
      >
        <span className="mpick-pm">{providerMarkFor(provider?.type)}</span>
        <span className="mpick-lbl">
          <span className="mpick-nm">{version.label}</span>
          <span className="mpick-sub">
            {family.label} · {provider?.label ?? source.provider_id}
          </span>
        </span>
        <code className="mpick-mid">{source.model}</code>
        <span className="mpick-price">{priceLabel(source.price)}</span>
        {selected && <span className="mpick-chk">{Icon.check()}</span>}
      </div>
    );
  }

  // ---------- panes ----------

  function renderFilterField() {
    return (
      <div className="mpick-search">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter models"
          aria-label="Filter models"
        />
      </div>
    );
  }

  function renderSearch() {
    const query = q.trim().toLowerCase();
    const results: { family: ModelTreeFamily; version: ModelTreeVersion; source: ModelTreeSource }[] = [];
    for (const family of tree?.families ?? []) {
      for (const version of family.versions) {
        for (const source of version.sources) {
          const provider = providers.get(source.provider_id);
          const hay = [family.label, version.label, version.sub, provider?.label ?? "", source.model].join(" ").toLowerCase();
          if (hay.includes(query)) results.push({ family, version, source });
        }
      }
    }
    return (
      <>
        {renderFilterField()}
        <div className="mpick-scroll" role="listbox">
          {results.length === 0 ? (
            <div className="mpick-empty">
              No models match &ldquo;{q}&rdquo;.{" "}
              <button type="button" className="mpick-linklike" onClick={() => setQ("")}>
                Clear the filter
              </button>
            </div>
          ) : (
            results.map(({ family, version, source }) => renderSearchRow(family, version, source))
          )}
        </div>
      </>
    );
  }

  function renderRoot() {
    if (q.trim()) return renderSearch();
    const families = tree?.families ?? [];
    const visibleRecents = recents
      .filter((r) => r.agent === env.current && locate(tree, r.provider_id, r.model))
      .slice(0, RECENTS_SHOWN);
    return (
      <>
        {renderFilterField()}
        <div className="mpick-scroll" role="listbox">
          {renderHeadRow()}
          {visibleRecents.length > 0 && (
            <>
              <div className="mpick-grp">Recent</div>
              {visibleRecents.map((r) => {
                const loc = locate(tree, r.provider_id, r.model);
                return loc ? renderSearchRow(loc.family, loc.version, loc.source) : null;
              })}
            </>
          )}
          <div className="mpick-grp">All models</div>
          {families.map((f) => renderFamilyRow(f))}
        </div>
      </>
    );
  }

  function renderFamilyPane(familyId: string) {
    const family = tree?.families.find((f) => f.id === familyId);
    if (!family) return null;
    return (
      <>
        <div className="mpick-ph">
          <button type="button" className="mpick-back" onClick={back} aria-label="Back">
            {backIcon()}
          </button>
          <span>{family.label}</span>
        </div>
        <div className="mpick-scroll" role="listbox">
          {family.versions.map((v) => renderVersionRow(family, v))}
        </div>
      </>
    );
  }

  function renderSourcePane(familyId: string, versionId: string) {
    const family = tree?.families.find((f) => f.id === familyId);
    const version = family?.versions.find((v) => v.id === versionId);
    if (!family || !version) return null;
    return (
      <>
        <div className="mpick-ph">
          <button type="button" className="mpick-back" onClick={back} aria-label="Back">
            {backIcon()}
          </button>
          <span>{version.label}</span>
          {version.ctx > 0 && <span className="mpick-ctx">{formatCtx(version.ctx)}</span>}
        </div>
        <div className="mpick-scroll" role="listbox">
          {version.sources.map((s) => renderSourceRow(s))}
        </div>
      </>
    );
  }

  function renderEnvPane() {
    return (
      <>
        <div className="mpick-ph">
          <button type="button" className="mpick-back" onClick={back} aria-label="Back">
            {backIcon()}
          </button>
          <span>Environment</span>
        </div>
        <div className="mpick-scroll" role="listbox">
          {env.options.map((opt) => (
            <div
              key={opt.id}
              className={`mpick-row${opt.id === env.current ? " on" : ""}`}
              role="option"
              aria-selected={opt.id === env.current}
              tabIndex={0}
              data-act="env"
              onClick={() => switchEnvironment(opt.id)}
            >
              <span className="mpick-pm">{envMarkFor(opt.id)}</span>
              <span className="mpick-lbl">
                <span className="mpick-nm">{opt.label}</span>
                <span className="mpick-sub">{opt.id === env.projectDefault ? "project default" : "connected"}</span>
              </span>
              {opt.id === env.current && <span className="mpick-chk">{Icon.check()}</span>}
            </div>
          ))}
        </div>
        <div className="mpick-note">
          Only models that can run in the chosen environment are listed. The project default is set in project settings.
        </div>
      </>
    );
  }

  function renderPane(pane: Pane) {
    switch (pane.kind) {
      case "root":
        return renderRoot();
      case "family":
        return renderFamilyPane(pane.familyId);
      case "source":
        return renderSourcePane(pane.familyId, pane.versionId);
      case "env":
        return renderEnvPane();
    }
  }

  function renderFlat() {
    const families = tree?.families ?? [];
    return (
      <div className="mpick-scroll mpick-flat" role="listbox">
        {renderHeadRow()}
        {families.map((family) => (
          <div key={family.id}>
            <div className="mpick-grp">{family.label}</div>
            {family.versions.map((v) => renderVersionRow(family, v))}
          </div>
        ))}
      </div>
    );
  }

  function renderBody() {
    if (flat) return renderFlat();
    return (
      <div className="mpick-panes">
        {panes.map((pane, i) => (
          <div
            key={i}
            className="mpick-pane"
            style={{ transform: `translateX(${(i - depth) * 100}%)` }}
            aria-hidden={i !== depth}
          >
            {renderPane(pane)}
          </div>
        ))}
      </div>
    );
  }

  function renderFooter() {
    if (pinned) return null;
    const currentLabel = env.options.find((o) => o.id === env.current)?.label ?? env.current;
    if (env.options.length > 1) {
      return (
        <button type="button" className="mpick-foot" onClick={() => go({ kind: "env" })}>
          {envMarkFor(env.current)}
          <span>
            Runs in <b>{currentLabel}</b>
          </span>
          <span className="mpick-chg">Change</span>
        </button>
      );
    }
    return (
      <div className="mpick-foot mpick-foot-still">
        {envMarkFor(env.current)}
        <span>
          Runs in <b>{currentLabel}</b>
        </span>
      </div>
    );
  }

  const content = (
    <div
      className={`mpick${flat ? " is-flat" : ""} mpick-${variant}${className ? ` ${className}` : ""}`}
      onKeyDown={handleKeyDown}
    >
      {renderBody()}
      {renderFooter()}
      {note && <div className="mpick-note-below">{note}</div>}
    </div>
  );

  if (variant === "inline") return content;

  if (variant === "sheet") {
    if (typeof document === "undefined") return null;
    return createPortal(
      <div className="mpick-sheet-overlay" onClick={onClose}>
        <div className="mpick-sheet-shell" onClick={(e) => e.stopPropagation()}>
          <div className="mpick-grabber" />
          <div className="mpick-sheet-head">
            <span>Model</span>
            <button type="button" className="mpick-close" onClick={onClose} aria-label="Close">
              {Icon.x()}
            </button>
          </div>
          {content}
        </div>
      </div>,
      document.body,
    );
  }

  return <Popover onClose={onClose ?? (() => {})}>{content}</Popover>;
}
