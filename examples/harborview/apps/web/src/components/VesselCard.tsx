import type { AvailabilityOption } from "@harborview/core";
import { formatCurrency } from "../format";

export interface VesselCardProps {
  option: AvailabilityOption;
  onSelect: (sailingId: string) => void;
}

export function VesselCard({ option, onSelect }: VesselCardProps) {
  const { sailing, soldOut, seatsLeft } = option;
  return (
    <div className="vessel-card">
      <h3>Sailing {sailing.id}</h3>
      <p>Departs {new Date(sailing.departAt).toLocaleString()}</p>
      <p>{seatsLeft} seats left</p>
      <p>{formatCurrency(sailing.baseFareCents, "USD")}</p>
      <button disabled={soldOut} onClick={() => onSelect(sailing.id)}>
        {soldOut ? "Sold out" : "Select"}
      </button>
    </div>
  );
}
