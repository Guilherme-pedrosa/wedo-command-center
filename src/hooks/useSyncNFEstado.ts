import { useEffect, useSyncExternalStore } from "react";
import { subscribeSyncNF, getSyncNFEstado, SyncNFEstado } from "@/lib/syncNFPeriodoManager";

export function useSyncNFEstado(): SyncNFEstado {
  return useSyncExternalStore(
    (cb) => subscribeSyncNF(cb),
    () => getSyncNFEstado(),
    () => getSyncNFEstado(),
  );
}
