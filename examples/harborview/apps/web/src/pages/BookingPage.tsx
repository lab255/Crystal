import { Header } from "../components/Header";
import { BookingForm } from "../components/BookingForm";

export interface BookingPageProps {
  sailingId: string;
  baseFareCents: number;
  departAt: string;
}

export function BookingPage({ sailingId, baseFareCents, departAt }: BookingPageProps) {
  return (
    <div className="booking">
      <Header title="Complete your booking" />
      <BookingForm sailingId={sailingId} baseFareCents={baseFareCents} departAt={departAt} />
    </div>
  );
}
