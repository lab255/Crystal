import { useState } from "react";
import { HomePage } from "./pages/HomePage";
import { AvailabilityPage } from "./pages/AvailabilityPage";
import { BookingPage } from "./pages/BookingPage";

type View = "home" | "search" | "booking";

export function App() {
  const [view] = useState<View>("home");

  if (view === "search") {
    return <AvailabilityPage />;
  }
  if (view === "booking") {
    return <BookingPage sailingId="sail_1" baseFareCents={4500} departAt="2026-08-01T08:00:00Z" />;
  }
  return <HomePage />;
}
