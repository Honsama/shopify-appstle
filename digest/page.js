/*
 * Shelf Digest — the one-card Honsama page every public digest route answers
 * with (/api/digest/unsubscribe, /api/digest/add, /api/digest/add-undo).
 * Those routes are NOT behind Shopify's App Proxy, so whatever they send is
 * exactly what the reader sees: every outcome, failures included, is one of
 * these pages, never a blank or a raw 5xx.
 *
 * digestPage(title, line, button, opts)
 *   title, line   HTML (callers escape anything that came from outside)
 *   button        { href, label } — a plain link button, or null
 *   opts.image    cover URL shown above the title
 *   opts.form     { action, label } — a POST button (the only way a digest
 *                 page ever writes; GETs never do)
 *   opts.links    [{ href, label } | { form: action, label }] — small links
 *                 under the card; a `form` entry is a POST styled as a link
 */
function escapeHtml(v) {
  return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const BTN = "display:inline-block;margin-top:18px;background:#821e1d;color:#fff;font-weight:bold;text-decoration:none;padding:12px 28px;border-radius:10px;font-size:14px;";

function digestPage(title, line, button, opts) {
  opts = opts || {};
  const image = opts.image
    ? "<img src=\"" + escapeHtml(opts.image) + "\" width=\"120\" alt=\"\" style=\"display:block;width:120px;margin:0 auto 16px;border-radius:8px;\">"
    : "";
  const form = opts.form
    ? "<form method=\"post\" action=\"" + escapeHtml(opts.form.action) + "\" style=\"margin:0;\">" +
      "<button type=\"submit\" style=\"" + BTN + "border:0;cursor:pointer;font-family:inherit;\">" + opts.form.label + "</button></form>"
    : "";
  const links = (opts.links || []).map((l) => l.form
    ? "<form method=\"post\" action=\"" + escapeHtml(l.form) + "\" style=\"display:inline;margin:0;\">" +
      "<button type=\"submit\" style=\"background:none;border:0;padding:0;color:#821e1d;text-decoration:underline;font-size:13px;cursor:pointer;font-family:inherit;\">" + l.label + "</button></form>"
    : "<a href=\"" + escapeHtml(l.href) + "\" style=\"color:#821e1d;font-size:13px;\">" + l.label + "</a>").join("<span style=\"color:#c9b49a;\">&nbsp;&nbsp;·&nbsp;&nbsp;</span>");
  return "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"robots\" content=\"noindex\"><title>" + title + " · Honsama</title></head>" +
    "<body style=\"margin:0;background:#fdf2e2;font-family:Arial,Helvetica,sans-serif;color:#35221b;\">" +
    "<div style=\"max-width:460px;margin:60px auto;padding:0 20px;text-align:center;\">" +
    "<div style=\"font-family:Georgia,serif;font-size:26px;font-weight:bold;color:#821e1d;letter-spacing:1px;margin-bottom:22px;\">HONSAMA</div>" +
    "<div style=\"background:#fffdf8;border:1px solid #e8d5b5;border-radius:14px;padding:26px 22px;\">" +
    image +
    "<div style=\"font-size:17px;font-weight:bold;margin-bottom:10px;\">" + title + "</div>" +
    "<div style=\"font-size:14px;line-height:1.55;color:#5a4238;\">" + line + "</div>" +
    (button ? "<a href=\"" + button.href + "\" style=\"" + BTN + "\">" + button.label + "</a>" : "") +
    form +
    (links ? "<div style=\"margin-top:16px;\">" + links + "</div>" : "") +
    "</div></div></body></html>";
}

module.exports = { digestPage, escapeHtml };
