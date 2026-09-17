// Renders an email template by replacing {{placeholder}} tokens with
// actual values. Used by create-visit.js and extend-visit.js before
// sending via Resend.
//
// Unknown placeholders are left as-is (not removed) so a typo is visible
// rather than silently swallowed. The doorCode line is stripped entirely
// when no door code is present — the caller should pass doorCode as null
// or undefined to trigger this.

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

export function renderTemplate(template, vars) {
  let subject = template.subject || "";
  let body = template.body || "";

  // Replace all {{placeholder}} tokens with escaped values
  const replace = (text) => {
    return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      if (key in vars && vars[key] !== null && vars[key] !== undefined) {
        return escapeHtml(vars[key]);
      }
      // Leave unknown or empty placeholders as-is
      return match;
    });
  };

  subject = replace(subject);
  body = replace(body);

  // If doorCode is empty/null, remove any line that still contains {{doorCode}}
  if (!vars.doorCode) {
    body = body.replace(/<p>[^<]*\{\{doorCode\}\}[^<]*<\/p>/g, "");
  }

  return { subject, html: body };
}

// Fetch a template from Directus by ID, or the default for a given type
// if no ID is provided. Returns the template object or null.
export async function getTemplate(templateId, templateType, directusToken) {
  const DIRECTUS = "https://cms.goddijn.net";
  const headers = { Authorization: `Bearer ${directusToken}` };

  if (templateId) {
    const res = await fetch(
      `${DIRECTUS}/items/gd_email_templates/${encodeURIComponent(templateId)}?fields=id,name,template_type,subject,body`,
      { headers }
    );
    if (!res.ok) return null;
    const { data } = await res.json();
    return data;
  }

  // Fall back to the default for this template type
  const res = await fetch(
    `${DIRECTUS}/items/gd_email_templates?filter[template_type][_eq]=${encodeURIComponent(templateType)}&filter[is_default][_eq]=true&fields=id,name,template_type,subject,body&limit=1`,
    { headers }
  );
  if (!res.ok) return null;
  const { data } = await res.json();
  return data?.[0] || null;
}
