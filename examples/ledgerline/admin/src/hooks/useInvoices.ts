import { useEffect, useState } from "react";
import { fetchInvoices, type InvoiceRow } from "../api.js";

export function useInvoices(): { invoices: InvoiceRow[]; loading: boolean; error: string | null } {
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchInvoices()
      .then((rows) => {
        if (!cancelled) setInvoices(rows);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { invoices, loading, error };
}
