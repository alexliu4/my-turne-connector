import { createLogger } from "../utils/logger";
import type { HostBridgeClient } from "../platform/host-bridge";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";
import { SYSTEM_MEDIA_ENABLED_PATH } from "../config";

const log = createLogger("SystemMediaService");

export type HostMediaControlAction =
  | "play"
  | "pause"
  | "stop"
  | "toggle"
  | "next"
  | "previous"
  | "shuffle"
  | "repeat"
  | "volume_up"
  | "volume_down"
  | "like"
  | "unlike";

export type HostMediaControlStatus = "ok" | "unsupported" | "disabled";

export interface MediaNowPlayingUpdate {
  media_item_attributes: Record<string, string | number | boolean>;
  playback_attributes: Record<string, string | number | boolean>;
  media_generation: number;
}

export interface MediaNowPlayingArtwork {
  data: string;
  content_type: string;
  media_generation: number;
}

export interface AudioOutputDevice {
  id: string;
  name: string;
  state: string;
  isDefault: boolean;
  defaultRoles: {
    console: boolean;
    multimedia: boolean;
    communications: boolean;
  };
}

export interface GetAudioOutputsResponse {
  status: string;
  selectedDeviceId?: string | null;
  devices: AudioOutputDevice[];
}

export interface SelectAudioOutputResponse {
  status: string;
  deviceId?: string;
  confirmed?: boolean;
}

export interface AudioSession {
  id: string;
  endpointId: string;
  appName: string;
  processId: number;
  volumePercent: number;
  muted: boolean;
}

export interface AudioSessionsResponse {
  status: string;
  sessions: AudioSession[];
}

export interface SetAudioSessionVolumeResponse {
  status: string;
  confirmedVolumePercent?: number;
}

export interface SetAudioSessionMuteResponse {
  status: string;
  confirmedMuted?: boolean;
}

// Validate both explicit fields before choosing the plural field's precedence.
export function parseAudioOutputRoles(params: Record<string, unknown>): string[] | null {
  const validRole = (value: unknown): value is string =>
    typeof value === "string" && ["console", "multimedia", "communications", "all"].includes(value.toLowerCase());
  if ("roles" in params && (!Array.isArray(params.roles) || params.roles.length === 0 || !Array.from(params.roles).every(validRole))) {
    return null;
  }
  if ("role" in params && !validRole(params.role)) return null;
  return "roles" in params ? params.roles as string[]
    : "role" in params ? [params.role as string]
    : ["console", "multimedia"];
}

export interface SystemMediaSink {
  sendEvent(topic: string, data: unknown): Promise<void>;
  sendVolume(volumePercent: number, muted?: boolean): Promise<void>;
}

export interface SystemMediaPreferenceStore {
  load(): boolean;
  save(enabled: boolean): void;
}

class FileSystemMediaPreferenceStore implements SystemMediaPreferenceStore {
  constructor(private readonly path = SYSTEM_MEDIA_ENABLED_PATH) {}

  load(): boolean {
    try {
      if (!existsSync(this.path)) return true;
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      return asRecord(parsed)?.enabled !== false;
    } catch (error) {
      log.warn(`Unable to read system media preference: ${errorMessage(error)}`);
      return true;
    }
  }

  save(enabled: boolean): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true });
    const temporary = `${this.path}.tmp.${process.pid}.${Date.now()}`;
    try {
      writeFileSync(temporary, JSON.stringify({ enabled }), { mode: 0o600 });
      renameSync(temporary, this.path);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch (cleanupError) {
        log.debug(`Unable to remove temporary media preference: ${errorMessage(cleanupError)}`);
      }
      throw error;
    }
  }
}

export class SystemMediaService {
  private readonly unsubscribe: Array<() => void> = [];
  private readonly pendingDeliveries = new Set<Promise<void>>();
  private latestMetadataDelivery: {
    generation: number;
    promise: Promise<void>;
  } | null = null;
  private latestNowPlaying: MediaNowPlayingUpdate | null = null;
  private latestNowPlayingReceivedAtMs: number | null = null;
  private latestArtwork: MediaNowPlayingArtwork | null = null;
  private latestNowPlayingSignature: string | null = null;
  private latestArtworkSignature: string | null = null;
  private spotifyLinked = false;
  private lifecycleStarted = false;
  private active = false;
  private systemMediaEnabled: boolean;
  private forcedOn = false;
  private volumePercent: number | null = null;
  private muted: boolean | null = null;
  private volumeSupported = false;
  private volumeRevision = 0;
  private volumeUnsubscribe: (() => void) | null = null;

  constructor(
    private readonly hostBridge: HostBridgeClient,
    private readonly sink: SystemMediaSink,
    private readonly preferenceStore: SystemMediaPreferenceStore =
      new FileSystemMediaPreferenceStore(),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.systemMediaEnabled = preferenceStore.load();
  }

  get currentVolumePercent(): number | null {
    return this.volumePercent;
  }

  get currentMuted(): boolean | null {
    return this.muted;
  }

  get isSystemMediaEnabled(): boolean {
    return this.systemMediaEnabled;
  }

  get isForcedOn(): boolean {
    return this.forcedOn;
  }

  get isActive(): boolean {
    return this.active;
  }

  get isVolumeSupported(): boolean {
    return this.volumeSupported;
  }

  get latestState(): { sourceApp: string | null; playbackState: string | null } | null {
    if (!this.latestNowPlaying) return null;
    const sourceApp = typeof this.latestNowPlaying.playback_attributes?.PlaybackAppName === "string"
      ? this.latestNowPlaying.playback_attributes.PlaybackAppName
      : null;
    const playbackState = typeof this.latestNowPlaying.playback_attributes?.PlaybackStatus === "string"
      ? this.latestNowPlaying.playback_attributes.PlaybackStatus
      : null;
    return { sourceApp, playbackState };
  }

  async start(): Promise<void> {
    if (this.lifecycleStarted) return;
    this.lifecycleStarted = true;
    this.volumeUnsubscribe = this.hostBridge.onEvent("device.volume.update", (data) => {
      this.handleVolume(data);
    });
    // Optional discovery uses the shared bridge and never gates Bluetooth startup.
    void this.refreshVolume();
    await this.applyActivation();
  }

  async stop(): Promise<void> {
    if (!this.lifecycleStarted) return;
    this.lifecycleStarted = false;
    if (this.volumeUnsubscribe) {
      this.volumeUnsubscribe();
      this.volumeUnsubscribe = null;
    }
    await this.deactivate(false);
  }

  async setSystemMediaEnabled(enabled: boolean): Promise<void> {
    if (this.systemMediaEnabled === enabled) return;
    this.preferenceStore.save(enabled);
    this.systemMediaEnabled = enabled;
    await this.applyActivation();
  }

  async setForcedOn(forced: boolean): Promise<void> {
    if (this.forcedOn === forced) return;
    this.forcedOn = forced;
    await this.applyActivation();
  }

  async setSpotifyLinked(linked: boolean): Promise<void> {
    if (this.spotifyLinked === linked) return;
    this.spotifyLinked = linked;

    if (linked && isSpotifyNowPlaying(this.latestNowPlaying)) {
      this.clearMediaCache();
    }

    if (!this.active) return;
    await this.hostBridge.call("media.set_spotify_linked", { linked });
  }

  async getVolume(options?: { timeoutMs?: number }): Promise<{ volume_percent: number; muted: boolean } | null> {
    let response: unknown;
    try {
      const callOptions = options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {};
      response = await this.hostBridge.call<unknown>("volume.get", {}, callOptions);
    } catch (error) {
      this.volumeSupported = false;
      throw error;
    }
    const rec = asRecord(response);
    if (!rec || rec.status === "unsupported") {
      if (rec?.status === "unsupported") this.volumeRevision++;
      this.volumeSupported = false;
      return null;
    }
    const volume_percent = normalizeVolumePercent(rec.volume_percent ?? rec.volumePercent);
    if (volume_percent === null) {
      this.volumeSupported = false;
      return null;
    }
    const muted = typeof rec.muted === "boolean" ? rec.muted : false;
    this.volumeRevision++;
    this.volumePercent = volume_percent;
    this.muted = muted;
    this.volumeSupported = true;
    return { volume_percent, muted };
  }

  async setVolume(percent: number): Promise<{ status: string; volume_percent?: number; muted?: boolean } | null> {
    if (typeof percent !== "number" || !Number.isFinite(percent)) {
      return { status: "unsupported" };
    }
    const bounded = Math.max(0, Math.min(100, Math.round(percent)));
    const response = await this.hostBridge.call<unknown>("volume.set", { volume_percent: bounded });
    const rec = asRecord(response);
    const status = (rec?.status as string) ?? "unsupported";
    if (status !== "ok") {
      if (rec?.status === "unsupported") this.volumeRevision++;
      this.volumeSupported = false;
      return { status };
    }
    const volume_percent = normalizeVolumePercent(rec?.volume_percent ?? rec?.volumePercent);
    const muted = typeof rec?.muted === "boolean" ? rec.muted : undefined;
    if (volume_percent === null || muted === undefined) {
      this.volumeSupported = false;
      return { status: "unsupported" };
    }
    this.volumeRevision++;
    this.volumePercent = volume_percent;
    this.muted = muted;
    this.volumeSupported = true;
    return { status: "ok", volume_percent, muted };
  }

  async adjustVolume(delta: number): Promise<{ status: string; volume_percent?: number; muted?: boolean } | null> {
    if (typeof delta !== "number" || !Number.isFinite(delta)) {
      return { status: "unsupported" };
    }
    const response = await this.hostBridge.call<unknown>("volume.adjust", { delta: Math.round(delta) });
    const rec = asRecord(response);
    const status = (rec?.status as string) ?? "unsupported";
    if (status !== "ok") {
      if (rec?.status === "unsupported") this.volumeRevision++;
      this.volumeSupported = false;
      return { status };
    }
    const volume_percent = normalizeVolumePercent(rec?.volume_percent ?? rec?.volumePercent);
    const muted = typeof rec?.muted === "boolean" ? rec.muted : undefined;
    if (volume_percent === null || muted === undefined) {
      this.volumeSupported = false;
      return { status: "unsupported" };
    }
    this.volumeRevision++;
    this.volumePercent = volume_percent;
    this.muted = muted;
    this.volumeSupported = true;
    return { status: "ok", volume_percent, muted };
  }

  async toggleMute(explicit?: boolean): Promise<{ status: string; volume_percent?: number; muted?: boolean } | null> {
    if (explicit !== undefined && typeof explicit !== "boolean") {
      return { status: "unsupported" };
    }
    const params: Record<string, unknown> = {};
    if (explicit !== undefined) {
      params.muted = explicit;
    }
    const response = await this.hostBridge.call<unknown>("volume.toggleMute", params);
    const rec = asRecord(response);
    const status = (rec?.status as string) ?? "unsupported";
    if (status !== "ok") {
      if (rec?.status === "unsupported") this.volumeRevision++;
      this.volumeSupported = false;
      return { status };
    }
    const volume_percent = normalizeVolumePercent(rec?.volume_percent ?? rec?.volumePercent);
    const muted = typeof rec?.muted === "boolean" ? rec.muted : undefined;
    if (volume_percent === null || muted === undefined) {
      this.volumeSupported = false;
      return { status: "unsupported" };
    }
    this.volumeRevision++;
    this.volumePercent = volume_percent;
    this.muted = muted;
    this.volumeSupported = true;
    return { status: "ok", volume_percent, muted };
  }

  async getAudioOutputs(options?: { timeoutMs?: number }): Promise<GetAudioOutputsResponse> {
    try {
      const callOptions = { timeoutMs: options?.timeoutMs ?? 3000 };
      const response = await this.hostBridge.call<unknown>("audio.outputs.list", {}, callOptions);
      const rec = asRecord(response);
      if (!rec || rec.status === "unsupported") {
        return { status: "unsupported", devices: [] };
      }
      const status = (rec.status as string) ?? "ok";
      const selectedDeviceId = typeof rec.selectedDeviceId === "string" ? rec.selectedDeviceId : (rec.selectedDeviceId === null ? null : undefined);
      const rawDevices = Array.isArray(rec.devices) ? rec.devices : [];
      const devices: AudioOutputDevice[] = rawDevices
        .map(asRecord)
        .filter((item): item is Record<string, unknown> => item !== null && typeof item.id === "string")
        .map((item) => {
          const roles = asRecord(item.defaultRoles);
          return {
            id: item.id as string,
            name: typeof item.name === "string" ? item.name : "Audio Output",
            state: typeof item.state === "string" ? item.state : "active",
            isDefault: item.isDefault === true,
            defaultRoles: {
              console: roles?.console === true,
              multimedia: roles?.multimedia === true,
              communications: roles?.communications === true,
            },
          };
        });
      return { status, selectedDeviceId, devices };
    } catch (error) {
      log.warn(`Get audio outputs failed: ${errorMessage(error)}`);
      return { status: "unsupported", devices: [] };
    }
  }

  async selectAudioOutput(deviceId: string, roles?: unknown, options?: { timeoutMs?: number }): Promise<SelectAudioOutputResponse> {
    if (typeof deviceId !== "string" || deviceId.trim().length === 0) {
      return { status: "invalid_device" };
    }
    const validatedRoles = parseAudioOutputRoles(roles === undefined ? {} : { roles });
    if (!validatedRoles) return { status: "invalid_role" };
    try {
      const params: Record<string, unknown> = { deviceId: deviceId.trim(), roles: validatedRoles };
      const callOptions = { timeoutMs: options?.timeoutMs ?? 3000 };
      const response = await this.hostBridge.call<unknown>("audio.outputs.select", params, callOptions);
      const rec = asRecord(response);
      const status = (rec?.status as string) ?? "unsupported";
      const confirmed = typeof rec?.confirmed === "boolean" ? rec.confirmed : undefined;
      const returnedDeviceId = typeof rec?.deviceId === "string" ? rec.deviceId : undefined;
      return { status, deviceId: returnedDeviceId, confirmed };
    } catch (error) {
      log.warn(`Select audio output failed: ${errorMessage(error)}`);
      return { status: "unsupported" };
    }
  }

  async getAudioSessions(deviceId?: string, options?: { timeoutMs?: number }): Promise<AudioSessionsResponse> {
    try {
      const params: Record<string, unknown> = {};
      if (typeof deviceId === "string" && deviceId.trim().length > 0) {
        params.deviceId = deviceId.trim();
      }
      const callOptions = { timeoutMs: options?.timeoutMs ?? 3000 };
      const response = await this.hostBridge.call<unknown>("audio.sessions.list", params, callOptions);
      const rec = asRecord(response);
      if (!rec || rec.status === "unsupported") {
        return { status: "unsupported", sessions: [] };
      }
      const status = (rec.status as string) ?? "ok";
      const rawSessions = Array.isArray(rec.sessions) ? rec.sessions : [];
      const sessions: AudioSession[] = rawSessions
        .map(asRecord)
        .filter((item): item is Record<string, unknown> => item !== null && typeof item.id === "string")
        .map((item) => ({
          id: item.id as string,
          endpointId: typeof item.endpointId === "string" ? item.endpointId : (typeof item.endpoint_id === "string" ? item.endpoint_id : ""),
          appName: typeof item.appName === "string" ? item.appName : "Application",
          processId: typeof item.processId === "number" ? item.processId : 0,
          volumePercent: normalizeVolumePercent(item.volumePercent ?? item.volume_percent) ?? 100,
          muted: item.muted === true,
        }));
      return { status, sessions };
    } catch (error) {
      log.warn(`Get audio sessions failed: ${errorMessage(error)}`);
      return { status: "unsupported", sessions: [] };
    }
  }

  private readonly activeSessionVolumeQueue = new Map<
    string,
    {
      inFlight: boolean;
      inFlightResolver?: (res: SetAudioSessionVolumeResponse) => void;
      pendingTarget?: { volumePercent: number; deviceId?: string };
      pendingResolver?: (res: SetAudioSessionVolumeResponse) => void;
    }
  >();

  async setAudioSessionVolume(
    sessionId: string,
    volumePercent: number,
    options?: { timeoutMs?: number; deviceId?: string },
  ): Promise<SetAudioSessionVolumeResponse> {
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      return { status: "invalid_session" };
    }
    const normalizedPercent = normalizeVolumePercent(volumePercent);
    if (normalizedPercent === null) {
      return { status: "invalid_volume" };
    }

    const key = sessionId.trim();
    let state = this.activeSessionVolumeQueue.get(key);

    if (!state) {
      let resolveFn: ((res: SetAudioSessionVolumeResponse) => void) | undefined;
      const promise = new Promise<SetAudioSessionVolumeResponse>((resolve) => {
        resolveFn = resolve;
      });

      state = {
        inFlight: true,
        inFlightResolver: resolveFn,
      };
      this.activeSessionVolumeQueue.set(key, state);

      this.dispatchSessionVolume(key, normalizedPercent, options?.deviceId, options?.timeoutMs);
      return promise;
    }

    if (!state.inFlight) {
      let resolveFn: ((res: SetAudioSessionVolumeResponse) => void) | undefined;
      const promise = new Promise<SetAudioSessionVolumeResponse>((resolve) => {
        resolveFn = resolve;
      });
      state.inFlight = true;
      state.inFlightResolver = resolveFn;

      this.dispatchSessionVolume(key, normalizedPercent, options?.deviceId, options?.timeoutMs);
      return promise;
    }

    state.pendingTarget = {
      volumePercent: normalizedPercent,
      deviceId: options?.deviceId ?? state.pendingTarget?.deviceId,
    };

    if (state.pendingResolver) {
      const oldResolve = state.pendingResolver;
      const promise = new Promise<SetAudioSessionVolumeResponse>((resolve) => {
        state!.pendingResolver = (res) => {
          oldResolve(res);
          resolve(res);
        };
      });
      return promise;
    }

    let resolveFn: ((res: SetAudioSessionVolumeResponse) => void) | undefined;
    const promise = new Promise<SetAudioSessionVolumeResponse>((resolve) => {
      resolveFn = resolve;
    });
    state.pendingResolver = resolveFn;

    return promise;
  }

  private async dispatchSessionVolume(
    sessionIdKey: string,
    volumePercent: number,
    deviceId?: string,
    timeoutMs?: number,
  ): Promise<void> {
    const state = this.activeSessionVolumeQueue.get(sessionIdKey);
    if (!state) return;

    let result: SetAudioSessionVolumeResponse = { status: "unsupported" };
    try {
      const params: Record<string, unknown> = {
        sessionId: sessionIdKey,
        volumePercent,
      };
      if (typeof deviceId === "string" && deviceId.trim().length > 0) {
        params.deviceId = deviceId.trim();
      }
      const callOptions = { timeoutMs: timeoutMs ?? 3000 };
      const response = await this.hostBridge.call<unknown>(
        "audio.sessions.set_volume",
        params,
        callOptions,
      );
      const rec = asRecord(response);
      const status = (rec?.status as string) ?? "unsupported";
      const confirmedVolumePercent =
        normalizeVolumePercent(
          rec?.confirmedVolumePercent ?? rec?.confirmed_volume_percent,
        ) ?? undefined;
      result = { status, confirmedVolumePercent };
    } catch (error) {
      log.warn(`Set audio session volume failed: ${errorMessage(error)}`);
      result = { status: "unsupported" };
    }

    const currentResolver = state.inFlightResolver;
    state.inFlightResolver = undefined;

    if (currentResolver) {
      currentResolver(result);
    }

    if (state.pendingTarget) {
      const nextTarget = state.pendingTarget;
      state.pendingTarget = undefined;

      state.inFlightResolver = state.pendingResolver;
      state.pendingResolver = undefined;
      state.inFlight = true;

      this.dispatchSessionVolume(
        sessionIdKey,
        nextTarget.volumePercent,
        nextTarget.deviceId,
        timeoutMs,
      );
    } else {
      this.activeSessionVolumeQueue.delete(sessionIdKey);
    }
  }

  async setAudioSessionMute(
    sessionId: string,
    muted: boolean,
    options?: { timeoutMs?: number; deviceId?: string },
  ): Promise<SetAudioSessionMuteResponse> {
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      return { status: "invalid_session" };
    }
    if (typeof muted !== "boolean") {
      return { status: "unsupported" };
    }
    try {
      const params: Record<string, unknown> = { sessionId: sessionId.trim(), muted };
      if (typeof options?.deviceId === "string" && options.deviceId.trim().length > 0) {
        params.deviceId = options.deviceId.trim();
      }
      const callOptions = { timeoutMs: options?.timeoutMs ?? 3000 };
      const response = await this.hostBridge.call<unknown>("audio.sessions.set_mute", params, callOptions);
      const rec = asRecord(response);
      const status = (rec?.status as string) ?? "unsupported";
      const confirmedMuted = typeof rec?.confirmedMuted === "boolean" ? rec.confirmedMuted : undefined;
      return { status, confirmedMuted };
    } catch (error) {
      log.warn(`Set audio session mute failed: ${errorMessage(error)}`);
      return { status: "unsupported" };
    }
  }

  async handleControl(method: string): Promise<HostMediaControlStatus | null> {
    const action = mediaControlAction(method);
    if (!action) return null;
    if (!this.active) return "disabled";

    const response = await this.hostBridge.call<unknown>("media.control", {
      action,
    });
    const status = asRecord(response)?.status;
    return status === "ok" || status === "unsupported" || status === "disabled"
      ? status
      : "unsupported";
  }

  async replayLatest(): Promise<void> {
    if (this.active) {
      const nowPlaying = this.latestNowPlaying;
      if (nowPlaying) {
        await this.sink.sendEvent(
          "media.now_playing.update",
          rebaseNowPlaying(
            nowPlaying,
            this.latestNowPlayingReceivedAtMs,
            this.now(),
          ),
        );
      }

      const artwork = this.latestArtwork;
      if (
        artwork &&
        nowPlaying &&
        artwork.media_generation === nowPlaying.media_generation
      ) {
        await this.sink.sendEvent("media.now_playing.artwork", artwork);
      }
    }

    if (this.volumePercent !== null) {
      await this.sink.sendVolume(this.volumePercent, this.muted ?? undefined);
    }
  }

  async whenIdle(): Promise<void> {
    while (this.pendingDeliveries.size > 0) {
      await Promise.all(this.pendingDeliveries);
    }
  }

  private async applyActivation(): Promise<void> {
    if (!this.lifecycleStarted) return;
    if (this.systemMediaEnabled || this.forcedOn) {
      if (!this.active) await this.activate();
      return;
    }
    await this.deactivate(true, true);
  }

  private async activate(): Promise<void> {
    this.active = true;
    this.unsubscribe.push(
      this.hostBridge.onEvent("media.now_playing.update", (data) => {
        this.handleNowPlaying(data);
      }),
      this.hostBridge.onEvent("media.now_playing.artwork", (data) => {
        this.handleArtwork(data);
      }),
    );

    try {
      await this.hostBridge.call("media.set_spotify_linked", {
        linked: this.spotifyLinked,
      });
      await this.hostBridge.call("media.start", {});
    } catch (error) {
      this.active = false;
      this.removeSubscriptions();
      throw error;
    }

  }

  private async deactivate(
    emitStopped: boolean,
    forceHostStop = false,
  ): Promise<void> {
    const wasActive = this.active;
    if (!wasActive && !forceHostStop) return;
    this.active = false;
    this.removeSubscriptions();

    if (emitStopped && wasActive) {
      await this.emitStoppedForLastMedia();
    }

    try {
      await this.hostBridge.call("media.stop", {});
    } catch (error) {
      log.warn(`Host media stop failed: ${errorMessage(error)}`);
    }
    this.clearMediaCache();
  }

  private async emitStoppedForLastMedia(): Promise<void> {
    const current = this.latestNowPlaying;
    if (!current || current.playback_attributes.PlaybackStatus === "stopped") {
      return;
    }
    const rebased = rebaseNowPlaying(
      current,
      this.latestNowPlayingReceivedAtMs,
      this.now(),
    );
    const stopped: MediaNowPlayingUpdate = {
      media_item_attributes: { ...rebased.media_item_attributes },
      playback_attributes: {
        ...rebased.playback_attributes,
        PlaybackStatus: "stopped",
      },
      media_generation: rebased.media_generation,
    };
    await this.sink.sendEvent("media.now_playing.update", stopped);
  }

  private handleNowPlaying(data: unknown): void {
    if (!this.active) return;
    const update = normalizeNowPlayingUpdate(data);
    if (!update) {
      log.warn("Ignoring malformed host media.now_playing.update event");
      return;
    }

    if (this.spotifyLinked && isSpotifyNowPlaying(update)) {
      if (isSpotifyNowPlaying(this.latestNowPlaying)) this.clearMediaCache();
      return;
    }

    if (
      this.latestNowPlaying?.media_generation !== update.media_generation
    ) {
      this.latestArtwork = null;
      this.latestArtworkSignature = null;
    }

    const signature = JSON.stringify(update);
    this.latestNowPlaying = update;
    this.latestNowPlayingReceivedAtMs = this.now();
    if (signature === this.latestNowPlayingSignature) return;
    this.latestNowPlayingSignature = signature;

    const delivery = this.sink.sendEvent("media.now_playing.update", update);
    this.latestMetadataDelivery = {
      generation: update.media_generation,
      promise: delivery,
    };
    this.trackDelivery(delivery, "now-playing metadata");
  }

  private handleArtwork(data: unknown): void {
    if (!this.active) return;
    const artwork = normalizeArtwork(data);
    if (!artwork) {
      log.warn("Ignoring malformed host media.now_playing.artwork event");
      return;
    }
    if (
      !this.latestNowPlaying ||
      artwork.media_generation !== this.latestNowPlaying.media_generation
    ) {
      return;
    }

    const signature = [
      artwork.media_generation,
      artwork.content_type,
      artwork.data.length,
      artwork.data.slice(-64),
    ].join(":");
    if (signature === this.latestArtworkSignature) return;
    this.latestArtwork = artwork;
    this.latestArtworkSignature = signature;

    const metadataDelivery =
      this.latestMetadataDelivery?.generation === artwork.media_generation
        ? this.latestMetadataDelivery.promise
        : Promise.resolve();
    const delivery = metadataDelivery.then(async () => {
      if (
        this.latestNowPlaying?.media_generation !== artwork.media_generation
      ) {
        return;
      }
      await this.sink.sendEvent("media.now_playing.artwork", artwork);
    });
    this.trackDelivery(delivery, "now-playing artwork");
  }

  private handleVolume(data: unknown): void {
    const rec = asRecord(data);
    if (rec?.status === "unsupported") {
      this.volumeRevision++;
      this.volumeSupported = false;
      return;
    }
    const percent = normalizeVolumePercent(
      rec?.volume_percent ?? rec?.volumePercent,
    );
    const muted = typeof rec?.muted === "boolean" ? rec.muted : undefined;
    if (percent === null) return;
    this.volumeRevision++;
    this.volumeSupported = true;
    if (percent === this.volumePercent && muted === this.muted) return;
    this.volumePercent = percent;
    if (muted !== undefined) {
      this.muted = muted;
    }
    this.trackDelivery(this.sink.sendVolume(percent, muted), "host volume");
  }

  private async refreshVolume(): Promise<void> {
    const revision = this.volumeRevision;
    try {
      const response = await this.hostBridge.call<unknown>("media.get_volume", {});
      const rec = asRecord(response);
      if (rec?.status === "unsupported") {
        return;
      }
      // A newer definitive event or RPC owns the cached state, even if unchanged.
      if (this.lifecycleStarted && this.volumeRevision === revision) {
        this.handleVolume(response);
      }
    } catch {
      // Keep any capability already verified by a newer volume event or RPC.
    }
  }

  private trackDelivery(delivery: Promise<void>, description: string): void {
    let tracked: Promise<void>;
    tracked = delivery
      .catch((error) => {
        log.warn(`${description} delivery failed: ${errorMessage(error)}`);
      })
      .finally(() => {
        this.pendingDeliveries.delete(tracked);
      });
    this.pendingDeliveries.add(tracked);
  }

  private clearMediaCache(): void {
    this.latestNowPlaying = null;
    this.latestNowPlayingReceivedAtMs = null;
    this.latestArtwork = null;
    this.latestNowPlayingSignature = null;
    this.latestArtworkSignature = null;
    this.latestMetadataDelivery = null;
  }

  private removeSubscriptions(): void {
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
  }
}

export function mediaControlAction(method: string): HostMediaControlAction | null {
  switch (method) {
    case "media.control.play":
      return "play";
    case "media.control.pause":
      return "pause";
    case "media.control.stop":
      return "stop";
    case "media.control.playPause":
    case "media.control.toggle":
    case "media.control.togglePlayPause":
      return "toggle";
    case "media.control.next":
      return "next";
    case "media.control.previous":
    case "media.control.prev":
      return "previous";
    case "media.control.shuffle":
      return "shuffle";
    case "media.control.repeat":
      return "repeat";
    case "media.control.volumeUp":
    case "media.control.volume_up":
      return "volume_up";
    case "media.control.volumeDown":
    case "media.control.volume_down":
      return "volume_down";
    case "media.control.like":
      return "like";
    case "media.control.unlike":
      return "unlike";
    default:
      return null;
  }
}

export function normalizeNowPlayingUpdate(
  data: unknown,
): MediaNowPlayingUpdate | null {
  const event = asRecord(data);
  if (!event) return null;
  const generation = normalizeGeneration(
    event.media_generation ?? event.mediaGeneration,
  );
  const mediaSource = asRecord(
    event.media_item_attributes ??
      event.mediaItemAttributes ??
      event.MediaItemAttributes,
  );
  const playbackSource = asRecord(
    event.playback_attributes ??
      event.playbackAttributes ??
      event.PlaybackAttributes,
  );
  if (generation === null || !mediaSource || !playbackSource) return null;

  const media: Record<string, string | number | boolean> = {};
  copyString(mediaSource, media, "MediaItemTitle");
  copyString(mediaSource, media, "MediaItemArtist");
  copyString(mediaSource, media, "MediaItemAlbumName");
  copyPositiveNumber(
    mediaSource,
    media,
    "MediaItemPlaybackDurationInMilliseconds",
  );
  copyBoolean(mediaSource, media, "MediaItemLikeSupported");
  copyBoolean(mediaSource, media, "MediaItemLiked");

  const playback: Record<string, string | number | boolean> = {};
  const status = playbackSource.PlaybackStatus;
  playback.PlaybackStatus = isPlaybackStatus(status) ? status : "unknown";
  copyString(playbackSource, playback, "PlaybackAppName");
  copyEnum(
    playbackSource,
    playback,
    "PlaybackShuffleMode",
    ["off", "albums", "songs"],
  );
  copyEnum(
    playbackSource,
    playback,
    "PlaybackRepeatMode",
    ["off", "one", "all"],
  );
  copyNonNegativeNumber(
    playbackSource,
    playback,
    "PlaybackElapsedTimeInMilliseconds",
  );
  copyPositiveNumber(playbackSource, playback, "PlaybackRate");

  return {
    media_item_attributes: media,
    playback_attributes: playback,
    media_generation: generation,
  };
}

function rebaseNowPlaying(
  update: MediaNowPlayingUpdate,
  receivedAtMs: number | null,
  nowMs: number,
): MediaNowPlayingUpdate {
  if (
    update.playback_attributes.PlaybackStatus !== "playing" ||
    receivedAtMs === null
  ) {
    return update;
  }
  const elapsed = update.playback_attributes
    .PlaybackElapsedTimeInMilliseconds;
  if (typeof elapsed !== "number" || !Number.isFinite(elapsed) || elapsed < 0) {
    return update;
  }
  const rateValue = update.playback_attributes.PlaybackRate;
  const rate = typeof rateValue === "number" &&
      Number.isFinite(rateValue) &&
      rateValue > 0
    ? rateValue
    : 1;
  const ageMs = Math.max(0, nowMs - receivedAtMs);
  let projected = elapsed + ageMs * rate;
  const duration = update.media_item_attributes
    .MediaItemPlaybackDurationInMilliseconds;
  if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
    projected = Math.min(projected, duration);
  }
  return {
    media_item_attributes: { ...update.media_item_attributes },
    playback_attributes: {
      ...update.playback_attributes,
      PlaybackElapsedTimeInMilliseconds: projected,
    },
    media_generation: update.media_generation,
  };
}

function normalizeArtwork(data: unknown): MediaNowPlayingArtwork | null {
  const event = asRecord(data);
  if (!event) return null;
  const generation = normalizeGeneration(
    event.media_generation ?? event.mediaGeneration,
  );
  const bytes = binaryData(event.data);
  const encoded = typeof event.data === "string"
    ? decodeBase64(event.data)
    : bytes;
  if (generation === null || !encoded || encoded.length === 0) return null;
  const contentType =
    stringValue(event.content_type ?? event.contentType) ?? "image/jpeg";
  if (!contentType.startsWith("image/")) return null;
  return {
    data: encoded.toString("base64"),
    content_type: contentType,
    media_generation: generation,
  };
}

function decodeBase64(value: string): Buffer | null {
  try {
    const bytes = Buffer.from(value, "base64");
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

function isSpotifyNowPlaying(update: MediaNowPlayingUpdate | null): boolean {
  const appName = update?.playback_attributes.PlaybackAppName;
  return typeof appName === "string" && appName.trim().toLowerCase() === "spotify";
}

function normalizeGeneration(value: unknown): number | null {
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return value;
  }
  if (
    typeof value === "bigint" &&
    value >= 0n &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(value);
  }
  return null;
}

function normalizeVolumePercent(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 100
    ? value
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function binaryData(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (Array.isArray(value) && value.every(
    (item) => Number.isInteger(item) && item >= 0 && item <= 255,
  )) {
    return Buffer.from(value);
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function copyString(
  source: Record<string, unknown>,
  target: Record<string, string | number | boolean>,
  key: string,
): void {
  const value = stringValue(source[key]);
  if (value !== null) target[key] = value;
}

function copyBoolean(
  source: Record<string, unknown>,
  target: Record<string, string | number | boolean>,
  key: string,
): void {
  const value = source[key];
  if (typeof value === "boolean") target[key] = value;
}

function copyPositiveNumber(
  source: Record<string, unknown>,
  target: Record<string, string | number | boolean>,
  key: string,
): void {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    target[key] = value;
  }
}

function copyNonNegativeNumber(
  source: Record<string, unknown>,
  target: Record<string, string | number | boolean>,
  key: string,
): void {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    target[key] = value;
  }
}

function copyEnum(
  source: Record<string, unknown>,
  target: Record<string, string | number | boolean>,
  key: string,
  allowed: readonly string[],
): void {
  const value = source[key];
  if (typeof value === "string" && allowed.includes(value)) target[key] = value;
}

function isPlaybackStatus(value: unknown): value is string {
  return value === "playing" ||
    value === "paused" ||
    value === "stopped" ||
    value === "loading" ||
    value === "unknown";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
