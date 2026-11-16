"use client";

import { useQuery } from "@tanstack/react-query";
import type { CapacityView } from "@/lib/capacity";
import { fetchWithin, READ_LIMIT_MS } from "@/lib/fetch-within";

/**
 * The lengths and sizes runs on this install's GPUs are made at now (GET /api/capacity), for a viewer whose runs go
 * there (`on`). Undefined until read, when off, or when the read fails: then every option stays offered.
 */
export function useCapacity(on: boolean): CapacityView | undefined {
  return useQuery({
    queryKey: ["capacity"],
    queryFn: async () => {
      const res = await fetchWithin("/api/capacity", READ_LIMIT_MS.status);
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as CapacityView;
    },
    enabled: on,
    staleTime: 10_000,
    refetchInterval: on ? 30_000 : false,
    retry: 1,
  }).data;
}
