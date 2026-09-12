import type { Metadata } from "next";
import { AuditScreen } from "@/components/audit/AuditScreen";

export const metadata: Metadata = { title: "Audit" };

export default function AuditPage() {
  return <AuditScreen />;
}
