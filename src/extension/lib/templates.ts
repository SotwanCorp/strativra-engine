/** Guided step templates, bundled as JSON (no remote config). */
import lead from "../templates/lead.json" with { type: "json" };
import ecommerce from "../templates/ecommerce.json" with { type: "json" };
import type { Template } from "./record.ts";

export const TEMPLATES: Record<Template["id"], Template> = {
  lead: lead as Template,
  ecommerce: ecommerce as Template,
};

export function getTemplate(id: string | undefined | null): Template | undefined {
  return id === "lead" || id === "ecommerce" ? TEMPLATES[id] : undefined;
}
