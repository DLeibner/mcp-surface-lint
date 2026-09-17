import Link from "next/link";
import type { Crumb } from "@/lib/directory/schema-org";

/** Mirrors the BreadcrumbList JSON-LD exactly; the two are built from one array. */
export function Breadcrumb({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      <ol>
        {crumbs.map((crumb, i) => (
          <li key={`${crumb.name}-${i}`}>
            {crumb.path ? (
              <Link href={crumb.path}>{crumb.name}</Link>
            ) : (
              <span aria-current="page">{crumb.name}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
