import { useEffect, useState } from "react";
import type { AvailabilityOption } from "@harborview/core";
import { apiClient } from "../api/client";
import { useDebounce } from "./useDebounce";

export interface AvailabilityParams {
  routeId: string;
  date: string;
  passengers: number;
  fareClass: string;
}

export function useAvailability(params: AvailabilityParams) {
  const [options, setOptions] = useState<AvailabilityOption[]>([]);
  const [loading, setLoading] = useState(false);
  const debouncedDate = useDebounce(params.date, 300);

  useEffect(() => {
    let active = true;
    setLoading(true);
    apiClient
      .searchAvailability({
        routeId: params.routeId,
        date: debouncedDate,
        passengers: String(params.passengers),
        fareClass: params.fareClass,
      })
      .then((res) => {
        if (active) setOptions(res.options);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [params.routeId, debouncedDate, params.passengers, params.fareClass]);

  return { options, loading };
}
