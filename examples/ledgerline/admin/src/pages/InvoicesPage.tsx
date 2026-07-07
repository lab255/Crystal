import { InvoiceTable } from "../components/InvoiceTable.js";
import { useInvoices } from "../hooks/useInvoices.js";

export function InvoicesPage() {
  const { invoices, loading, error } = useInvoices();
  if (loading) return <p>Loading invoices…</p>;
  if (error) return <p className="error">{error}</p>;
  return (
    <section>
      <h1>Invoices</h1>
      <InvoiceTable invoices={invoices} />
    </section>
  );
}
