#!/usr/bin/env python3
"""Turn the standalone demo HTML into a hosted, multi-user Supabase build.

It reuses the entire existing UI/logic and only swaps the persistence layer:
  - localStorage  -> Supabase Postgres (orders + stores tables)
  - base64 files  -> Supabase Storage ('labels' bucket)
  - adds a login gate (Supabase Auth)

Run:  python3 make_html3.py && python3 make_app.py
Out:  app/web/index.html  (+ app/web/app-config.js)
"""
import re, pathlib

SRC = pathlib.Path('/mnt/user-data/outputs/Refund_Tracker_Demo.html').read_text()

# ---------------------------------------------------------------- adapter JS
ADAPTER = r"""
<script>
// ============ Hosted persistence adapter (Supabase) ============
const FILE_FIELDS = ['order_confirmation','return_label_pdf','proof_of_postage','delivery_photo','damage_photo','collection_handover','invoice'];
let sb = null;
window.__HOSTED = { orders: [], storeFlags: {}, burndown: [] };
let __orderHashes = {};
const __hash = (o) => JSON.stringify(o);

function __initClient() {
  if (sb) return sb;
  const cfg = window.APP_CONFIG || {};
  if (!cfg.url || !cfg.anonKey || cfg.url.indexOf('YOUR-') === 0) {
    document.getElementById('authMsg').textContent = 'Set your Supabase URL and anon key in app-config.js';
    return null;
  }
  sb = window.supabase.createClient(cfg.url, cfg.anonKey);
  return sb;
}

// ---- AI automations: override the demo's swappable hooks to hit edge functions ----
function __dataUrlParts(dataUrl) {
  const [meta, b64] = String(dataUrl).split(',');
  const mt = (meta.match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
  return { media_type: mt, image_base64: b64 };
}
window.__parseReceiptImpl = async function (file, dataUrl) {
  try {
    const { media_type, image_base64 } = __dataUrlParts(dataUrl);
    const { data, error } = await sb.functions.invoke('parse-receipt', { body: { image_base64, media_type } });
    if (error || !data || !data.fields) return {};
    const f = data.fields, out = { _parse_confidence: {} };
    if (f.tracking_number) out.outbound_tracking = f.tracking_number;
    if (f.courier) out.outbound_courier = f.courier;
    if (f.postage_date) out.postage_date = f.postage_date;
    if (f.posted_from) out.posted_from = f.posted_from;
    return out;
  } catch (e) { return {}; }
};
window.__visionCheckImpl = async function (field, dataUrl) {
  try {
    const { media_type, image_base64 } = __dataUrlParts(dataUrl);
    const kind = field === 'damage_photo' ? 'damage' : 'delivery';
    const { data, error } = await sb.functions.invoke('analyze-photo', { body: { image_base64, media_type, kind } });
    if (error || !data) return { ok: false, label: 'AI check unavailable' };
    if (kind === 'damage') {
      const visible = data.damage_visible === 'yes' || data.damage_visible === true;
      return { ok: visible, label: visible ? 'AI: damage visible' + (data.note ? ' — ' + data.note : '') : 'AI: damage not clearly visible — ask for a clearer shot' };
    }
    const person = data.shows_person === 'yes';
    return { ok: !person, label: person ? 'AI: person visible in photo' : 'AI: no person detected → DNA candidate', showsPersonNo: !person };
  } catch (e) { return { ok: false, label: 'AI check failed' }; }
};

// ---- Auth UI ----
async function __signIn() {
  if (!__initClient()) return;
  const email = document.getElementById('authEmail').value.trim();
  const pass = document.getElementById('authPass').value;
  const msg = document.getElementById('authMsg');
  msg.textContent = 'Signing in…';
  const { error } = await sb.auth.signInWithPassword({ email, password: pass });
  if (error) { msg.textContent = error.message; return; }
  __afterLogin();
}
async function __signUp() {
  if (!__initClient()) return;
  const email = document.getElementById('authEmail').value.trim();
  const pass = document.getElementById('authPass').value;
  const msg = document.getElementById('authMsg');
  msg.textContent = 'Creating account…';
  const { error } = await sb.auth.signUp({ email, password: pass });
  if (error) { msg.textContent = error.message; return; }
  msg.textContent = 'Account created. If email confirmation is on, confirm then sign in.';
}
async function __signOut() { if (sb) { await sb.auth.signOut(); location.reload(); } }

async function __afterLogin() {
  document.getElementById('authOverlay').style.display = 'none';
  const { data } = await sb.auth.getUser();
  const who = document.getElementById('whoami');
  if (who && data && data.user) who.textContent = data.user.email;
  // identity → audit actor, and role → admin/member view
  let role = 'member';
  if (data && data.user) {
    window.__currentActor = data.user.email;
    try {
      const { data: prof } = await sb.from('profiles').select('role').eq('id', data.user.id).maybeSingle();
      if (prof && prof.role) role = prof.role;
    } catch (e) {}
  }
  await hostedFetchAll();
  loadData();
  renderAll();
  window.__roleLocked = (role !== 'admin');   // members can't switch to admin
  applyRole(role);
}

// ---- Data load ----
async function hostedFetchAll() {
  const [{ data: orders }, { data: stores }] = await Promise.all([
    sb.from('orders').select('order_id, data'),
    sb.from('stores').select('*'),
  ]);
  const list = (orders || []).map(r => r.data || {});
  // resolve storage file refs -> signed URLs for display
  for (const o of list) {
    for (const f of FILE_FIELDS) {
      const p = o[f + '_path'];
      if (p) {
        try {
          const { data: signed } = await sb.storage.from('labels').createSignedUrl(p, 3600);
          if (signed) o[f + '_file'] = signed.signedUrl;
        } catch (e) {}
      }
    }
  }
  window.__HOSTED.orders = list;
  __orderHashes = {}; list.forEach(o => __orderHashes[o.order_id] = __hash(o));
  const flags = {};
  (stores || []).forEach(s => {
    flags[s.name] = {
      unwanted: s.unwanted, damaged: s.damaged, collection: s.collection,
      cat: s.cat || [], inbound_courier: s.inbound_courier || '',
      courier: s.return_label_courier || '', revenue: s.revenue,
      contactInfo: s.contact || undefined,
    };
  });
  window.__HOSTED.storeFlags = flags;
  // shared burndown history (app_state row)
  try {
    const { data: st } = await sb.from('app_state').select('value').eq('key', 'burndown').maybeSingle();
    window.__HOSTED.burndown = (st && st.value) ? st.value : [];
  } catch (e) { window.__HOSTED.burndown = []; }
}

let __burndownHash = '';
async function hostedSaveBurndown() {
  if (!sb || !DATA._burndown) return;
  const h = JSON.stringify(DATA._burndown);
  if (h === __burndownHash) return;
  __burndownHash = h;
  try { await sb.from('app_state').upsert({ key: 'burndown', value: DATA._burndown }, { onConflict: 'key' }); } catch (e) {}
}

// ---- Save (dirty-diff upsert + file upload) ----
let __saveTimer = null;
function hostedSave() {
  clearTimeout(__saveTimer);
  const el = document.getElementById('saveStatus');
  if (el) { el.textContent = 'Saving…'; el.className = 'save-status saving'; }
  __saveTimer = setTimeout(async () => {
    try {
      const dirty = (DATA.orders || []).filter(o => __hash(o) !== __orderHashes[o.order_id]);
      for (const o of dirty) {
        await __persistFiles(o);
        const dbCopy = JSON.parse(JSON.stringify(o));
        FILE_FIELDS.forEach(f => { delete dbCopy[f + '_file']; }); // keep only the durable _path
        const { error } = await sb.from('orders').upsert({ order_id: o.order_id, data: dbCopy });
        if (error) throw error;
        __orderHashes[o.order_id] = __hash(o);
        await sb.from('audit_log').insert({ entity: 'order', entity_id: o.order_id, action: 'upsert' });
      }
      if (el) { el.textContent = 'All changes saved'; el.className = 'save-status saved'; }
    } catch (e) {
      if (el) { el.textContent = 'Save failed: ' + (e.message || e); el.className = 'save-status'; }
    }
  }, 300);
}

async function __persistFiles(o) {
  for (const f of FILE_FIELDS) {
    const v = o[f + '_file'];
    if (typeof v === 'string' && v.startsWith('data:')) {
      const [meta, b64] = v.split(',');
      const type = (meta.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
      const ext = type.includes('pdf') ? 'pdf' : (type.split('/')[1] || 'bin');
      const path = o.order_id + '/' + f + '.' + ext;
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const up = await sb.storage.from('labels').upload(path, bytes, { contentType: type, upsert: true });
      if (!up.error) {
        o[f + '_path'] = path;
        await sb.from('files').upsert({ order_id: o.order_id, field: f, storage_path: path, filename: o[f + '_filename'] || (f + '.' + ext), filetype: type, size: bytes.length }, { onConflict: 'id' });
        const { data: signed } = await sb.storage.from('labels').createSignedUrl(path, 3600);
        if (signed) o[f + '_file'] = signed.signedUrl; // display URL; not stored in the order row
      }
    }
  }
}

// ---- Store flags ----
function hostedGetStoreFlags() { return Object.assign({}, STORE_SEED, window.__HOSTED.storeFlags); }
function hostedSetStoreFlags(name, rec) {
  window.__HOSTED.storeFlags[name] = rec;
  if (!sb) return;
  sb.from('stores').upsert({
    name, unwanted: rec.unwanted, damaged: rec.damaged, collection: rec.collection,
    cat: rec.cat || [], inbound_courier: rec.inbound_courier || null,
    return_label_courier: rec.courier || null, revenue: (rec.revenue ?? null),
    contact: rec.contactInfo || null,
  }, { onConflict: 'name' }).then(() => sb.from('audit_log').insert({ entity: 'store', entity_id: name, action: 'upsert' }));
}

async function bootHosted() {
  if (!__initClient()) { document.getElementById('authOverlay').style.display = 'flex'; return; }
  const { data } = await sb.auth.getSession();
  if (data && data.session) { await __afterLogin(); }
  else { document.getElementById('authOverlay').style.display = 'flex'; }
}
document.addEventListener('DOMContentLoaded', bootHosted);
</script>
"""

LOGIN_OVERLAY = r"""
<div id="authOverlay" style="display:none;position:fixed;inset:0;z-index:9999;background:var(--bg,#0f1115);align-items:center;justify-content:center">
  <div style="background:var(--bg-card,#1b1e26);border:1px solid var(--line,#2a2e3a);border-radius:12px;padding:28px;width:340px;max-width:90vw">
    <h2 style="margin:0 0 4px;font-size:18px">Refund Tracker</h2>
    <div style="font-size:13px;color:var(--ink-faded,#8a90a0);margin-bottom:16px">Sign in to your team workspace</div>
    <input id="authEmail" type="email" placeholder="you@teloshouse.com" style="width:100%;margin-bottom:8px;padding:9px 10px;border-radius:8px;border:1px solid var(--line,#2a2e3a);background:var(--bg,#0f1115);color:inherit">
    <input id="authPass" type="password" placeholder="Password" style="width:100%;margin-bottom:12px;padding:9px 10px;border-radius:8px;border:1px solid var(--line,#2a2e3a);background:var(--bg,#0f1115);color:inherit">
    <button onclick="__signIn()" class="primary" style="width:100%;margin-bottom:8px">Sign in</button>
    <button onclick="__signUp()" style="width:100%">Create account</button>
    <div id="authMsg" style="font-size:12px;color:var(--ink-faded,#8a90a0);margin-top:10px;min-height:16px"></div>
  </div>
</div>
"""

# ---------------------------------------------------------------- patches
def patch(src):
    out = src

    # 1) inject supabase client + config + adapter just before </head>
    head_inject = (
        '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>\n'
        '<script src="app-config.js"></script>\n' + ADAPTER + '\n'
    )
    out = out.replace('</head>', head_inject + '</head>', 1)

    # 2) login overlay right after <body>
    out = re.sub(r'(<body[^>]*>)', r'\1\n' + LOGIN_OVERLAY, out, count=1)

    # 3) loadData reads from window.__HOSTED.orders
    out = out.replace(
        "function loadData() {\n"
        "  let saved = null;\n"
        "  try { const raw = localStorage.getItem(STORAGE_KEY); if (raw) saved = JSON.parse(raw); } catch (e) { saved = null; }\n"
        "  DATA = mergeOrdersWithInitial(saved);\n"
        "  normalizeDeliveryDates();\n"
        "  (DATA.orders || []).forEach(o => stampRequiredFields(o));\n"
        "  recordBurndownSnapshot();\n"
        "}",
        "function loadData() {\n"
        "  DATA = { orders: (window.__HOSTED && window.__HOSTED.orders) ? window.__HOSTED.orders : [] };\n"
        "  DATA._burndown = (window.__HOSTED && window.__HOSTED.burndown) ? window.__HOSTED.burndown : [];\n"
        "  normalizeDeliveryDates();\n"
        "  (DATA.orders || []).forEach(o => stampRequiredFields(o));\n"
        "  recordBurndownSnapshot();\n"
        "  hostedSaveBurndown();\n"
        "}")

    # 4) saveData -> hostedSave
    out = re.sub(r"function saveData\(\) \{.*?\n\}", "function saveData() { hostedSave(); }", out, count=1, flags=re.S)

    # 5) store flags -> hosted
    out = out.replace(
        "function getStoreFlags() {\n"
        "  let saved = {};\n"
        "  try { saved = JSON.parse(localStorage.getItem(SFLAGS_KEY) || '{}'); } catch (e) {}\n"
        "  return Object.assign({}, STORE_SEED, saved);\n"
        "}",
        "function getStoreFlags() { return hostedGetStoreFlags(); }")
    out = out.replace(
        "function setStoreFlags(name, rec) {\n"
        "  let saved = {};\n"
        "  try { saved = JSON.parse(localStorage.getItem(SFLAGS_KEY) || '{}'); } catch (e) {}\n"
        "  saved[name] = rec;\n"
        "  try { localStorage.setItem(SFLAGS_KEY, JSON.stringify(saved)); } catch (e) {}\n"
        "}",
        "function setStoreFlags(name, rec) { hostedSetStoreFlags(name, rec); }")

    # 6) startup: don't auto-run; boot handles auth -> load -> render
    out = out.replace("loadData(); renderAll(); applyRole('admin');", "/* hosted boot runs after auth (see bootHosted) */")

    # 7) add a sign-out control + who-am-i next to the save status in the header
    out = out.replace(
        '<span id="saveStatus" class="save-status saved">All changes saved</span>',
        '<span id="whoami" style="font-size:12px;color:var(--ink-faded)"></span>'
        '<span id="saveStatus" class="save-status saved">All changes saved</span>'
        '<button onclick="__signOut()" class="ghost-light">Sign out</button>')

    return out

OUT = patch(SRC)
# Fail loudly if a string-match patch silently missed (demo drifted).
_checks = {
    'hosted loadData': 'window.__HOSTED && window.__HOSTED.orders',
    'hosted saveData': 'function saveData() { hostedSave(); }',
    'hosted getStoreFlags': 'function getStoreFlags() { return hostedGetStoreFlags(); }',
    'hosted setStoreFlags': 'function setStoreFlags(name, rec) { hostedSetStoreFlags(name, rec); }',
    'boot deferred': '/* hosted boot runs after auth',
    'login overlay': 'id="authOverlay"',
    'adapter present': 'async function hostedFetchAll',
    'vision override': 'window.__visionCheckImpl = async function',
    'receipt override': 'window.__parseReceiptImpl = async function',
    'damage_photo file field': "'damage_photo'",
    'role applied on login': 'applyRole(role)',
    'actor set on login': 'window.__currentActor = data.user.email',
}
_missing = [k for k, v in _checks.items() if v not in OUT]
if _missing:
    raise SystemExit('make_app.py: patches did not apply: ' + ', '.join(_missing))
# In hosted mode the data (incl. files) lives in Supabase, so the embedded base64
# in INITIAL_ORDERS is dead weight — strip long data URLs to slim the page.
OUT = re.sub(r'data:[A-Za-z0-9+/=;:,.\-]{800,}', '', OUT)
web = pathlib.Path('/home/claude/refund/app/web')
(web / 'index.html').write_text(OUT)
(web / 'app-config.js').write_text(
    '// Fill these in from Supabase: Project Settings -> API\n'
    'window.APP_CONFIG = {\n'
    '  url: "https://YOUR-PROJECT.supabase.co",\n'
    '  anonKey: "YOUR-PUBLIC-ANON-KEY"\n'
    '};\n')
print('wrote app/web/index.html', len(OUT), 'bytes')
