import { NextRequest, NextResponse } from "next/server";
import {
  DOMAIN_MIGRATION_PATH,
  LEGACY_HOST,
  SITE_ORIGIN,
} from "./app/lib/site-url";

export function proxy(request: NextRequest) {
  const { hostname, pathname } = request.nextUrl;
  const isMigrationRoute =
    pathname === DOMAIN_MIGRATION_PATH ||
    pathname.startsWith(`${DOMAIN_MIGRATION_PATH}/`);

  if (hostname !== LEGACY_HOST || isMigrationRoute) {
    return NextResponse.next();
  }

  const destination = new URL(
    `${request.nextUrl.pathname}${request.nextUrl.search}`,
    SITE_ORIGIN
  );

  return NextResponse.redirect(destination, 301);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
