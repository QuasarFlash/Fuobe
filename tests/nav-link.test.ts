import { describe, expect, it } from "vitest";
import { cleanNavLink, cleanZone, NAV_LINK_MAX, zoneOf } from "@/lib/nav-link";

describe("the service's link for the bar", () => {
  it("keeps short words and a same-site path", () => {
    expect(cleanNavLink({ label: "  Go\n Unlimited ", url: "/pricing?from=nav" })).toEqual({ label: "Go Unlimited", url: "/pricing?from=nav" });
  });

  it("drops anything else", () => {
    for (const bad of [null, "x", { label: "Go" }, { url: "/p" }, { label: "", url: "/p" }, { label: "x".repeat(NAV_LINK_MAX + 1), url: "/p" },
      { label: "Go", url: "https://example.com/p" }, { label: "Go", url: "//example.com" }, { label: "Go", url: "/\\example.com" }, { label: 3, url: "/p" }]) {
      expect(cleanNavLink(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("the browser's time zone", () => {
  it("takes IANA names only", () => {
    for (const z of ["Asia/Kolkata", "America/Argentina/Buenos_Aires", "UTC", "Etc/GMT+5", "America/Port-au-Prince"]) expect(cleanZone(z), z).toBe(z);
    for (const z of [null, "", "../etc", "Asia/Kolkata;x", "A/B/C/D", "<script>", "x".repeat(65), "/Asia"]) expect(cleanZone(z), String(z)).toBeNull();
  });

  it("reads it from a Cookie header", () => {
    expect(zoneOf("a=1; fuobe_tz=Asia%2FKolkata; b=2")).toBe("Asia/Kolkata");
    expect(zoneOf("fuobe_tz=Europe/London")).toBe("Europe/London");
    expect(zoneOf("fuobe_tz=%E0%A4")).toBeNull();
    expect(zoneOf("fuobe_tz=..%2Fx")).toBeNull();
    expect(zoneOf("xfuobe_tz=Asia%2FKolkata")).toBeNull();
    expect(zoneOf(null)).toBeNull();
  });
});
