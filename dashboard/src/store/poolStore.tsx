// Live in-memory store fed exclusively by CloudToDashboard pushes (spec §8: presence is
// push-only, the dashboard never polls). A reducer applies pools.snapshot / tv.updated /
// camera.updated / reservation.updated and exposes the current TvView[] + Camera[] to the UI.
//
// calibration.update, signal.answer/candidate and error frames are NOT stored here — they are
// transient and consumed directly by the Assign/Calibrate flow and the WebRTC device view via
// the shared socket's onMessage subscription.
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";
import type {
  Camera,
  CloudToDashboard,
  TvView,
} from "@device-lab/contracts";
import { dashboardSocket } from "../lib/ws.js";

interface PoolState {
  tvs: TvView[];
  cameras: Camera[];
  /** True once the first pools.snapshot has arrived. */
  loaded: boolean;
  /** Live socket connectivity, for the header badge. */
  connected: boolean;
}

type PoolAction =
  | { type: "snapshot"; tvs: TvView[]; cameras: Camera[] }
  | { type: "tv"; tv: TvView }
  | { type: "camera"; camera: Camera }
  | {
      type: "reservation";
      tv_id: string;
      reservation:
        | { held_by: string; lock_expires_at: string; hard_expires_at: string }
        | null;
    }
  | { type: "connected"; connected: boolean };

function reducer(state: PoolState, action: PoolAction): PoolState {
  switch (action.type) {
    case "snapshot":
      return { ...state, tvs: action.tvs, cameras: action.cameras, loaded: true };

    case "tv": {
      const tvs = upsert(state.tvs, action.tv, (t) => t.tv_id === action.tv.tv_id);
      return { ...state, tvs };
    }

    case "camera": {
      const cameras = upsert(
        state.cameras,
        action.camera,
        (c) => c.camera_id === action.camera.camera_id,
      );
      // A camera health change can flip a bound TV's testability; mirror camera_status into the
      // denormalized binding view so the Test gate recomputes correctly without waiting for a
      // separate tv.updated.
      const tvs = state.tvs.map((tv) =>
        tv.binding && tv.binding.camera_id === action.camera.camera_id
          ? { ...tv, binding: { ...tv.binding, camera_status: action.camera.status } }
          : tv,
      );
      return { ...state, cameras, tvs };
    }

    case "reservation": {
      // The reservation.updated frame carries a subset (no session_id). Merge it into the TV's
      // denormalized reservation, preserving any session_id we already knew for our own hold.
      const tvs = state.tvs.map((tv) => {
        if (tv.tv_id !== action.tv_id) return tv;
        if (action.reservation === null) {
          return { ...tv, reservation: null };
        }
        return {
          ...tv,
          reservation: {
            held_by: action.reservation.held_by,
            // Keep a prior session_id if the holder is unchanged (e.g. our own renew); else "".
            session_id:
              tv.reservation && tv.reservation.held_by === action.reservation.held_by
                ? tv.reservation.session_id
                : "",
            lock_expires_at: action.reservation.lock_expires_at,
            hard_expires_at: action.reservation.hard_expires_at,
          },
        };
      });
      return { ...state, tvs };
    }

    case "connected":
      return { ...state, connected: action.connected };

    default:
      return state;
  }
}

function upsert<T>(list: T[], item: T, match: (x: T) => boolean): T[] {
  const idx = list.findIndex(match);
  if (idx === -1) return [...list, item];
  const next = list.slice();
  next[idx] = item;
  return next;
}

interface PoolContextValue {
  state: PoolState;
}

const PoolContext = createContext<PoolContextValue | null>(null);

export function PoolStoreProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(reducer, {
    tvs: [],
    cameras: [],
    loaded: false,
    connected: false,
  });

  useEffect(() => {
    const offMsg = dashboardSocket.onMessage((msg: CloudToDashboard) => {
      switch (msg.type) {
        case "pools.snapshot":
          // Wire shape is unknown[]; the cloud sends real TvView/Camera JSON (dashboardHub.ts).
          dispatch({
            type: "snapshot",
            tvs: msg.tvs as TvView[],
            cameras: msg.cameras as Camera[],
          });
          break;
        case "tv.updated":
          dispatch({ type: "tv", tv: msg.tv as TvView });
          break;
        case "camera.updated":
          dispatch({ type: "camera", camera: msg.camera as Camera });
          break;
        case "reservation.updated":
          dispatch({
            type: "reservation",
            tv_id: msg.tv_id,
            reservation: msg.reservation,
          });
          break;
        // calibration.update / signal.* / error are handled by feature components, not the store.
        default:
          break;
      }
    });

    const offStatus = dashboardSocket.onStatus((connected) =>
      dispatch({ type: "connected", connected }),
    );

    return () => {
      offMsg();
      offStatus();
    };
  }, []);

  const value = useMemo<PoolContextValue>(() => ({ state }), [state]);
  return <PoolContext.Provider value={value}>{children}</PoolContext.Provider>;
}

export function usePools(): PoolState {
  const ctx = useContext(PoolContext);
  if (!ctx) throw new Error("usePools must be used within PoolStoreProvider");
  return ctx.state;
}
