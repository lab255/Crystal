import { useState } from "react";
import { useAvailability } from "../hooks/useAvailability";
import { VesselCard } from "../components/VesselCard";
import { Header } from "../components/Header";

export function AvailabilityPage() {
  const [date, setDate] = useState("2026-08-01");
  const [selected, setSelected] = useState<string | null>(null);
  const { options, loading } = useAvailability({
    routeId: "route_bay",
    date,
    passengers: 2,
    fareClass: "economy",
  });

  return (
    <div className="availability">
      <Header title="Find a sailing" />
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      {loading && <p>Searching…</p>}
      <div className="results">
        {options.map((option) => (
          <VesselCard key={option.sailing.id} option={option} onSelect={setSelected} />
        ))}
      </div>
      {selected && <p>Selected sailing {selected}</p>}
    </div>
  );
}
