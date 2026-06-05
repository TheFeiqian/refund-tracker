// supabase/functions/sla-reminders/index.ts
// Scheduled sweep: scans all orders, finds ones sitting too long at a stage,
// and writes reminders into the audit_log (and is the place to send email/Slack).
// Schedule it with Supabase cron (see README) e.g. every morning.
//
// Deploy:  supabase functions deploy sla-reminders
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// SLA in days per stage before an order is "overdue" and needs chasing.
// Stage is derived from triggers, mirroring the app's computeStage().
const STAGE_SLA_DAYS: Record<number, number> = { 1: 4, 2: 7, 3: 2, 4: 3, 5: 7, 6: 4, 7: 5, 8: 14 };

function computeStage(o: any): number | "done" {
  const ms = o.manual_stage;
  if (ms === "done") return "done";
  if (ms && +ms >= 1 && +ms <= 8) return +ms;
  const t = o.triggers || {};
  if (t.refunded || t.refund_successful) return "done";
  if (t.refund_unsuccessful) return 7;
  if (t.lit_rts_sent || t.dna_email_sent) return 5;
  if (t.lit_created || t.rts_created) return 4;
  if (t.item_delivered) return 3;
  if (t.item_ordered) return 2;
  return 1;
}

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data: orders, error } = await supabase.from("orders").select("order_id, data, updated_at");
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  const now = Date.now();
  const overdue: any[] = [];
  const notifs: any[] = [];
  const todayKey = new Date().toISOString().slice(0, 10);
  for (const row of orders ?? []) {
    const o = row.data || {};
    const stage = computeStage(o);
    if (stage === "done") continue;
    const sla = STAGE_SLA_DAYS[stage as number] ?? 7;
    const ageDays = (now - new Date(row.updated_at).getTime()) / 86400000;
    if (ageDays > sla) {
      overdue.push({
        entity: "order", entity_id: row.order_id, action: "stage_change",
        detail: { reminder: "overdue", stage, age_days: Math.round(ageDays), sla_days: sla, store: o.store, person: o.person, price: o.price },
      });
      notifs.push({
        order_id: row.order_id, task_code: "stage_" + stage, assignee: o.person || null,
        channel: "in_app", status: "pending",
        detail: `Overdue at stage ${stage} (${Math.round(ageDays)}d, SLA ${sla}d) — ${o.store || ""} £${o.price || 0}`,
      });
    }
  }

  if (overdue.length) await supabase.from("audit_log").insert(overdue);

  // De-dupe notifications: skip ones already written today for the same order+task.
  let inserted = 0;
  if (notifs.length) {
    const sinceMidnight = todayKey + "T00:00:00Z";
    const { data: existing } = await supabase
      .from("notifications").select("order_id, task_code").gte("at", sinceMidnight);
    const seen = new Set((existing ?? []).map((e: any) => e.order_id + "|" + e.task_code));
    const fresh = notifs.filter((n) => !seen.has(n.order_id + "|" + n.task_code));
    if (fresh.length) {
      // Optional Slack digest if a webhook is configured.
      const hook = Deno.env.get("SLACK_WEBHOOK_URL");
      if (hook) {
        try {
          const lines = fresh.map((n) => `• ${n.detail} (assignee: ${n.assignee || "unassigned"})`).join("\n");
          await fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `*Refund Tracker — ${fresh.length} overdue*\n${lines}` }) });
          fresh.forEach((n) => { n.channel = "slack"; n.status = "sent"; });
        } catch (_e) { /* leave as pending/in_app */ }
      }
      await supabase.from("notifications").insert(fresh);
      inserted = fresh.length;
    }
  }
  return new Response(JSON.stringify({ ok: true, overdue_count: overdue.length, notifications_created: inserted }), {
    headers: { "content-type": "application/json" },
  });
});
