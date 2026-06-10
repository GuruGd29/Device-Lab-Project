import { describe, it, expect } from "vitest";
import { computeTvStatus, type StatusInputs } from "../src/services/stateMachine.js";

const NOW = 1_000_000_000_000;
const TIMEOUT = 30_000;

function inputs(over: Partial<StatusInputs>): StatusInputs {
  return {
    tvLastHeartbeatMs: NOW - 1000,
    agentReported: "free",
    hasBinding: true,
    cameraStatus: "online",
    cameraLastHeartbeatMs: NOW - 1000,
    hasActiveReservation: false,
    nowMs: NOW,
    heartbeatTimeoutMs: TIMEOUT,
    ...over,
  };
}

describe("computeTvStatus (spec §8/§9)", () => {
  it("healthy bound camera, nobody holding -> free", () => {
    expect(computeTvStatus(inputs({}))).toBe("free");
  });

  it("healthy + active reservation -> in_use", () => {
    expect(computeTvStatus(inputs({ hasActiveReservation: true }))).toBe("in_use");
  });

  it("TV heartbeat stale -> offline (even with a healthy camera)", () => {
    expect(
      computeTvStatus(inputs({ tvLastHeartbeatMs: NOW - TIMEOUT - 1 })),
    ).toBe("offline");
  });

  it("agent reports offline -> offline", () => {
    expect(computeTvStatus(inputs({ agentReported: "offline" }))).toBe("offline");
  });

  it("no binding -> no_camera (controllable but blind)", () => {
    expect(
      computeTvStatus(inputs({ hasBinding: false, cameraStatus: null, cameraLastHeartbeatMs: null })),
    ).toBe("no_camera");
  });

  it("bound but camera stopped publishing -> unhealthy, NOT free", () => {
    expect(computeTvStatus(inputs({ cameraStatus: "unhealthy" }))).toBe("unhealthy");
    expect(computeTvStatus(inputs({ cameraStatus: "offline" }))).toBe("unhealthy");
  });

  it("bound but camera heartbeat stale -> unhealthy", () => {
    expect(
      computeTvStatus(inputs({ cameraLastHeartbeatMs: NOW - TIMEOUT - 1 })),
    ).toBe("unhealthy");
  });

  it("offline ranks above in_use (held TV that drops shows offline)", () => {
    expect(
      computeTvStatus(
        inputs({ tvLastHeartbeatMs: NOW - TIMEOUT - 1, hasActiveReservation: true }),
      ),
    ).toBe("offline");
  });

  it("provisioning is respected over everything", () => {
    expect(
      computeTvStatus(inputs({ agentReported: "provisioning", hasBinding: false })),
    ).toBe("provisioning");
  });
});
