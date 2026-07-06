import type { Booking, AvailabilityOption } from "@harborview/core";

export interface ApiClientConfig {
  baseUrl: string;
}

export interface CreateBookingBody {
  sailingId: string;
  baseFareCents: number;
  departAt: string;
  contactEmail: string;
  promoCode?: string;
  passengers: { fullName: string; email: string; fareClass: string }[];
}

export class ApiClient {
  constructor(private config: ApiClientConfig) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(this.config.baseUrl + path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!response.ok) {
      throw new Error("request failed: " + response.status);
    }
    return (await response.json()) as T;
  }

  async createBooking(body: CreateBookingBody): Promise<Booking> {
    return this.request<Booking>("/api/bookings", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async searchAvailability(params: Record<string, string>): Promise<{ options: AvailabilityOption[] }> {
    const qs = new URLSearchParams(params).toString();
    return this.request<{ options: AvailabilityOption[] }>("/api/availability?" + qs);
  }
}

export const apiClient = new ApiClient({
  baseUrl: import.meta.env?.VITE_API_URL ?? "",
});
