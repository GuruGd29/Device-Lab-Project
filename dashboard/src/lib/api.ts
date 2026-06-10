// REST client for the cloud control plane (spec §11). One thin wrapper that injects the bearer
// token, parses JSON, and surfaces typed responses. Endpoints + shapes mirror
// packages/contracts/src/api.ts and cloud/src/routes/*.ts exactly — do not invent fields.
import type {
  ApiError,
  CalibrateResponse,
  Camera,
  CreateBindingResponse,
  GetInstallJobResponse,
  GetTvResponse,
  InstallResponse,
  KeyPressRequest,
  KeyPressResponse,
  ListAppsResponse,
  ListBuildsResponse,
  ListCamerasResponse,
  ListTvsResponse,
  LoginResponse,
  Platform,
  ReservationHeartbeatResponse,
  ReserveResponse,
  TvActionResponse,
} from "@device-lab/contracts";
import type { Build } from "@device-lab/contracts";
import { API_BASE_URL } from "./config.js";

/** Thrown for non-2xx responses we don't model as a typed body (e.g. 401/404/500). */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError | unknown,
  ) {
    const msg =
      body && typeof body === "object" && "message" in body
        ? String((body as ApiError).message)
        : `request failed (${status})`;
    super(msg);
    this.name = "ApiRequestError";
  }
}

let currentToken: string | null = null;

/** Set/clear the bearer token used on every subsequent request. */
export function setApiToken(token: string | null): void {
  currentToken = token;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Use fetch keepalive so the request survives page unload (teardown release). */
  keepalive?: boolean;
}

async function request(path: string, opts: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (currentToken) headers["Authorization"] = `Bearer ${currentToken}`;

  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    keepalive: opts.keepalive ?? false,
  });
  return res;
}

/** Request that throws ApiRequestError on any non-2xx; returns parsed JSON otherwise. */
async function requestJson<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await request(path, opts);
  const json = await safeJson(res);
  if (!res.ok) throw new ApiRequestError(res.status, json);
  return json as T;
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ── Auth ─────────────────────────────────────────────────────────────────────
export function login(username: string, password: string): Promise<LoginResponse> {
  return requestJson<LoginResponse>("/auth/login", {
    method: "POST",
    body: { username, password },
  });
}

// ── Registry / pools ───────────────────────────────────────────────────────
export function listTvs(): Promise<ListTvsResponse> {
  return requestJson<ListTvsResponse>("/tvs");
}
export function getTv(tvId: string): Promise<GetTvResponse> {
  return requestJson<GetTvResponse>(`/tvs/${encodeURIComponent(tvId)}`);
}
export function listCameras(): Promise<ListCamerasResponse> {
  return requestJson<ListCamerasResponse>("/cameras");
}

// ── Binding / calibration ────────────────────────────────────────────────────
// Calibrate returns the final QR-handshake outcome; live progress also arrives over the WS
// as calibration.update frames (cloud/src/ws/dashboardHub.ts).
export function calibrate(tvId: string): Promise<CalibrateResponse> {
  return requestJson<CalibrateResponse>(`/tvs/${encodeURIComponent(tvId)}/calibrate`, {
    method: "POST",
    body: {},
  });
}
export function createBinding(tvId: string, cameraId: string): Promise<CreateBindingResponse> {
  return requestJson<CreateBindingResponse>(`/tvs/${encodeURIComponent(tvId)}/binding`, {
    method: "POST",
    body: { camera_id: cameraId },
  });
}
export function deleteBinding(tvId: string): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(`/tvs/${encodeURIComponent(tvId)}/binding`, {
    method: "DELETE",
  });
}

// ── Reservation (atomic lock, spec §7) ─────────────────────────────────────────
// reserve returns 200 (ReserveSuccess) or 409 (ReserveConflict). Both bodies are modeled, so
// we read the body regardless of status and let the caller branch on `ok`.
export async function reserve(tvId: string): Promise<ReserveResponse> {
  const res = await request(`/tvs/${encodeURIComponent(tvId)}/reserve`, {
    method: "POST",
    body: {},
  });
  const json = (await safeJson(res)) as ReserveResponse | ApiError;
  // 200 and 409 both carry a ReserveResponse with a discriminating `ok` field.
  if (res.status === 200 || res.status === 409) {
    return json as ReserveResponse;
  }
  throw new ApiRequestError(res.status, json);
}

// heartbeat: 200 -> {ok:true,...}; 409 -> {ok:false, reason}. Both modeled; caller exits on !ok.
export async function reservationHeartbeat(
  tvId: string,
  sessionId: string,
): Promise<ReservationHeartbeatResponse> {
  const res = await request(`/tvs/${encodeURIComponent(tvId)}/heartbeat`, {
    method: "POST",
    body: { session_id: sessionId },
  });
  const json = (await safeJson(res)) as ReservationHeartbeatResponse | ApiError;
  if (res.status === 200 || res.status === 409) {
    return json as ReservationHeartbeatResponse;
  }
  throw new ApiRequestError(res.status, json);
}

export function release(tvId: string, sessionId: string): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(`/tvs/${encodeURIComponent(tvId)}/release`, {
    method: "POST",
    body: { session_id: sessionId },
  });
}

// Best-effort release fired during page unload. Uses fetch keepalive (which, unlike sendBeacon,
// still carries our Authorization header so the cloud's requireAuth accepts it).
export function releaseKeepalive(tvId: string, sessionId: string): void {
  void request(`/tvs/${encodeURIComponent(tvId)}/release`, {
    method: "POST",
    body: { session_id: sessionId },
    keepalive: true,
  }).catch(() => {});
}

// Admin-only — break a genuinely stuck lock (spec §10 admin screen).
export function forceRelease(tvId: string): Promise<{ ok: boolean; prior_holder: string | null }> {
  return requestJson<{ ok: boolean; prior_holder: string | null }>(
    `/tvs/${encodeURIComponent(tvId)}/force-release`,
    { method: "POST", body: {} },
  );
}

// ── Runtime ────────────────────────────────────────────────────────────────
// key press: 200 -> {ok:true}; 403 -> {ok:false, reason:"not_holder"}; 400/502 -> other reasons.
// We model all of them so the UI can disable the keypad on a 403.
export async function pressKey(
  tvId: string,
  req: KeyPressRequest,
): Promise<{ status: number; body: KeyPressResponse }> {
  const res = await request(`/tvs/${encodeURIComponent(tvId)}/key`, {
    method: "POST",
    body: req,
  });
  const json = (await safeJson(res)) as KeyPressResponse;
  return { status: res.status, body: json };
}

// ── Build library + on-device app management ───────────────────────────────────
// Mirrors cloud/src/routes/builds.ts + tvActions.ts. Uploads are multipart; everything that
// touches the TV control session (install / launch / list / uninstall / power) requires the
// caller to be the current LOCK HOLDER and so carries the reservation session_id.

export interface UploadProgress {
  loaded: number;
  total: number;
  /** 0..1, or null when the total length is unknown. */
  fraction: number | null;
}

/**
 * POST /builds (multipart form-data: file=<apk|wgt|ipk>, optional app_id). Uses XMLHttpRequest
 * so we can surface upload progress; resolves with the recorded Build. Throws ApiRequestError
 * on a non-2xx (e.g. bad_package / too_large).
 */
export function uploadBuild(
  file: File,
  appId?: string | null,
  onProgress?: (p: UploadProgress) => void,
): Promise<Build> {
  return new Promise<Build>((resolve, reject) => {
    const form = new FormData();
    form.append("file", file, file.name);
    if (appId) form.append("app_id", appId);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE_URL}/builds`);
    if (currentToken) xhr.setRequestHeader("Authorization", `Bearer ${currentToken}`);
    // NOTE: do NOT set Content-Type — the browser sets the multipart boundary itself.

    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = (ev) => {
        onProgress({
          loaded: ev.loaded,
          total: ev.total,
          fraction: ev.lengthComputable && ev.total > 0 ? ev.loaded / ev.total : null,
        });
      };
    }

    xhr.onload = () => {
      let body: unknown = undefined;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
      } catch {
        body = xhr.responseText;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve((body as { build: Build }).build);
      } else {
        reject(new ApiRequestError(xhr.status, body));
      }
    };
    xhr.onerror = () => reject(new ApiRequestError(0, { error: "network", message: "upload failed" }));
    xhr.onabort = () => reject(new ApiRequestError(0, { error: "aborted", message: "upload aborted" }));
    xhr.send(form);
  });
}

export function listBuilds(platform?: Platform): Promise<ListBuildsResponse> {
  const q = platform ? `?platform=${encodeURIComponent(platform)}` : "";
  return requestJson<ListBuildsResponse>(`/builds${q}`);
}

export function deleteBuild(buildId: string): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(`/builds/${encodeURIComponent(buildId)}`, {
    method: "DELETE",
  });
}

/**
 * POST /tvs/:id/install {session_id, build_id}. 200 => {job_id, status}; otherwise the cloud
 * returns a TvActionResponse error body (403 not_holder, 404 no_such_build, 400 unsupported,
 * 502 tv_unreachable). We read the body regardless of status and branch on its shape so the UI
 * can show a precise reason instead of a generic failure.
 */
export async function install(
  tvId: string,
  sessionId: string,
  buildId: string,
): Promise<
  | { ok: true; job: InstallResponse }
  | { ok: false; status: number; reason: TvActionResponse["reason"]; message: string }
> {
  const res = await request(`/tvs/${encodeURIComponent(tvId)}/install`, {
    method: "POST",
    body: { session_id: sessionId, build_id: buildId },
  });
  const json = (await safeJson(res)) as
    | InstallResponse
    | (TvActionResponse & { message?: string })
    | ApiError;
  if (res.ok && json && typeof json === "object" && "job_id" in json) {
    return { ok: true, job: json as InstallResponse };
  }
  const j = (json ?? {}) as TvActionResponse & ApiError;
  return {
    ok: false,
    status: res.status,
    reason: j.reason,
    message: j.message ?? actionReasonText(j.reason) ?? `install failed (${res.status})`,
  };
}

export function getInstallJob(jobId: string): Promise<GetInstallJobResponse> {
  return requestJson<GetInstallJobResponse>(`/install-jobs/${encodeURIComponent(jobId)}`);
}

/**
 * POST /tvs/:id/list-apps {session_id} -> AppInfo[]. 403/502 carry an ApiError body
 * (not_holder / tv_unreachable); we surface those as a thrown ApiRequestError.
 */
export async function listApps(tvId: string, sessionId: string): Promise<ListAppsResponse> {
  return requestJson<ListAppsResponse>(`/tvs/${encodeURIComponent(tvId)}/list-apps`, {
    method: "POST",
    body: { session_id: sessionId },
  });
}

/** Shared caller for launch / uninstall / power — all return TvActionResponse on 200 and on error. */
async function tvAction(path: string, body: unknown): Promise<TvActionResponse> {
  const res = await request(path, { method: "POST", body });
  const json = (await safeJson(res)) as TvActionResponse | undefined;
  if (json && typeof json === "object" && "ok" in json) return json;
  // Non-modeled error (e.g. 400 bad_request / 500). Map to a uniform shape.
  return { ok: false, reason: res.status === 403 ? "not_holder" : "tv_unreachable" };
}

export function launchApp(tvId: string, sessionId: string, appId: string): Promise<TvActionResponse> {
  return tvAction(`/tvs/${encodeURIComponent(tvId)}/launch-app`, {
    session_id: sessionId,
    app_id: appId,
  });
}

export function uninstallApp(
  tvId: string,
  sessionId: string,
  appId: string,
): Promise<TvActionResponse> {
  return tvAction(`/tvs/${encodeURIComponent(tvId)}/uninstall-app`, {
    session_id: sessionId,
    app_id: appId,
  });
}

export function power(tvId: string, sessionId: string, on: boolean): Promise<TvActionResponse> {
  return tvAction(`/tvs/${encodeURIComponent(tvId)}/power`, { session_id: sessionId, on });
}

/** Human text for a TvActionResponse.reason — used when the cloud doesn't send a message. */
export function actionReasonText(reason: TvActionResponse["reason"]): string | null {
  switch (reason) {
    case "not_holder":
      return "You no longer hold this TV — the action was rejected.";
    case "tv_unreachable":
      return "TV unreachable (lab agent offline or timed out).";
    case "unsupported":
      return "This operation isn't supported on this TV / platform.";
    case "no_such_build":
      return "That build no longer exists.";
    default:
      return null;
  }
}

export type { Camera, Build };
