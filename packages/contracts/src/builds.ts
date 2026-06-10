// Build artifacts + on-device app management. A tester uploads a platform build (Android APK /
// Tizen .wgt / webOS .ipk) into the shared library, then installs it onto a TV they hold; the
// lab agent downloads it from the cloud and runs the per-platform installer (adb / tizen-sdb /
// ares-install). App launch / list / uninstall round out the "other TV options".

import type { Platform } from "./domain.js";

export type PackageKind = "apk" | "wgt" | "ipk";

/** Which package format each TV platform installs. */
export const PLATFORM_TO_PACKAGE: Record<Platform, PackageKind> = {
  androidtv: "apk",
  tizen: "wgt",
  webos: "ipk",
};

export const PACKAGE_TO_PLATFORM: Record<PackageKind, Platform> = {
  apk: "androidtv",
  wgt: "tizen",
  ipk: "webos",
};

/** An uploaded build in the shared library (not yet tied to any TV). */
export interface Build {
  build_id: string;
  filename: string;
  platform: Platform; // which TV family this build targets
  package_kind: PackageKind;
  size_bytes: number;
  app_id: string | null; // package/app id, used to launch after install (best-effort)
  uploaded_by: string | null;
  created_at: string;
}

export type InstallStatus =
  | "queued" // accepted, waiting on the agent
  | "downloading" // agent is pulling the build from the cloud
  | "installing" // running the per-platform installer on the TV
  | "installed" // success
  | "failed"; // see message

export interface InstallJob {
  job_id: string;
  tv_id: string;
  build_id: string;
  status: InstallStatus;
  progress: number; // 0..1
  message: string | null;
  requested_by: string;
  created_at: string;
  updated_at: string;
}

/** An app reported as installed on a TV. */
export interface AppInfo {
  app_id: string;
  name: string | null;
  version: string | null;
  running?: boolean;
}
