import { useEffect, useState } from "react";
import { fetchCustomers, type CustomerRow } from "../api.js";

export function CustomersPage() {
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  useEffect(() => {
    void fetchCustomers().then(setCustomers);
  }, []);
  return (
    <section>
      <h1>Customers</h1>
      <ul>
        {customers.map((c) => (
          <li key={c.id}>
            {c.name} <code>{c.slug}</code> — {c.email}
          </li>
        ))}
      </ul>
    </section>
  );
}
