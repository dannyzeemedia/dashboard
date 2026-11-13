// The account manager's "To AI" box.
//
// This function does NOT call a model. Danny's subscription token is licensed
// for Claude Code and claude.ai only, and raw /v1/messages calls with one are
// measured to 429 on anything above Haiku, so the rewrite runs in GitHub
// Actions under headless `claude -p`. Here we only:
//   1. check the caller may edit this client's report (the database's own
//      predicate, the same one the RLS policies use),
//   2. file the request,
//   3. wake the runner.
// The browser then polls report_ai_requests for the answer.
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const REPO = "dannyzeemedia/weekly-client-reports";
const WORKFLOW = "report-ai-edit.yml";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const auth = req.headers.get("Authorization");
  if (!auth) return json({ error: "not signed in" }, 401);

  let slug = "", reportId = "", instruction = "", current = "", label = "", path = "";
  try {
    const b = await req.json();
    slug = String(b.slug ?? "").trim();
    reportId = String(b.report_id ?? "").trim();
    path = String(b.path ?? "").trim();
    instruction = String(b.instruction ?? "").trim();
    current = String(b.current ?? "");
    label = String(b.label ?? "this section").trim().slice(0, 80);
  } catch { /* validation below */ }

  if (!/^[a-z0-9_-]{2,40}$/.test(slug)) return json({ error: "bad client" }, 400);
  if (!/^[A-Za-z0-9_.-]{3,60}$/.test(reportId)) return json({ error: "bad report id" }, 400);
  if (!/^[A-Za-z0-9_.\[\]-]{1,60}$/.test(path)) return json({ error: "bad section" }, 400);
  if (instruction.length < 2 || instruction.length > 600) {
    return json({ error: "Say what you want changed, in a line or two." }, 400);
  }
  if (current.length > 20000) return json({ error: "that section is too long to rewrite" }, 400);

  const SB_URL = Deno.env.get("SB_URL");
  const SB_ANON = Deno.env.get("SB_ANON");
  const GH = Deno.env.get("GH_TOKEN");

  // request_report_edit() raises if the caller is not a reviewer for this
  // client, so the authorisation check and the insert are the same step and
  // cannot disagree.
  const ins = await fetch(`${SB_URL}/rest/v1/rpc/request_report_edit`, {
    method: "POST",
    headers: { apikey: SB_ANON!, Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      p_slug: slug, p_report_id: reportId, p_path: path,
      p_label: label, p_instruction: instruction, p_current: current,
    }),
  });
  const insText = await ins.text();
  if (!ins.ok) {
    let msg = "could not file that edit";
    try { msg = JSON.parse(insText).message ?? msg; } catch { /* keep default */ }
    return json({ error: msg }, ins.status === 400 ? 400 : 403);
  }
  const requestId = JSON.parse(insText);

  if (!GH) {
    return json({
      id: requestId,
      queued: true,
      warning: "Filed, but the runner could not be woken. It will be picked up on the next run.",
    });
  }
  const disp = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GH}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "report-review",
      },
      body: JSON.stringify({ ref: "main", inputs: { request_id: String(requestId) } }),
    });
  if (!disp.ok) {
    const t = await disp.text();
    return json({
      id: requestId,
      queued: true,
      warning: `Filed, but the runner did not start (${disp.status}). ${t.slice(0, 120)}`,
    });
  }
  return json({ id: requestId, queued: true });
});
