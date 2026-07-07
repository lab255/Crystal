import type { InvoiceRow } from "../api.js";
import { formatMoney } from "../format.js";
import { StatusPill } from "./StatusPill.js";

export function InvoiceTable({ invoices }: { invoices: InvoiceRow[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Number</th>
          <th>Status</th>
          <th>Total</th>
          <th>Due</th>
        </tr>
      </thead>
      <tbody>
        {invoices.map((invoice) => (
          <tr key={invoice.id}>
            <td>{invoice.number}</td>
            <td>
              <StatusPill status={invoice.status} />
            </td>
            <td>{formatMoney(invoice.total)}</td>
            <td>{invoice.dueAt.slice(0, 10)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
