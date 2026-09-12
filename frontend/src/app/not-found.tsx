import Link from "next/link";
import { PageBody, PageHeader } from "@/components/PageHeader";
import { button } from "@/components/ui";

export default function NotFound() {
  return (
    <PageBody>
      <PageHeader title="Page not found" description="There is nothing at this address in the Imperium app." />
      <Link href="/" className={button("primary", "md", "mt-6")}>
        Go to Command
      </Link>
    </PageBody>
  );
}
