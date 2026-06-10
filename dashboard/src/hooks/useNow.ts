// A clock hook that re-renders on an interval so lease countdowns / "~Nm left" labels stay
// live without polling the server. Default 1s for the device-view countdown; cards use 15s.
import { useEffect, useState } from "react";

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
