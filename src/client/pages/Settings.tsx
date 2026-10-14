import React, { useCallback, useEffect, useState } from "react";
import { get, post, del } from "../api";
import { useEvent } from "../hooks/useWebSocket";
import { useAuth } from "../hooks/useAuth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { LogOut, Trash2, RotateCw, ExternalLink, RefreshCw, Download, Plus, Edit2, FileText } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useConnectorPlatform } from "../hooks/useConnectorPlatform";

type OtaStage =
  | "idle"
  | "checking"
  | "downloading"
  | "verifying"
  | "flashing"
  | "ready"
  | "failed";

interface ConnectorOtaStatus {
  inProgress: boolean;
  stage: OtaStage;
  currentVersion: string;
  targetVersion: string | null;
  activeSlot: "A" | "B" | "unknown";
  inactiveSlot: "A" | "B" | "unknown";
  supported: boolean;
  rebootRequired: boolean;
  updateAvailable: boolean | null;
  availableVersion: string | null;
  bytesComplete: number | null;
  bytesTotal: number | null;
  percent: number | null;
  speedBytesPerSecond: number | null;
  error: string | null;
}

interface ConnectorOtaCheck {
  updateAvailable: boolean;
  currentVersion: string;
  version: string | null;
  channel: string;
  size: number | null;
  message?: string;
}

interface SystemMediaStatus {
  supported: boolean;
  enabled: boolean;
  forced: boolean;
  active: boolean;
}

interface AppDefinition {
  id: string;
  name: string;
  target: string;
  fallbacks?: string[];
  enabled?: boolean;
}

interface MacroDefinition {
  id: string;
  name: string;
  action: {
    type: string;
    [key: string]: any;
  };
  enabled?: boolean;
}

interface DiagnosticsReport {
  timestamp: string;
  version: string;
  platform: string;
  connectorPlatform: string | null;
  sidecarReadiness: boolean;
  hostBridgeConnected: boolean;
  carThingConnected: boolean;
  carThingDevices: Array<{ id: string; deviceInfo: any }>;
  hostStatus: any;
  recentLogs: string[];
  health?: { featureProbe: string; sidecar: string };
  build?: { arch: string; runtime: string };
}

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "Unknown";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(raw);
    return parsed.error ?? raw;
  } catch {
    return raw;
  }
}

function stageLabel(stage: OtaStage): string {
  switch (stage) {
    case "downloading":
      return "Downloading";
    case "verifying":
      return "Verifying";
    case "flashing":
      return "Flashing";
    case "ready":
      return "Ready to reboot";
    case "failed":
      return "Failed";
    case "checking":
      return "Checking";
    default:
      return "Idle";
  }
}

export function Settings() {
  const { user, signOut, refresh } = useAuth();
  const { isWindows } = useConnectorPlatform();
  const [info, setInfo] = useState<any>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [analyticsEnabled, setAnalyticsEnabled] = useState<boolean | null>(null);
  const [analyticsBusy, setAnalyticsBusy] = useState(false);
  const [systemMedia, setSystemMedia] = useState<SystemMediaStatus | null>(null);
  const [systemMediaBusy, setSystemMediaBusy] = useState(false);
  const [otaStatus, setOtaStatus] = useState<ConnectorOtaStatus | null>(null);
  const [otaCheck, setOtaCheck] = useState<ConnectorOtaCheck | null>(null);
  const [otaBusy, setOtaBusy] = useState<"check" | "start" | null>(null);
  const [otaError, setOtaError] = useState<string | null>(null);

  // App & Macro Config state
  const [apps, setApps] = useState<AppDefinition[]>([]);
  const [macros, setMacros] = useState<MacroDefinition[]>([]);
  const [editingApp, setEditingApp] = useState<Partial<AppDefinition> | null>(null);
  const [editingMacro, setEditingMacro] = useState<Partial<MacroDefinition> | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  // Diagnostics state
  const [diagnostics, setDiagnostics] = useState<DiagnosticsReport | null>(null);

  const fetchConfig = useCallback(() => {
    get<{ apps: AppDefinition[] }>("/api/config/apps")
      .then((res) => setApps(res.apps || []))
      .catch(() => {});
    get<{ macros: MacroDefinition[] }>("/api/config/macros")
      .then((res) => setMacros(res.macros || []))
      .catch(() => {});
  }, []);

  const fetchDiagnostics = useCallback(() => {
    get<{ diagnostics: DiagnosticsReport }>("/api/diagnostics/status")
      .then((res) => setDiagnostics(res.diagnostics))
      .catch(() => {});
  }, []);

  useEffect(() => {
    get("/api/info").then(setInfo).catch(() => { });
    fetchConfig();
    fetchDiagnostics();
  }, [fetchConfig, fetchDiagnostics]);

  useEffect(() => {
    get<{ enabled: boolean }>("/api/analytics/status")
      .then((r) => setAnalyticsEnabled(r.enabled))
      .catch(() => { });
  }, []);

  const refreshSystemMedia = useCallback(() => {
    if (!isWindows) return;
    get<SystemMediaStatus>("/api/media/status")
      .then(setSystemMedia)
      .catch(() => { });
  }, [isWindows]);

  useEffect(() => {
    refreshSystemMedia();
  }, [refreshSystemMedia]);

  useEvent("spotify.auth.status", refreshSystemMedia);

  useEffect(() => {
    if (isWindows) return;
    get<ConnectorOtaStatus>("/api/ota/connector/status")
      .then(setOtaStatus)
      .catch(() => { });
  }, [isWindows]);

  useEvent(
    "connector.ota.status",
    useCallback((status: ConnectorOtaStatus) => {
      setOtaStatus(status);
      if (status.error) setOtaError(status.error);
    }, [])
  );

  const handleDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await post("/api/auth/delete-account");
      if (res.error) throw new Error(res.error);
      setDeleteOpen(false);
      await refresh();
    } catch (err: any) {
      setDeleteError(err.message ?? "Unable to delete your account right now.");
    } finally {
      setDeleting(false);
    }
  };

  const handleAnalyticsToggle = async (checked: boolean) => {
    if (analyticsBusy) return;
    const prev = analyticsEnabled;
    setAnalyticsEnabled(checked);
    setAnalyticsBusy(true);
    try {
      const res = await post<{ enabled: boolean }>("/api/analytics/enabled", {
        enabled: checked,
      });
      setAnalyticsEnabled(res.enabled);
    } catch {
      if (prev !== null) setAnalyticsEnabled(prev);
    } finally {
      setAnalyticsBusy(false);
    }
  };

  const handleSystemMediaToggle = async (checked: boolean) => {
    if (systemMediaBusy || systemMedia?.forced) return;
    const previous = systemMedia;
    setSystemMedia((current) => current ? { ...current, enabled: checked, active: checked } : current);
    setSystemMediaBusy(true);
    try {
      setSystemMedia(await post<SystemMediaStatus>("/api/media/enabled", { enabled: checked }));
    } catch {
      setSystemMedia(previous);
    } finally {
      setSystemMediaBusy(false);
    }
  };

  const handleOtaCheck = async () => {
    if (otaBusy || otaStatus?.inProgress) return;
    setOtaBusy("check");
    setOtaError(null);
    try {
      const result = await post<ConnectorOtaCheck>("/api/ota/connector/check", {
        channel: "stable",
      });
      setOtaCheck(result);
      const status = await get<ConnectorOtaStatus>("/api/ota/connector/status");
      setOtaStatus(status);
    } catch (err) {
      setOtaError(errorMessage(err));
    } finally {
      setOtaBusy(null);
    }
  };

  const handleOtaStart = async () => {
    if (otaBusy || otaStatus?.inProgress || !otaCheck?.version) return;
    setOtaBusy("start");
    setOtaError(null);
    try {
      const status = await post<ConnectorOtaStatus>("/api/ota/connector/start", {
        channel: otaCheck.channel,
        targetVersion: otaCheck.version,
      });
      setOtaStatus(status);
    } catch (err) {
      setOtaError(errorMessage(err));
    } finally {
      setOtaBusy(null);
    }
  };

  const handleSaveApp = async () => {
    if (!editingApp || !editingApp.id || !editingApp.name || !editingApp.target) {
      setConfigError("ID, Name, and Target are required for applications.");
      return;
    }
    setConfigError(null);
    try {
      await post("/api/config/apps", editingApp);
      setEditingApp(null);
      fetchConfig();
    } catch (err: any) {
      setConfigError(errorMessage(err));
    }
  };

  const handleDeleteApp = async (id: string) => {
    try {
      await del(`/api/config/apps/${id}`);
      fetchConfig();
    } catch (err: any) {
      setConfigError(errorMessage(err));
    }
  };

  const handleToggleAppEnabled = async (appDef: AppDefinition, enabled: boolean) => {
    try {
      await post("/api/config/apps", { ...appDef, enabled });
      fetchConfig();
    } catch (err: any) {
      setConfigError(errorMessage(err));
    }
  };

  const handleSaveMacro = async () => {
    if (!editingMacro || !editingMacro.id || !editingMacro.name || !editingMacro.action?.type) {
      setConfigError("ID, Name, and Action Type are required for macros.");
      return;
    }
    setConfigError(null);
    try {
      await post("/api/config/macros", editingMacro);
      setEditingMacro(null);
      fetchConfig();
    } catch (err: any) {
      setConfigError(errorMessage(err));
    }
  };

  const handleDeleteMacro = async (id: string) => {
    try {
      await del(`/api/config/macros/${id}`);
      fetchConfig();
    } catch (err: any) {
      setConfigError(errorMessage(err));
    }
  };

  const handleToggleMacroEnabled = async (macroDef: MacroDefinition, enabled: boolean) => {
    try {
      await post("/api/config/macros", { ...macroDef, enabled });
      fetchConfig();
    } catch (err: any) {
      setConfigError(errorMessage(err));
    }
  };

  const handleExportDiagnostics = () => {
    window.open("/api/diagnostics/export", "_blank");
  };

  const progressValue = otaStatus?.percent ?? 0;
  const showProgress =
    otaStatus?.inProgress &&
    ["downloading", "verifying", "flashing"].includes(otaStatus.stage);
  const installableUpdate = Boolean(otaCheck?.updateAvailable && otaCheck.version);

  return (
    <div>
      <div className="mb-10">
        <h2 className="text-3xl font-semibold tracking-tight text-fg">
          Settings
        </h2>
        <p className="mt-2 text-secondary">
          Manage your account, view system info, and configure your connector.
        </p>
      </div>

      <div className="space-y-8">
        <section>
          <h3 className="mb-4 text-xs font-medium uppercase tracking-widest text-muted">
            Account
          </h3>
          <Card>
            <CardContent className="space-y-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm text-secondary">Signed in as</p>
                  <p className="mt-0.5 break-all text-lg font-medium text-fg">{user?.email}</p>
                </div>
                <Button variant="outline" size="sm" onClick={signOut} className="shrink-0">
                  <LogOut className="size-3.5" />
                  Sign Out
                </Button>
              </div>
              <div className="border-t border-line pt-4">
                <p className="text-sm text-secondary">
                  Manage your password and account at{" "}
                  <a
                    href="https://usenocturne.com/login"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-accent transition hover:text-accent-hover"
                  >
                    usenocturne.com
                    <ExternalLink className="size-3" />
                  </a>
                </p>
              </div>
            </CardContent>
          </Card>
        </section>

        <section>
          <h3 className="mb-4 text-xs font-medium uppercase tracking-widest text-muted">
            System Diagnostics
          </h3>
          <Card>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="font-medium text-fg">Connection Status</p>
                  <p className="text-sm text-secondary">Read-only connection & route diagnostics</p>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={fetchDiagnostics}>
                    <RefreshCw className="size-3.5" />
                    Refresh
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleExportDiagnostics}>
                    <FileText className="size-3.5" />
                    Export Support Bundle
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex items-center justify-between rounded-lg bg-bg px-3 py-2.5">
                  <span className="text-sm text-secondary">Native Host Bridge</span>
                  <Badge variant={diagnostics?.hostBridgeConnected ? "success" : "secondary"}>
                    {diagnostics?.hostBridgeConnected ? "Connected" : "Not Detected"}
                  </Badge>
                </div>
                <div className="flex items-center justify-between rounded-lg bg-bg px-3 py-2.5">
                  <span className="text-sm text-secondary">Car Thing Connection</span>
                  <Badge variant={diagnostics?.carThingConnected ? "success" : "secondary"}>
                    {diagnostics?.carThingConnected ? "Connected" : "Disconnected"}
                  </Badge>
                </div>
              </div>

              <div className="space-y-3">
                {[
                  ["Connector Version", diagnostics?.version ?? info?.version ?? "Unknown"],
                  ["Platform", diagnostics?.connectorPlatform ?? diagnostics?.platform ?? "Unknown"],
                  ["Connected Devices", `${diagnostics?.carThingDevices?.length ?? 0} device(s)`],
                  ["Sidecar", diagnostics?.health?.sidecar ?? "Unknown"],
                  ["Feature Probe", diagnostics?.health?.featureProbe ?? "Unknown"],
                  ["Runtime", diagnostics?.build?.runtime ?? "Unknown"],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between rounded-lg bg-bg px-3 py-2.5">
                    <span className="text-sm text-secondary">{label}</span>
                    <span className="text-sm font-medium text-fg">{value}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </section>

        {isWindows && (
          <section>
            <h3 className="mb-4 text-xs font-medium uppercase tracking-widest text-muted">
              Configured Applications
            </h3>
            <Card>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-fg">App Launch Allowlist</p>
                    <p className="text-sm text-secondary">Configure launch targets authorized for Car Thing execution</p>
                  </div>
                  <Button size="sm" onClick={() => setEditingApp({ id: "", name: "", target: "", enabled: true })}>
                    <Plus className="size-3.5" />
                    Add App
                  </Button>
                </div>

                {configError && (
                  <Alert variant="destructive">
                    <AlertDescription>{configError}</AlertDescription>
                  </Alert>
                )}

                <div className="space-y-2">
                  {apps.map((app) => (
                    <div key={app.id} className="flex items-center justify-between rounded-lg bg-bg p-3">
                      <div className="min-w-0 pr-2">
                        <p className="font-medium text-fg">{app.name} <span className="text-xs text-muted">({app.id})</span></p>
                        <p className="truncate text-xs text-secondary">{app.target}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Switch
                          checked={app.enabled !== false}
                          onCheckedChange={(checked) => handleToggleAppEnabled(app, checked)}
                          aria-label={`Toggle ${app.name}`}
                        />
                        <Button variant="ghost" size="sm" onClick={() => setEditingApp(app)}>
                          <Edit2 className="size-3.5" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => handleDeleteApp(app.id)}>
                          <Trash2 className="size-3.5 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  ))}
                  {apps.length === 0 && (
                    <p className="text-sm text-secondary py-2">No applications configured.</p>
                  )}
                </div>

                {editingApp && (
                  <div className="border-t border-line pt-4 space-y-3">
                    <p className="font-medium text-sm text-fg">{editingApp.id ? "Edit App" : "Add App"}</p>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <input
                        type="text"
                        placeholder="App ID (e.g. vscode)"
                        value={editingApp.id || ""}
                        disabled={Boolean(editingApp.id && apps.some(a => a.id === editingApp.id))}
                        onChange={(e) => setEditingApp({ ...editingApp, id: e.target.value })}
                        className="rounded-md border border-line bg-bg px-3 py-1.5 text-sm"
                      />
                      <input
                        type="text"
                        placeholder="Display Name"
                        value={editingApp.name || ""}
                        onChange={(e) => setEditingApp({ ...editingApp, name: e.target.value })}
                        className="rounded-md border border-line bg-bg px-3 py-1.5 text-sm"
                      />
                    </div>
                    <input
                      type="text"
                      placeholder="Target Path or Protocol (e.g. calc.exe, vscode://)"
                      value={editingApp.target || ""}
                      onChange={(e) => setEditingApp({ ...editingApp, target: e.target.value })}
                      className="w-full rounded-md border border-line bg-bg px-3 py-1.5 text-sm"
                    />
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={() => setEditingApp(null)}>
                        Cancel
                      </Button>
                      <Button size="sm" onClick={handleSaveApp}>
                        Save App
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </section>
        )}

        {isWindows && (
          <section>
            <h3 className="mb-4 text-xs font-medium uppercase tracking-widest text-muted">
              Configured Macros
            </h3>
            <Card>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-fg">Macro Definitions</p>
                    <p className="text-sm text-secondary">Configure authorized shortcut and macro routines</p>
                  </div>
                  <Button size="sm" onClick={() => setEditingMacro({ id: "", name: "", action: { type: "media", control: "toggle" }, enabled: true })}>
                    <Plus className="size-3.5" />
                    Add Macro
                  </Button>
                </div>

                <div className="space-y-2">
                  {macros.map((m) => (
                    <div key={m.id} className="flex items-center justify-between rounded-lg bg-bg p-3">
                      <div className="min-w-0 pr-2">
                        <p className="font-medium text-fg">{m.name} <span className="text-xs text-muted">({m.id})</span></p>
                        <p className="truncate text-xs text-secondary">
                          Type: {m.action.type} {m.action.appId ? `(${m.action.appId})` : m.action.control ? `(${m.action.control})` : m.action.url ? `(${m.action.url})` : m.action.shortcut ? `(${m.action.shortcut})` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Switch
                          checked={m.enabled !== false}
                          onCheckedChange={(checked) => handleToggleMacroEnabled(m, checked)}
                          aria-label={`Toggle ${m.name}`}
                        />
                        <Button variant="ghost" size="sm" onClick={() => setEditingMacro(m)}>
                          <Edit2 className="size-3.5" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => handleDeleteMacro(m.id)}>
                          <Trash2 className="size-3.5 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  ))}
                  {macros.length === 0 && (
                    <p className="text-sm text-secondary py-2">No macros configured.</p>
                  )}
                </div>

                {editingMacro && (
                  <div className="border-t border-line pt-4 space-y-3">
                    <p className="font-medium text-sm text-fg">{editingMacro.id ? "Edit Macro" : "Add Macro"}</p>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <input
                        type="text"
                        placeholder="Macro ID (e.g. toggle_media)"
                        value={editingMacro.id || ""}
                        disabled={Boolean(editingMacro.id && macros.some(m => m.id === editingMacro.id))}
                        onChange={(e) => setEditingMacro({ ...editingMacro, id: e.target.value })}
                        className="rounded-md border border-line bg-bg px-3 py-1.5 text-sm"
                      />
                      <input
                        type="text"
                        placeholder="Display Name"
                        value={editingMacro.name || ""}
                        onChange={(e) => setEditingMacro({ ...editingMacro, name: e.target.value })}
                        className="rounded-md border border-line bg-bg px-3 py-1.5 text-sm"
                      />
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <select
                        value={editingMacro.action?.type || "media"}
                        onChange={(e) => setEditingMacro({ ...editingMacro, action: { ...editingMacro.action, type: e.target.value } })}
                        className="rounded-md border border-line bg-bg px-3 py-1.5 text-sm"
                      >
                        <option value="media">Media Control</option>
                        <option value="app">App Launch</option>
                        <option value="url">Open URL</option>
                        <option value="shortcut">System Shortcut</option>
                      </select>
                      {editingMacro.action?.type === "app" && (
                        <input
                          type="text"
                          placeholder="App ID (e.g. vscode)"
                          value={editingMacro.action?.appId || ""}
                          onChange={(e) => setEditingMacro({ ...editingMacro, action: { ...editingMacro.action, type: "app", appId: e.target.value } })}
                          className="rounded-md border border-line bg-bg px-3 py-1.5 text-sm"
                        />
                      )}
                      {editingMacro.action?.type === "media" && (
                        <select
                          value={editingMacro.action?.control || "toggle"}
                          onChange={(e) => setEditingMacro({ ...editingMacro, action: { ...editingMacro.action, type: "media", control: e.target.value } })}
                          className="rounded-md border border-line bg-bg px-3 py-1.5 text-sm"
                        >
                          <option value="toggle">Toggle Play/Pause</option>
                          <option value="play">Play</option>
                          <option value="pause">Pause</option>
                          <option value="next">Next Track</option>
                          <option value="previous">Previous Track</option>
                          <option value="volume_up">Volume Up</option>
                          <option value="volume_down">Volume Down</option>
                        </select>
                      )}
                      {editingMacro.action?.type === "url" && (
                        <input
                          type="text"
                          placeholder="URL (e.g. https://usenocturne.com/)"
                          value={editingMacro.action?.url || ""}
                          onChange={(e) => setEditingMacro({ ...editingMacro, action: { ...editingMacro.action, type: "url", url: e.target.value } })}
                          className="rounded-md border border-line bg-bg px-3 py-1.5 text-sm"
                        />
                      )}
                      {editingMacro.action?.type === "shortcut" && (
                        <input
                          type="text"
                          placeholder="Shortcut identifier (e.g. media_next)"
                          value={editingMacro.action?.shortcut || ""}
                          onChange={(e) => setEditingMacro({ ...editingMacro, action: { ...editingMacro.action, type: "shortcut", shortcut: e.target.value } })}
                          className="rounded-md border border-line bg-bg px-3 py-1.5 text-sm"
                        />
                      )}
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={() => setEditingMacro(null)}>
                        Cancel
                      </Button>
                      <Button size="sm" onClick={handleSaveMacro}>
                        Save Macro
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </section>
        )}

        {isWindows && <section>
          <h3 className="mb-4 text-xs font-medium uppercase tracking-widest text-muted">
            Media
          </h3>
          <Card>
            <CardContent>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="font-medium text-fg">System media</p>
                  <p className="mt-0.5 text-sm text-secondary">
                    {systemMedia?.forced
                      ? "Always on while Spotify is skipped, so Nocturne can still show what's playing."
                      : "Show media playing on this Windows PC from any app on Nocturne. Turn off to use Spotify only."}
                  </p>
                </div>
                <Switch
                  checked={systemMedia?.forced || systemMedia?.enabled || false}
                  onCheckedChange={handleSystemMediaToggle}
                  disabled={!systemMedia?.supported || systemMediaBusy || systemMedia?.forced === true}
                  aria-label="Toggle system media"
                  className="shrink-0"
                />
              </div>
            </CardContent>
          </Card>
        </section>}

        {!isWindows && <section>
          <h3 className="mb-4 text-xs font-medium uppercase tracking-widest text-muted">
            Updates
          </h3>
          <Card>
            <CardContent className="space-y-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-fg">Connector OS</p>
                    {otaStatus && (
                      <Badge
                        variant={otaStatus.stage === "failed" ? "destructive" : otaStatus.rebootRequired ? "success" : "secondary"}
                      >
                        {stageLabel(otaStatus.stage)}
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleOtaCheck}
                    disabled={otaBusy !== null || otaStatus?.inProgress}
                  >
                    <RefreshCw className={otaBusy === "check" ? "size-3.5 animate-spin" : "size-3.5"} />
                    {otaBusy === "check" ? "Checking" : "Check"}
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleOtaStart}
                    disabled={!installableUpdate || otaBusy !== null || otaStatus?.inProgress || otaStatus?.rebootRequired}
                  >
                    <Download className="size-3.5" />
                    {otaBusy === "start" ? "Starting" : "Update"}
                  </Button>
                  {otaStatus?.rebootRequired && (
                    <Button size="sm" onClick={() => post("/api/power/reboot")}>
                      <RotateCw className="size-3.5" />
                      Reboot
                    </Button>
                  )}
                </div>
              </div>

              <div className="space-y-3">
                {[
                  ["Current Version", otaStatus?.currentVersion ?? info?.version ?? "Unknown"],
                  ["Available Version", otaCheck?.version ?? otaStatus?.availableVersion ?? "None"],
                  ["Package Size", formatBytes(otaCheck?.size)],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between rounded-lg bg-bg px-3 py-2.5">
                    <span className="text-sm text-secondary">{label}</span>
                    <span className="text-sm font-medium text-fg">{value}</span>
                  </div>
                ))}
              </div>

              {showProgress && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-secondary">
                    <span>{stageLabel(otaStatus.stage)}</span>
                    <span>{otaStatus.percent !== null ? `${otaStatus.percent}%` : formatBytes(otaStatus.bytesComplete)}</span>
                  </div>
                  <Progress value={progressValue} />
                </div>
              )}

              {otaCheck && !otaCheck.updateAvailable && (
                <p className="text-sm text-secondary">
                  {otaCheck.message ?? "Connector is up to date."}
                </p>
              )}

              {otaStatus?.rebootRequired && (
                <Alert>
                  <AlertDescription>Update staged. Reboot to finish.</AlertDescription>
                </Alert>
              )}

              {otaError && (
                <Alert variant="destructive">
                  <AlertDescription>{otaError}</AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </section>}

        <section>
          <h3 className="mb-4 text-xs font-medium uppercase tracking-widest text-muted">
            Privacy
          </h3>
          <Card>
            <CardContent>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="font-medium text-fg">Analytics</p>
                  <p className="mt-0.5 text-sm text-secondary">
                    Help improve Nocturne by sharing usage data.
                  </p>
                </div>
                <Switch
                  checked={analyticsEnabled ?? true}
                  onCheckedChange={handleAnalyticsToggle}
                  disabled={analyticsEnabled === null || analyticsBusy}
                  aria-label="Toggle analytics"
                  className="shrink-0"
                />
              </div>
            </CardContent>
          </Card>
        </section>

        <section>
          <h3 className="mb-4 text-xs font-medium uppercase tracking-widest text-destructive/60">
            Danger Zone
          </h3>
          <Card className="border-destructive/20">
            <CardContent className="space-y-4">
              {!isWindows && <>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium text-fg">Reboot Device</p>
                  <p className="mt-0.5 text-sm text-secondary">
                    Temporarily disconnects all services while the device restarts.
                  </p>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm" className="shrink-0">
                      <RotateCw className="size-3.5" />
                      Reboot
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Reboot Connector</AlertDialogTitle>
                      <AlertDialogDescription>
                        Are you sure you want to reboot the device? This will temporarily disconnect all services.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => post("/api/power/reboot")}>
                        Reboot
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>

              <div className="border-t border-line" />
              </>}

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium text-fg">Delete Account</p>
                  <p className="mt-0.5 text-sm text-secondary">
                    Permanently removes your account and all associated data.
                  </p>
                </div>
                <AlertDialog
                  open={deleteOpen}
                  onOpenChange={(open) => {
                    if (deleting) return;
                    setDeleteOpen(open);
                    if (!open) setDeleteError(null);
                  }}
                >
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" size="sm" className="shrink-0">
                      <Trash2 className="size-3.5" />
                      Delete Account
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete Account</AlertDialogTitle>
                      <AlertDialogDescription>
                        Deleting your account will remove all associated data. This action cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    {deleteError && (
                      <Alert variant="destructive">
                        <AlertDescription>{deleteError}</AlertDescription>
                      </Alert>
                    )}
                    <AlertDialogFooter>
                      <AlertDialogCancel disabled={deleting}>
                        Cancel
                      </AlertDialogCancel>
                      <AlertDialogAction
                        variant="destructive"
                        disabled={deleting}
                        onClick={handleDelete}
                      >
                        {deleting ? "Deleting..." : "Delete Account"}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
}
