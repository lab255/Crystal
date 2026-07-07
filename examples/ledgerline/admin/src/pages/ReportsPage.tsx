import { useEffect, useState } from "react";
import type { Money } from "@ledgerline/shared";
import { fetchAging, fetchRevenue } from "../api.js";
import { formatMoney } from "../format.js";

export function ReportsPage() {
  const [exposure, setExposure] = useState<Money | null>(null);
  const [overdueCount, setOverdueCount] = useState(0);
  const [revenue, setRevenue] = useState<Money | null>(null);

  useEffect(() => {
    void fetchAging().then((r) => {
      setExposure(r.exposure);
      setOverdueCount(r.overdueCount);
    });
    void fetchRevenue().then((r) => setRevenue(r.revenue));
  }, []);

  return (
    <section>
      <h1>Reports</h1>
      <dl>
        <dt>Overdue invoices</dt>
        <dd>
          {overdueCount} totalling {exposure ? formatMoney(exposure) : "—"}
        </dd>
        <dt>Revenue (paid)</dt>
        <dd>{revenue ? formatMoney(revenue) : "—"}</dd>
      </dl>
    </section>
  );
}
