export type Money = { readonly amountCents: number; readonly currency: string };

export interface Vessel {
  id: string;
  name: string;
  capacity: number;
  homePort: string;
}

export interface Route {
  id: string;
  origin: string;
  destination: string;
  durationMinutes: number;
  vesselId: string;
}

export interface Sailing {
  id: string;
  routeId: string;
  departAt: string;
  seatsAvailable: number;
  baseFareCents: number;
}

export type FareClass = "economy" | "premium" | "vehicle";

export interface Passenger {
  fullName: string;
  email: string;
  fareClass: FareClass;
}

export interface QuoteRequest {
  sailingId: string;
  baseFareCents: number;
  passengers: Passenger[];
  departAt: string;
  promoCode?: string;
}

export interface FareLine {
  label: string;
  amountCents: number;
}

export interface FareQuote {
  currency: string;
  lines: FareLine[];
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
}

export type BookingStatus = "pending" | "confirmed" | "cancelled";

export interface Booking {
  id: string;
  sailingId: string;
  status: BookingStatus;
  passengers: Passenger[];
  quote: FareQuote;
  createdAt: string;
  contactEmail: string;
}

export interface CancellationResult {
  bookingId: string;
  refundCents: number;
  penaltyCents: number;
  status: BookingStatus;
}
