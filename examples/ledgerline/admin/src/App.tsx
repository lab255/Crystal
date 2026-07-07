import { useState } from "react";
import { CustomersPage } from "./pages/CustomersPage.js";
import { InvoicesPage } from "./pages/InvoicesPage.js";
import { ReportsPage } from "./pages/ReportsPage.js";

type Page = "invoices" | "customers" | "reports";

export function App() {
  const [page, setPage] = useState<Page>("invoices");
  return (
    <div className="app">
      <nav>
        <button onClick={() => setPage("invoices")}>Invoices</button>
        <button onClick={() => setPage("customers")}>Customers</button>
        <button onClick={() => setPage("reports")}>Reports</button>
      </nav>
      {page === "invoices" ? <InvoicesPage /> : page === "customers" ? <CustomersPage /> : <ReportsPage />}
    </div>
  );
}
